#!/usr/bin/env node
/**
 * ④' 生成（note）— 週1本の長文記事の下書きを作る。
 *
 *   node scripts/generate-note.mjs
 *   node scripts/generate-note.mjs --dry-run
 *   node scripts/generate-note.mjs --week 2026-W34
 *
 * note には公式 API が無く、非公式 API を使った自動投稿は利用規約に触れて
 * アカウント停止につながる可能性がある。だからここでは投稿まではやらない。
 * 「本文をクリップボードに入れて、note のエディタを開く」ところまでを
 * 投稿ランチャーが担当し、公開ボタンは人が押す。
 *
 * ── 連載として読まれる形にする ─────────────────────
 *
 * 以前はここで「タイトル・導入・いくつかの節・結び」を1回書かせるだけだった。
 * 出てきたのは2,000字ほどの、機能を並べた文章である。
 * 連載「教室で使えるかもしれないもの作り」の実例は約7,900字で、
 * 見出しの並びが毎回同じで、画面のスクリーンショットが20点ほど入っている。
 * 骨格が毎回同じだから、読み手は必要なところだけ読める。
 *
 * そこで次のようにした。
 *   1. 設計   … タイトル3案と、節ごとの骨子を書かせる
 *   2. 選抜   … 別の指示で立てた「編集者」にタイトルを選ばせる
 *   3. 執筆   … 選んだ骨子に沿って、節ごとに本文を書かせる
 *   4. 検査   … config/note-style.json の基準にかける（lib/note-lint.mjs）
 *   5. 書きなおし … 落ちた節だけを、指摘つきで書きなおさせる
 *
 * 骨格と文体の基準は config/note-style.json にある。
 * 実例が検査を通ることを確かめて決めてある。
 *
 * ⚠️ 教室での出来事を実体験として書かせない。
 *   文章を作っているのは機械で、その日その教室で何が起きたかを知らない。
 *   書けるのは「こうなればいいと思って作った」「〜だと思います」まで。
 *   config/guardrails.json の experiencePatterns が機械で見ている。
 *
 * 出力を Markdown ではなくプレーンテキスト寄りにしているのは、
 * note のエディタが Markdown 記法をそのまま解釈しないためである。
 * 「## 見出し」を貼ると「## 見出し」という文字列がそのまま残ってしまう。
 * 記事として読む用（.md）と、貼り付ける用（plain）の両方を出す。
 */
import fs from 'node:fs';
import { generateJson, requireApiKey } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { fail, failWith, info, loadConfig, loadPolicy, parseArgs, paths, readJson, rel, writeJson, writeText } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, nextWeekDates } from './lib/jst.mjs';
import { lintArticle, unsourcedNumbers, kanjiQuantities } from './lib/note-lint.mjs';
import { loadShots, shotBlock } from './lib/note-shots.mjs';
import { pagesUrlFor } from './lib/urls.mjs';

/** タイトルを何案書かせるか。X と同じく、書く人と選ぶ人を分ける。 */
const TITLE_VARIANTS = 3;

/** 長文なので出力の上限を上げる。既定（8192）だと途中で切れる。 */
const MAX_OUTPUT_TOKENS = 32_768;

/** 書きなおしを試す回数。 */
const MAX_REWRITES = 2;

const PLAN_SCHEMA = {
    type: 'object',
    properties: {
        titles: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'タイトル。連載名と番号は付けない' },
                    why: { type: 'string', description: 'この切り口を選んだ理由。1文' },
                },
                required: ['text', 'why'],
            },
            description: '切り口のはっきり違う案',
        },
        angle: { type: 'string', description: 'この記事全体の切り口を1文で' },
        extraSections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    heading: { type: 'string', description: '絵文字ひとつ + 見出し。例「💡 鉛筆が止まった子を助ける「かんがえるどうぐ」」' },
                    intent: { type: 'string', description: 'この節で何を書くか' },
                },
                required: ['heading', 'intent'],
            },
            description: '決まった見出しに収まらない目玉があるときだけ。要らなければ空配列',
        },
        outline: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '節の id（与えたものをそのまま返す）' },
                    plan: { type: 'string', description: 'その節で書くことの骨子。200字程度' },
                },
                required: ['id', 'plan'],
            },
        },
    },
    required: ['titles', 'angle', 'extraSections', 'outline'],
};

const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        index: { type: 'integer', description: '選んだタイトルの番号（1から）' },
        reason: { type: 'string', description: 'なぜそれを選んだか。1文' },
    },
    required: ['index', 'reason'],
};

const WRITE_SCHEMA = {
    type: 'object',
    properties: {
        sections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '節の id（与えたものをそのまま返す）' },
                    paragraphs: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '段落。1段落200〜400字。段落の中で改行しない',
                    },
                    images: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                file: { type: 'string', description: '使う画面のファイル名（渡した一覧から選ぶ）' },
                                after: { type: 'integer', description: '何段落目のあとに置くか（1から）' },
                                caption: { type: 'string', description: '画像の下に置く短い一行。装飾記号は付けない' },
                            },
                            required: ['file', 'after', 'caption'],
                        },
                        description: '渡した一覧に無いファイル名は書かない。画面が無ければ空配列',
                    },
                },
                required: ['id', 'paragraphs', 'images'],
            },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'note のハッシュタグ。#は付けない' },
    },
    required: ['sections', 'tags'],
};

async function main() {
    const args = parseArgs();
    const { accounts, monetization, guardrails } = loadConfig();
    const style = readJson(paths.config('note-style.json'));

    requireApiKey();

    const weekId = args.week ?? isoWeekId(args['this-week'] ? jstDateString() : nextWeekDates()[0]);

    const profiles = loadProfiles();
    if (profiles.length === 0) fail('data/profiles/ が空です。先に `npm run profiles` を実行してください。');

    // その週の X 投稿で扱うアプリを主題にする。
    // X と note がまったく別のことを言っていると、見ている人にとって流れが途切れる。
    const queue = readJson(paths.data('queue', `${weekId}.json`), null);
    const weekRepos = queue ? [...new Set(queue.posts.map((p) => p.repo))] : [];

    const featured = (weekRepos.length > 0 ? weekRepos : profiles.slice(0, 3).map((p) => p.name))
        .map((name) => profiles.find((p) => p.name === name))
        .filter(Boolean)
        .slice(0, 4);

    if (featured.length === 0) fail('題材になるアプリが見つかりませんでした。');

    // 記事は1つのアプリを軸に書く。決まった見出し（導入手順・使い方のガイド）は
    // 1つのアプリについて書くものなので、軸が無いと成立しない。
    // 他のアプリは関連として触れる。
    const main = featured[0];

    info(`④' note の下書きを作ります（${jstStamp()}）`);
    info(`   対象週: ${weekId}`);
    info(`   主題: ${main.name}${featured.length > 1 ? `（関連: ${featured.slice(1).map((p) => p.name).join(', ')}）` : ''}`);

    const { model, source } = await resolveGeminiModel(accounts);
    info(`   モデル: ${model}（${source}）`);

    // 撮ってある画面。無ければ文字だけの記事になる（止めない）。
    const shots = loadShots(main.name);
    info(`   使える画面: ${shots.length} 点${shots.length === 0 ? '（`npm run shots` で撮れます）' : ''}\n`);

    const policy = loadPolicy();
    const sourceText = describeApps(featured, accounts);

    // ── 1. 設計 ──────────────────────────────────
    const plan = await generateJson({
        model,
        system: buildPlanSystem(policy, style, monetization),
        prompt: buildPlanPrompt({ style, main, featured, sourceText, shots }),
        schema: PLAN_SCHEMA,
        temperature: 1.0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    const titles = (plan.titles ?? []).slice(0, TITLE_VARIANTS).filter((t) => t?.text);
    if (titles.length === 0) fail('タイトルの案が1つも出ませんでした。');

    // ── 2. 編集者に選ばせる ────────────────────────
    const picked = await pickTitle({ model, titles, style, main, policy });
    info(`   タイトル: ${picked.title}`);
    if (picked.reason) info(`   編集者: ${picked.reason}`);

    const extras = (plan.extraSections ?? []).slice(0, style.maxExtraSections ?? 2);
    const sections = sectionsWithExtras(style, extras);
    if (extras.length > 0) info(`   目玉の節: ${extras.map((e) => e.heading).join(' / ')}`);

    // ── 3. 執筆 ──────────────────────────────────
    info('\n   本文を書いています（長いので30秒ほどかかります）…');
    let written = await writeSections({
        model,
        policy,
        style,
        monetization,
        main,
        featured,
        sourceText,
        shots,
        title: picked.title,
        angle: plan.angle ?? '',
        outline: plan.outline ?? [],
        sections,
        notes: null,
    });

    // ── 4. 検査して、落ちた節だけ書きなおさせる ──────────
    let article = { title: picked.title, sections: written.sections, tags: written.tags ?? [] };
    let markdown = renderMarkdown(article, { style, main, featured, accounts, sections });
    let problems = lintArticle({ article, markdown, style, guardrails, monetization });

    for (let attempt = 1; attempt <= MAX_REWRITES && problems.length > 0; attempt += 1) {
        info(`   ⚠ ${problems.length} 件の指摘があります。書きなおさせます（${attempt}/${MAX_REWRITES}）`);
        for (const p of problems.slice(0, 8)) info(`     - ${p}`);

        written = await writeSections({
            model,
            policy,
            style,
            monetization,
            main,
            featured,
            sourceText,
            shots,
            title: picked.title,
            angle: plan.angle ?? '',
            outline: plan.outline ?? [],
            sections,
            notes: problems,
            previous: written.sections,
        });

        article = { title: picked.title, sections: written.sections, tags: written.tags ?? [] };
        markdown = renderMarkdown(article, { style, main, featured, accounts, sections });
        problems = lintArticle({ article, markdown, style, guardrails, monetization });
    }

    // 資料に無い数字は、機械では白黒を付けられない（年号や「三つ」も拾ってしまう）。
    // 落とさずに、確かめてほしいものとして出す。
    const unsourced = unsourcedNumbers(markdown, sourceText);

    // 数量が漢数字のまま（A10）。これも落とさない。書きなおさせる理由に混ぜると、
    // 「十秒」1 つのために節ごと書きかえさせることになる。
    const kanjiNums = kanjiQuantities(markdown, style);

    if (problems.length > 0) {
        info(`\n   ✖ ${problems.length} 件が残りました。下書きは出しますが、出す前に直してください`);
        for (const p of problems) info(`     - ${p}`);
    } else {
        info('\n   ✓ 検査を通りました');
    }
    if (unsourced.length > 0) {
        info(`   ※ 資料に無い数字があります。裏を取ってください: ${unsourced.join(', ')}`);
    }
    if (kanjiNums.length > 0) {
        info(`   ※ 数量が漢数字で書かれています。横書きなので算用数字にしてください: ${kanjiNums.join(', ')}`);
    }

    const plain = renderPlainText(article, { style, main, featured, accounts, sections, monetization });

    if (args['dry-run']) {
        info('\n──── 生成結果（--dry-run なので保存しません）────\n');
        info(markdown);
        return;
    }

    const jsonPath = paths.data('note', `${weekId}.json`);
    const mdPath = paths.data('note', `${weekId}.md`);

    writeJson(jsonPath, {
        weekId,
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        title: picked.title,
        titleReason: picked.reason ?? null,
        alternatives: titles.filter((t) => t.text !== picked.title).map((t) => t.text),
        tags: article.tags,
        featured: featured.map((p) => p.name),
        mainRepo: main.name,
        // plain がランチャーからクリップボードに入る本文の正体。
        plain,
        charCount: plain.length,
        images: shotsUsedIn(article),
        problems,
        unsourcedNumbers: unsourced,
        kanjiQuantities: kanjiNums,
    });
    writeText(mdPath, markdown);

    info(`\n④' 完了 — ${rel(jsonPath)}（${plain.length}字 / 画面 ${shotsUsedIn(article).length} 点）`);
    info(`   読む用: ${rel(mdPath)}`);
}

/* ────────────────────────────────────────────
 *  プロンプト
 * ──────────────────────────────────────────── */

/** 文体の厳守ルールを、そのままプロンプトに入れられる形にする。 */
function styleRules(style) {
    const f = style.forbidden ?? {};
    const lines = ['## 文体の決まり（ここは崩さない）'];

    if (f.bold) lines.push('- 太字（**）を使わない。装飾ではなく文章の力で強調する');
    if (f.table) lines.push('- 表を使わない。note では表示されないので、そもそも意味がない');
    if (f.symbols?.length) lines.push(`- 次の記号を使わない: ${f.symbols.join(' ')}。記号でつながず、文章にする`);
    if (f.listOutsideGuide) lines.push('- 箇条書きは手順の節だけ。それ以外は文章で書く。並べれば伝わるわけではない');
    if (f.emojiInBody) lines.push('- 絵文字は見出しだけ。本文には入れない');
    if (f.openers?.length) lines.push(`- 定型の前置きを書かない: ${f.openers.join(' / ')}`);
    if (f.abstract?.length) lines.push(`- 抽象語を避ける: ${f.abstract.join(' / ')}。何がどう変わるかで書く`);
    if (f.jargon?.length) {
        lines.push(
            '- 専門用語を日常の言葉に置きかえる:',
            ...f.jargon
                .filter(([, to]) => to)
                .map(([from, to]) => `    ${from} は使わず「${to}」のように書く`),
            `    ${f.jargon.filter(([, to]) => !to).map(([from]) => from).join(' / ')} は出さない`
        );
    }

    const naming = style.naming ?? {};
    lines.push(
        `- 子どものことは「${naming.children ?? '子どもたち'}」と呼ぶ（${(naming.avoidForChildren ?? []).join('・')}は硬いので使わない）`,
        `- 読み手は「${naming.reader ?? '先生'}」。${naming.form ?? 'です・ます'}調`,
        '',
        '## 書いてはいけないこと',
        '- 教室での出来事を、実際に見たこととして書かない。',
        '  あなたはその教室で何が起きたかを知りません。「うちのクラスでは子どもたちが喜んでいました」と',
        '  書けば、それは書き手の名前で出る嘘になります。',
        '  書いてよいのは「こうなればいいと思って作りました」「〜だと思います」までです。',
        '  困りごとは、一般に起きることとして書いてください（「計算練習の時間、手が止まる子がいます」）。',
        '- 効果を言い切らない。「いちばん盛り上がる時間になる」ではなく「〜だと思います」',
        '- 渡した資料に書かれていない数字を書かない。数えられないものは書かない'
    );

    return lines.join('\n');
}

function buildPlanSystem(policy, style, monetization) {
    return [
        `あなたは日本の小学校教員です。連載「${style.series}」に載せる、自作アプリの紹介記事を設計します。`,
        '',
        policy,
        '',
        '作者本人が書きます。だから「作った理由」「あえてそうしなかったこと」を書けます。',
        'そこがこの連載の強みなので、機能の説明で終わらせず、なぜその作りにしたのかを添えてください。',
        '',
        styleRules(style),
        monetization?.enabled ? '' : '- 有料記事への誘導、アフィリエイト、支援のお願いを書かない',
    ].join('\n');
}

function buildPlanPrompt({ style, main, featured, sourceText, shots }) {
    const sections = style.sections.filter((s) => !s.generated);
    return [
        `次のアプリについて、記事の設計をしてください。主題は ${main.name} です。`,
        featured.length > 1 ? `${featured.slice(1).map((p) => p.name).join('、')} は関連として触れる程度にしてください。` : '',
        '',
        '## タイトル',
        `型: ${style.titleShape}`,
        '例:',
        ...(style.titleExamples ?? []).map((t) => `  ${t}`),
        `切り口のはっきり違う案を ${TITLE_VARIANTS} つ書いてください。連載名と番号は付けないでください。`,
        '',
        '## 節ごとの骨子',
        '次の見出しは固定です。それぞれで何を書くかを200字程度でまとめてください。',
        ...sections.map((s) => `- ${s.id}（${s.heading}）: ${s.intent}`),
        '',
        `そのアプリの目玉が上の見出しに収まらないときだけ、「${sections[1]?.heading}」と「${sections[2]?.heading}」のあいだに`,
        `最大 ${style.maxExtraSections ?? 2} 本まで見出しを足せます。要らなければ空配列にしてください。`,
        '',
        '## 材料',
        sourceText,
        shots.length > 0 ? `\n## 撮ってある画面\n${shotBlock(shots)}` : '',
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * タイトルを選ぶ。
 *
 * 書いた本人に選ばせない。同じ指示で書いたものを同じ指示で見ると、
 * 「指示に従っているか」しか見えなくなり、読まれるかどうかを見なくなる。
 * X の生成（generate-week.mjs の pickBest）とまったく同じ考え方である。
 */
async function pickTitle({ model, titles, style, main, policy }) {
    if (titles.length === 1) return { title: titles[0].text, reason: null };

    const system = [
        'あなたは、教員向けメディアの編集者です。',
        'note の記事のタイトル案を読んで、どれがいちばん読まれるかを選びます。書いた本人ではありません。',
        '',
        '## 選ぶ観点（上から重い順）',
        '1. 読み手（忙しい小学校の先生）が、自分の困りごとだと分かるか',
        '2. そのアプリならではの持ち味が入っているか',
        '3. 煽っていないか（「知らないと損」「誰でもできる」のような案は落とす）',
        '4. 長すぎないか（50字まで）',
        '',
        '## 書き手が守っている方針（参考）',
        policy,
    ].join('\n');

    const prompt = [
        `アプリ: ${main.name} — ${main.oneLine ?? ''}`,
        `タイトルの型: ${style.titleShape}`,
        '',
        '案:',
        ...titles.map((t, i) => `${i + 1}. ${t.text}\n   （書き手の意図: ${t.why ?? ''}）`),
        '',
        'いちばん読まれる案を1つ選び、理由を1文で書いてください。',
    ].join('\n');

    try {
        const result = await generateJson({ model, system, prompt, schema: JUDGE_SCHEMA, temperature: 0.2 });
        const hit = titles[(result.index ?? 1) - 1];
        if (hit) return { title: hit.text, reason: result.reason ?? null };
    } catch (error) {
        // 選べなくても記事は書ける。1案目を使って先へ進む。
        console.error(`⚠ タイトルを選べませんでした。1案目を使います: ${String(error.message).replace(/\s+/g, ' ').trim()}`);
    }
    return { title: titles[0].text, reason: null };
}

/** 固定の節に、目玉の節を差しこんだ並びを作る。 */
function sectionsWithExtras(style, extras) {
    const base = style.sections.filter((s) => !s.generated);
    if (extras.length === 0) return base;

    // 「📱 このアプリでできること」の直後に入れる。
    const at = base.findIndex((s) => s.id === 'features');
    const insertAt = at === -1 ? 1 : at + 1;
    const made = extras.map((e, i) => ({
        id: `extra${i + 1}`,
        heading: e.heading,
        intent: e.intent,
        chars: [800, 1600],
    }));
    return [...base.slice(0, insertAt), ...made, ...base.slice(insertAt)];
}

async function writeSections({
    model,
    policy,
    style,
    monetization,
    main,
    featured,
    sourceText,
    shots,
    title,
    angle,
    outline,
    sections,
    notes,
    previous = null,
}) {
    const planById = new Map((outline ?? []).map((o) => [o.id, o.plan]));

    const system = [
        `あなたは日本の小学校教員です。連載「${style.series}」の記事の本文を書きます。`,
        '',
        policy,
        '',
        styleRules(style),
        monetization?.enabled ? '' : '- 有料記事への誘導、アフィリエイト、支援のお願いを書かない',
        '',
        '## 書き方',
        '- 1段落は200〜400字。段落の中で改行しない',
        '- 見出しは書かない（機械が付ける）。段落の本文だけを返す',
        `- 記事全体で ${style.charRange[0]}〜${style.charRange[1]} 字にする。各節の目安の字数を守れば、その範囲に収まる`,
    ]
        .filter(Boolean)
        .join('\n');

    const prompt = [
        `タイトル: ${title}`,
        angle ? `この記事の切り口: ${angle}` : '',
        '',
        '## 節ごとに書くこと',
        ...sections.map((s) => {
            const [lo, hi] = s.chars ?? [600, 1200];
            const lines = [
                `### ${s.id}（見出しは「${s.heading}」）`,
                `狙い: ${s.intent}`,
                `字数: ${lo}〜${hi} 字`,
            ];
            if (planById.has(s.id)) lines.push(`骨子: ${planById.get(s.id)}`);
            if (s.allowList) lines.push('この節だけは番号つきの手順で書いてかまいません。迷いようがない粒度にしてください。');
            if (s.id === 'merits') lines.push('「三つのいいことが期待できます。」で始め、「一つ目は、〜ことです。」と続けてください。');
            if (s.id === 'closing') lines.push(`最後は次の一文で終えてください: ${style.closingLine}`);
            if (previous) {
                const before = previous.find((p) => p.id === s.id);
                if (before) lines.push(`前回書いた本文:\n${(before.paragraphs ?? []).join('\n')}`);
            }
            return lines.join('\n');
        }),
        '',
        shots.length > 0
            ? [
                  '## 使える画面',
                  '次の画面を本文に差しこめます。file はここにあるものだけを使ってください。',
                  shotBlock(shots),
                  `キャプションは ${style.captionMaxChars} 字以内。装飾記号は付けないでください。`,
              ].join('\n')
            : '## 画面\n撮ってある画面がありません。images はすべて空配列にしてください。',
        '',
        '## 材料（ここに書かれていることだけを根拠にする）',
        sourceText,
        '',
        `## ハッシュタグ\n${style.hashtagRange[0]}〜${style.hashtagRange[1]} 個。#は付けないでください。`,
        notes
            ? `\n⚠ 前回の原稿は次の理由で使えませんでした。直してください:\n${notes.map((n) => `  - ${n}`).join('\n')}`
            : '',
    ]
        .filter(Boolean)
        .join('\n');

    return generateJson({
        model,
        system,
        prompt,
        schema: WRITE_SCHEMA,
        temperature: 0.95,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
}

/** プロフィールを、そのままプロンプトに入れられる材料にする。 */
function describeApps(featured, accounts) {
    return featured
        .map((p) =>
            [
                `### ${p.name}`,
                `公開URL: ${p.pagesUrl ?? pagesUrlFor(p.name, accounts)}`,
                `一言: ${p.oneLine}`,
                `対象: ${p.targetGrade} / ${p.subject}`,
                `引き受ける困りごと: ${(p.painPoints ?? []).join(' / ')}`,
                `使い方: ${(p.howToUse ?? []).join(' → ')}`,
                `こだわり: ${(p.strengths ?? []).join(' / ')}`,
                `使う場面: ${(p.classroomScenes ?? []).join(' / ')}`,
                p.designDecisions?.length ? `設計判断: ${p.designDecisions.join(' / ')}` : null,
            ]
                .filter(Boolean)
                .join('\n')
        )
        .join('\n\n');
}

/* ────────────────────────────────────────────
 *  組み立て
 * ──────────────────────────────────────────── */

/** 記事で実際に使った画面のファイル名。 */
function shotsUsedIn(article) {
    return (article.sections ?? []).flatMap((s) => (s.images ?? []).map((i) => i.file));
}

/** 節の本文に、画像を段落のあいだへ差しこむ。 */
function paragraphsWithImages(section, { imagePrefix = 'images/' } = {}) {
    const paragraphs = (section.paragraphs ?? []).map((p) => String(p ?? '').trim()).filter(Boolean);
    const images = [...(section.images ?? [])].sort((a, b) => (a.after ?? 0) - (b.after ?? 0));
    const out = [];

    for (const [i, paragraph] of paragraphs.entries()) {
        out.push(paragraph);
        for (const image of images.filter((im) => (im.after ?? 1) === i + 1)) {
            out.push(`![${image.caption ?? ''}](${imagePrefix}${image.file})`, image.caption ?? '');
        }
    }
    // 段落の数を超える after を指定されたぶんは、最後に置く
    for (const image of images.filter((im) => (im.after ?? 1) > paragraphs.length)) {
        out.push(`![${image.caption ?? ''}](${imagePrefix}${image.file})`, image.caption ?? '');
    }
    return out.filter(Boolean);
}

/** リポジトリの中で読むための Markdown。検査もこれに当てる。 */
function renderMarkdown(article, { style, main, featured, accounts, sections }) {
    const number = style.seriesNumber ? `#${style.seriesNumber}` : '#◯';
    const parts = [`# ${style.series} ${number} ${article.title}`, ''];

    const byId = new Map((article.sections ?? []).map((s) => [s.id, s]));

    for (const spec of sections) {
        const section = byId.get(spec.id);
        if (!section) continue;
        parts.push(`## ${spec.heading}`, '');
        for (const block of paragraphsWithImages(section)) parts.push(block, '');

        // 導入の節の最後に URL を置く。実例がそうしている。
        if (spec.id === 'intro') {
            parts.push(main.pagesUrl ?? pagesUrlFor(main.name, accounts), '');
        }
    }

    // 関連として触れたアプリのリンクを、まとめの直前に置く。
    const related = featured.slice(1).filter((p) => p.pagesUrl);
    if (related.length > 0) {
        parts.push('この記事で触れたほかのアプリです。', '');
        for (const p of related) parts.push(`${p.name}（${p.oneLine}）`, p.pagesUrl, '');
    }

    parts.push(`## ${style.sections.find((s) => s.generated)?.heading ?? '🏷 ハッシュタグ'}`, '');
    parts.push((article.tags ?? []).map((t) => `#${String(t).replace(/^#/, '')}`).join(' '), '');

    return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * note のエディタに貼り付ける本文。
 *
 * 見出しは装飾記号（##）を付けず、前後に空行を置いて視覚的に区切る。
 * note 側で見出しにしたいときは、貼り付けた後にその行を選んで見出しにできる。
 * 画像は手で上げてもらうので、どこに入れるかだけを一行で示す。
 */
function renderPlainText(article, { style, main, featured, accounts, sections, monetization }) {
    const number = style.seriesNumber ? `#${style.seriesNumber}` : '#◯';
    const parts = [`${style.series} ${number} ${article.title}`, ''];
    const byId = new Map((article.sections ?? []).map((s) => [s.id, s]));

    for (const spec of sections) {
        const section = byId.get(spec.id);
        if (!section) continue;
        // 絵文字は見出しの目印なので残す。note で見出しにするときの手がかりになる。
        parts.push(spec.heading, '');
        for (const block of paragraphsWithImages(section)) {
            // 画像の記法は貼り付け先で意味を持たない。「ここに入れる」と書く。
            const image = /^!\[[^\]]*\]\(([^)]*)\)$/.exec(block);
            parts.push(image ? `［画像: ${image[1].split('/').pop()}］` : block, '');
        }
        if (spec.id === 'intro') parts.push(main.pagesUrl ?? pagesUrlFor(main.name, accounts), '');
    }

    const related = featured.slice(1).filter((p) => p.pagesUrl);
    if (related.length > 0) {
        parts.push('この記事で触れたほかのアプリです。', '');
        for (const p of related) parts.push(`${p.name}（${p.oneLine}）`, p.pagesUrl, '');
    }

    if (monetization?.enabled && monetization.links?.membership) parts.push(monetization.links.membership, '');

    parts.push((article.tags ?? []).map((t) => `#${String(t).replace(/^#/, '')}`).join(' '));

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function loadProfiles() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(paths.data('profiles', f)));
}

export { paragraphsWithImages, renderMarkdown, renderPlainText, sectionsWithExtras };

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(failWith);
}
