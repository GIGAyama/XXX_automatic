#!/usr/bin/env node
/**
 * ④ 生成 — 翌週1週間分の X 投稿文を作る。
 *
 *   node scripts/generate-week.mjs
 *   node scripts/generate-week.mjs --dry-run      … 書き出さず画面に出すだけ
 *   node scripts/generate-week.mjs --this-week    … 翌週ではなく今週分（初回の動作確認用）
 *   node scripts/generate-week.mjs --week 2026-W34
 *
 * 流れ:
 *   1. 「どの日にどのアプリをどの型で」を機械で割り当てる（lib/plan-week.mjs）
 *   2. 1枠につき複数の案をまとめて書かせる
 *   3. 別の指示で立てた「編集者」に採点させて、枠ごとに1つ選ぶ
 *   4. ガードレール検査（lib/lint.mjs）に落ちたものだけ、指摘つきで書きなおさせる
 *   5. data/queue/<週ID>.json に書く
 *
 * まとめて投げているのは、無料枠のリクエスト数を節約するためと、
 * 1週間を通した重複（同じ言い回しが何度も出る）を AI 自身に避けさせるためである。
 *
 * なぜ複数案を書かせて選ぶのか:
 *   1回で書いたものをそのまま出すと、当たりさわりのない平均的な文章になる。
 *   書く人と選ぶ人を分けるのは、人がやっている編集作業と同じことである。
 *   選ぶ観点（最初の1行で止まるか、具体があるか、宣伝に見えないか）は
 *   config/audience.json に書いてある。
 *
 * ⚠️ 本文に URL を入れない。
 *   X は本文に外部リンクがある投稿のリーチを大きく下げる。
 *   リンクは「自分への最初の返信」に置く（config/guardrails.json の urlPlacement）。
 */
import fs from 'node:fs';
import { generateJson, requireApiKey } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { fail, failWith, info, loadConfig, loadPolicy, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, nextWeekDates, weekDatesOf, weekDatesOfIsoWeek } from './lib/jst.mjs';
import { lintPost } from './lib/lint.mjs';
import { planWeek } from './lib/plan-week.mjs';
import { composeSteps, hookOf, seedFrom } from './lib/x-text.mjs';
import { seasonBriefOf, weekdayNoteOf } from './lib/season.mjs';

/** 1枠あたり何案書かせるか。多いほど良いものが混ざるが、無料枠のトークンを使う。 */
const VARIANTS_PER_SLOT = 3;

const DRAFT_SCHEMA = {
    type: 'object',
    properties: {
        posts: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '与えられた枠の id をそのまま返す' },
                    variant: { type: 'integer', description: '同じ枠の中での案の番号（1から）' },
                    hook: { type: 'string', description: '使ったフックの型の id（config/audience.json の hooks）' },
                    body: {
                        type: 'string',
                        description:
                            '投稿の本文。URL とハッシュタグは含めない（あとで機械が付ける）。日本語で100〜120字程度。最初の1行がタイムラインで最初に見える部分になる',
                    },
                    thread: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            '本文だけでは入り切らないときの、つづきの投稿。要らなければ空配列。1コマ100字程度、多くても2コマまで',
                    },
                    hashtags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'ハッシュタグ。#は付けない。2〜3個',
                    },
                },
                required: ['id', 'variant', 'hook', 'body', 'thread', 'hashtags'],
            },
        },
    },
    required: ['posts'],
};

/** 編集者が返す採点表。 */
const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        picks: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '枠の id' },
                    variant: { type: 'integer', description: '選んだ案の番号' },
                    score: { type: 'integer', description: '選んだ案の総合点（0〜100）' },
                    reason: { type: 'string', description: 'なぜそれを選んだか。1文' },
                },
                required: ['id', 'variant', 'score', 'reason'],
            },
        },
    },
    required: ['picks'],
};

async function main() {
    const args = parseArgs();
    const config = loadConfig();
    const { accounts, slots: slotConfig, themes, guardrails, monetization } = config;

    // 材料を読み込む前に確かめる。キーが無いのに割り当てまで進むと、
    // 本当の原因が「生成に失敗した」という別の顔で出てくる。
    requireApiKey();

    // ── 対象の週を決める ──────────────────────────────
    let dates;
    if (args.week) {
        // 週IDを指定されたら、その週の月曜からの7日分を作る
        const match = /^(\d{4})-W(\d{2})$/.exec(args.week);
        if (!match) fail("--week は 'YYYY-Www' 形式で渡してください（例: 2026-W34）");
        dates = weekDatesOfIsoWeek(Number(match[1]), Number(match[2]));
    } else if (args['this-week']) {
        dates = weekDatesOf(jstDateString());
    } else {
        dates = nextWeekDates();
    }
    const weekId = isoWeekId(dates[0]);

    // ── 材料を読む ────────────────────────────────
    const profiles = loadProfiles();
    if (profiles.length === 0) fail('data/profiles/ が空です。先に `npm run profiles` を実行してください。');

    // 履歴は archive-history.mjs が、反応は collect-feedback.mjs が書く。
    // どちらも無くても生成はできる（初回がそう）。無いことと壊れていることは区別する。
    const history = readJson(paths.data('history.json'), { posts: [] }).posts ?? [];
    const feedbackFile = readJson(paths.data('feedback.json'), { themes: {}, repos: {} });
    const feedback = feedbackFile.themes ?? {};
    const repoFeedback = feedbackFile.repos ?? {};

    info(`④ 生成を開始します（${jstStamp()}）`);
    info(`   対象週: ${weekId}（${dates[0]} 〜 ${dates[6]}）`);
    info(`   使えるアプリ: ${profiles.length} 件 / 1日 ${slotConfig.slots.length} 枠`);

    // ── 1. 割り当て ────────────────────────────────
    const plan = planWeek({
        dates,
        slots: slotConfig.slots,
        themesConfig: themes,
        profiles,
        history,
        feedback,
        repoFeedback,
        weekId,
    });
    info(`   ${plan.length} 枠を割り当てました`);
    info(
        `   履歴 ${history.length} 件 / 反応の記録 ${Object.keys(feedback).length} 型` +
            (history.length === 0 ? '（履歴が空です。週をまたいだ重複回避はまだ効きません）' : '') +
            '\n'
    );

    // ── 2. 本文を作らせる ──────────────────────────────
    const profileByName = new Map(profiles.map((p) => [p.name, p]));
    const policy = loadPolicy();
    const { model, source } = await resolveGeminiModel(accounts);
    info(`   モデル: ${model}（${source}）`);

    // 「いまの時期」と「いまの話題」。どちらも無くても生成はできる。
    const audience = readJson(paths.config('audience.json'), null);
    const calendar = readJson(paths.config('calendar.json'), { periods: [] });
    const trends = readJson(paths.data('trends', `${weekId}.json`), null);
    const season = seasonBriefOf(dates, calendar);
    info(`   時期: ${season ? season.split('\n')[0].replace(/^- /, '') : '（行事暦なし）'}`);
    info(`   いまの話題: ${trends ? `${trends.topics.length} 件` : 'なし（行事暦だけで書きます）'}\n`);

    const context = { audience, calendar, season, trends };

    let drafts = await askForDrafts({
        model,
        policy,
        plan,
        profileByName,
        monetization,
        guardrails,
        context,
        note: null,
        variants: VARIANTS_PER_SLOT,
    });

    // ── 2'. 編集者に選ばせる ────────────────────────────
    // 書く人と選ぶ人を分ける。1回で書いたものをそのまま出すと、
    // 当たりさわりのない平均的な文章になる。
    drafts = await pickBest({ model, drafts, plan, profileByName, context, policy, guardrails });

    // ── 3. 検査して、落ちたものだけ書きなおさせる ──────────────
    let posts = assemble(plan, drafts, profileByName, accounts, guardrails);
    let issues = posts.flatMap((post) => lintPost(post, guardrails, monetization).map((m) => ({ id: post.id, m })));

    for (let attempt = 1; attempt <= 2 && issues.length > 0; attempt += 1) {
        info(`   ⚠ ${issues.length} 件が検査に引っかかりました。書きなおさせます（${attempt}/2）`);
        for (const { id, m } of issues) info(`     - ${id}: ${m}`);

        const badIds = new Set(issues.map((i) => i.id));
        const retryPlan = plan.filter((p) => badIds.has(p.id));
        const notes = issues.reduce((acc, { id, m }) => {
            acc[id] = [...(acc[id] ?? []), m];
            return acc;
        }, {});

        // 書きなおしは1案だけにする。ここで多案を作っても、直す指示が具体的なので差が出ない。
        const retried = await askForDrafts({
            model,
            policy,
            plan: retryPlan,
            profileByName,
            monetization,
            guardrails,
            context,
            note: notes,
            variants: 1,
        });

        drafts = [...drafts.filter((d) => !badIds.has(d.id)), ...retried];
        posts = assemble(plan, drafts, profileByName, accounts, guardrails);
        issues = posts.flatMap((post) => lintPost(post, guardrails, monetization).map((m) => ({ id: post.id, m })));
    }

    if (issues.length > 0) {
        // 直しきれなかったものは投稿候補から外す。危ないものを出すより、その枠を空けるほうがよい。
        const badIds = new Set(issues.map((i) => i.id));
        info(`   ✖ ${badIds.size} 枠は検査を通らなかったので除外します`);
        posts = posts.filter((p) => !badIds.has(p.id));
    }

    // ── 4. 書き出す ────────────────────────────────
    if (args['dry-run']) {
        info('\n──── 生成結果（--dry-run なので保存しません）────\n');
        for (const post of posts) {
            info(`■ ${post.date}(${post.weekday}) ${post.slotLabel} / ${post.themeLabel} / ${post.repo}`);
            if (post.pickReason) info(`   編集者: ${post.pickReason}`);
            for (const step of post.steps) {
                info(`  ── ${step.label} [${step.weightedLength ?? '?'}/280]`);
                info(step.text.split('\n').map((l) => `    ${l}`).join('\n'));
            }
            info('');
        }
        return;
    }

    const outPath = paths.data('queue', `${weekId}.json`);
    writeJson(outPath, {
        weekId,
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        dates,
        posts,
    });

    info(`\n④ 完了 — ${rel(outPath)} に ${posts.length} 件`);

    // ── 5. 予備の引き出しを作る ──────────────────────────
    // 予定に無い投稿を「いま出したい」ことがある。
    // ブラウザから Gemini を呼ぶには API キーを画面に置くことになり、それはできない
    // （CLAUDE.md §2）。だから、この場で作り置きしておく。
    const stock = await buildStock({
        model,
        policy,
        plan,
        profiles,
        profileByName,
        accounts,
        guardrails,
        monetization,
        context,
        weekId,
    });
    if (stock.length > 0) {
        const stockPath = paths.data('stock.json');
        writeJson(stockPath, { generatedAt: new Date().toISOString(), generatedAtJst: jstStamp(), weekId, posts: stock });
        info(`   予備の引き出し: ${rel(stockPath)} に ${stock.length} 件`);
    }

    info('   次は `npm run build` でランチャー用のデータを作ります');
}

/** 読者像を、そのままプロンプトに入れられる形にする。 */
function audienceBlock(audience) {
    if (!audience) return '';
    const p = audience.primary ?? {};
    return [
        '## 誰に向けて書くか',
        `読者: ${p.who ?? ''}`,
        `その人のいま: ${p.situation ?? ''}`,
        `求めているもの: ${(p.wants ?? []).join(' / ')}`,
        `読むのをやめる理由: ${(p.hates ?? []).join(' / ')}`,
        `使う言葉: ${p.vocabulary ?? ''}`,
        '',
        '「同じ学年を持っている、隣のクラスの先生ひとり」に話しかけるつもりで書いてください。',
        '大勢に向けた呼びかけにすると、誰の関心も引きません。',
    ].join('\n');
}

/** フックの型を、選べる引き出しとして渡す。 */
function hookBlock(audience) {
    if (!audience?.hooks?.length) return '';
    return [
        '## 最初の1行（フック）の型',
        'タイムラインで最初に見えるのは1行目だけです。ここで止まらなければ本文は読まれません。',
        '次のどれかの型を選んで、その id を hook に書いてください。案ごとに違う型を使ってください。',
        ...audience.hooks.map((h) => `- ${h.id}: ${h.how}\n  例) ${h.example}`),
        '',
        '次の書き出しは使わないでください（どれも読み飛ばされます）:',
        ...(audience.avoid ?? []).map((a) => `- ${a}`),
    ].join('\n');
}

/** いまの時期と話題。 */
function nowBlock({ season, trends }) {
    const lines = [];
    if (season) {
        lines.push('## いまの学校', season, '');
        lines.push('この時期に現場が抱えている困りごとに寄せてください。時期の外れた話は読まれません。', '');
    }
    if (trends?.topics?.length) {
        lines.push('## いま話題になっていること');
        if (trends.summary) lines.push(trends.summary, '');
        for (const t of trends.topics) lines.push(`- ${t.title}: ${t.why}（切り口: ${t.angle}）`);
        lines.push(
            '',
            '⚠ これは題材を選ぶための材料です。ニュースの解説を書く場所ではありません。',
            '   話題そのものを主題にせず、「その話題で気になっている人が、自分の教室で使えること」を書いてください。',
            '   公的機関の見解であるかのような書き方はしないでください。'
        );
    }
    return lines.join('\n');
}

/** Gemini に本文を書かせる。variants を増やすと、1枠につき複数の案を書く。 */
async function askForDrafts({ model, policy, plan, profileByName, monetization, guardrails, context, note, variants = 1 }) {
    if (plan.length === 0) return [];

    const placement = guardrails?.urlPlacement ?? 'reply';
    const hookMax = guardrails?.hookMaxChars ?? 42;

    const system = `あなたは日本の小学校教員です。自分が作った学習アプリについて X（旧Twitter）に投稿する文章を書きます。

${policy}

${audienceBlock(context.audience)}

${hookBlock(context.audience)}

【この作業での約束】
- 本文だけを書いてください。ハッシュタグは本文に含めないでください（機械が後で付けます）。
${
    placement === 'reply'
        ? `- 本文に URL を絶対に入れないでください。X は本文に外部リンクがある投稿をほとんど表示しません。
  リンクは機械が「自分への最初の返信」として別に付けます。本文はリンク無しで完結させてください。
  「詳しくはリンクから」のような、リンクの存在を前提にした書き方もしないでください。`
        : '- URL は本文に含めないでください（機械が後で付けます）。'
}
- 本文は日本語で100〜120字程度。X の上限は日本語140字で、ハッシュタグの分を空けておく必要があります。
- 最初の1行は${hookMax}字以内にしてください。ここだけがタイムラインで最初に見えます。
- 具体を1つ必ず入れてください。「使いやすい」ではなく「配って説明するまで2分」のように、時間・回数・場面で書いてください。
- 与えられた「アプリのプロフィール」に書かれていることだけを根拠にしてください。書かれていない機能や効果を創作しないでください。
- 本文だけで言い切れないときだけ thread につづきを書いてください。要らなければ空配列にしてください。数を増やすためのぶつ切りは禁止です。
- 1週間分をまとめて書きます。同じ言い回し・同じ書き出しを繰り返さないでください。
${monetization?.enabled ? '' : '- 収益化の導線（有料記事・アフィリエイト・支援のお願いなど）は一切書かないでください。'}`;

    const blocks = plan.map((slot) => {
        const profile = profileByName.get(slot.repo);
        const lines = [
            `### 枠 id: ${slot.id}`,
            `日付: ${slot.date}（${slot.weekday}曜）${slot.slotLabel}`,
            context.calendar ? `この曜日の読まれ方: ${weekdayNoteOf(slot.date, context.calendar)}` : null,
            `投稿の型: ${slot.themeLabel}`,
            `この型の狙い: ${slot.themeIntent}`,
            `構成の目安: ${slot.themeStructure}`,
            '',
            `対象アプリ: ${slot.repo}`,
            `　一言: ${profile?.oneLine ?? ''}`,
            `　対象: ${profile?.targetGrade ?? ''} / ${profile?.subject ?? ''}`,
            `　引き受ける困りごと: ${(profile?.painPoints ?? []).join(' / ')}`,
            `　使い方: ${(profile?.howToUse ?? []).join(' → ')}`,
            `　こだわり: ${(profile?.strengths ?? []).join(' / ')}`,
            `　使う場面: ${(profile?.classroomScenes ?? []).join(' / ')}`,
            profile?.designDecisions?.length ? `　設計判断: ${profile.designDecisions.join(' / ')}` : null,
            `　ハッシュタグ候補: ${(profile?.keywords ?? []).join(', ')}`,
            note?.[slot.id] ? `\n⚠ 前回の文章は次の理由で使えませんでした。直してください:\n　- ${note[slot.id].join('\n　- ')}` : null,
        ];
        return lines.filter((l) => l !== null).join('\n');
    });

    const prompt = [
        nowBlock(context),
        '',
        variants > 1
            ? `次の ${plan.length} 件の枠それぞれについて、**${variants} 通りの案**を書いてください（合計 ${plan.length * variants} 件）。
案どうしは、切り口・フックの型・書き出しをはっきり変えてください。同じ話を言い換えただけの案は要りません。
variant には 1 から ${variants} までの番号を入れてください。`
            : `次の ${plan.length} 件の枠それぞれについて、投稿の本文を書いてください。variant は 1 にしてください。`,
        '',
        blocks.join('\n\n'),
    ].join('\n');

    const result = await generateJson({ model, system, prompt, schema: DRAFT_SCHEMA, temperature: 1.0 });
    return result.posts ?? [];
}

/**
 * 複数の案から、枠ごとに1つ選ぶ。
 *
 * 書いた本人に選ばせない。同じ指示で書いた文章を同じ指示で見ると、
 * 「指示に従っているか」しか見えなくなり、読まれるかどうかを見なくなる。
 * 読者側に立った別の指示で、はっきり点を付けさせる。
 *
 * 選べなかった枠は、案の1つ目をそのまま使う（ここで止めない）。
 */
async function pickBest({ model, drafts, plan, profileByName, context, policy, guardrails }) {
    const byId = new Map();
    for (const draft of drafts) {
        if (!byId.has(draft.id)) byId.set(draft.id, []);
        byId.get(draft.id).push(draft);
    }

    const multi = [...byId.values()].filter((list) => list.length > 1);
    if (multi.length === 0) return drafts;

    const system = [
        'あなたは、教員向けメディアの編集者です。',
        'X に出す投稿の案を読んで、どれがいちばん読まれるかを選びます。書いた本人ではありません。',
        '',
        audienceBlock(context.audience),
        '',
        '## 採点の観点（上から重い順）',
        '1. 最初の1行で、読者が自分の教室を思い浮かべて手を止めるか',
        '2. 具体があるか（時間・回数・場面・数字。「便利」「使いやすい」だけの案は落とす）',
        '3. 宣伝に見えないか（「作りました」から入る案、機能の羅列は落とす）',
        '4. その人がいま抱えている困りごとに当たっているか',
        '5. 教員としての品位（煽り、誇大、断定が無いか）',
        '',
        '⚠ 派手さでは選ばないでください。煽った案・大げさな案は、それだけで落としてください。',
        '   静かでも具体があって、読んだ人が明日そのまま真似できる案を上に置いてください。',
        '',
        '## 書き手が守っている方針（参考）',
        policy,
    ].join('\n');

    const blocks = multi.map((list) => {
        const slot = plan.find((p) => p.id === list[0].id);
        const profile = profileByName.get(slot?.repo);
        const cands = list
            .map(
                (d) =>
                    `- variant ${d.variant}（フック: ${d.hook ?? '?'}）\n  1行目: ${hookOf(d.body)}\n  本文: ${d.body}` +
                    (d.thread?.length ? `\n  つづき: ${d.thread.join(' / ')}` : '')
            )
            .join('\n');
        return [
            `### 枠 id: ${list[0].id}`,
            `日付: ${slot?.date}（${slot?.weekday}曜）${slot?.slotLabel} / 型: ${slot?.themeLabel}`,
            `アプリ: ${slot?.repo} — ${profile?.oneLine ?? ''}`,
            '案:',
            cands,
        ].join('\n');
    });

    const prompt = [
        nowBlock(context),
        '',
        `次の ${multi.length} 件の枠それぞれについて、いちばん読まれる案を1つ選んでください。`,
        '選んだ理由は1文で書いてください。',
        '',
        blocks.join('\n\n'),
    ].join('\n');

    let picks = [];
    try {
        const result = await generateJson({ model, system, prompt, schema: JUDGE_SCHEMA, temperature: 0.2 });
        picks = result.picks ?? [];
    } catch (error) {
        // 選べなくても投稿は作れる。1案目を使って先へ進む。
        console.error(`⚠ 案の選抜に失敗しました。各枠の1案目を使います: ${String(error.message).split('\n')[0]}`);
    }

    const chosen = new Map(picks.map((p) => [p.id, p]));
    const out = [];
    let judged = 0;

    for (const [id, list] of byId) {
        const pick = chosen.get(id);
        const hit = pick ? list.find((d) => d.variant === pick.variant) : null;
        const winner = hit ?? list[0];
        if (hit) judged += 1;
        out.push({
            ...winner,
            // 落選案も残す。ランチャーから差し替えられるようにするため。
            alternatives: list.filter((d) => d !== winner).map((d) => ({ body: d.body, thread: d.thread ?? [], hook: d.hook })),
            pickedBy: hit ? 'editor' : 'first',
            pickReason: hit ? pick.reason : null,
            pickScore: hit ? pick.score : null,
        });
    }

    info(`   ${judged}/${multi.length} 枠を編集者が選びました（残りは1案目）`);
    void guardrails;
    return out;
}

/** 割り当てと本文を合体させて、投稿として完成した形にする。 */
function assemble(plan, drafts, profileByName, accounts, guardrails) {
    const byId = new Map(drafts.map((d) => [d.id, d]));
    const placement = guardrails?.urlPlacement ?? 'reply';
    const maxThread = guardrails?.threadMaxSteps ?? 3;

    return plan
        .map((slot) => {
            const draft = byId.get(slot.id);
            if (!draft) return null;

            const profile = profileByName.get(slot.repo);
            const url = profile?.pagesUrl ?? `${accounts.pagesBase}${slot.repo}/`;
            const hashtags = (draft.hashtags ?? []).slice(0, 3).map((t) => t.replace(/^#/, ''));
            const thread = (draft.thread ?? []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, maxThread);

            const steps = composeSteps({
                body: draft.body,
                thread,
                url,
                hashtags,
                placement,
                seed: seedFrom(slot.id),
            });

            return {
                id: slot.id,
                date: slot.date,
                weekday: slot.weekday,
                slot: slot.slot,
                slotLabel: slot.slotLabel,
                hour: slot.hour,
                minute: slot.minute,
                theme: slot.theme,
                themeLabel: slot.themeLabel,
                repo: slot.repo,
                body: draft.body,
                hook: draft.hook ?? null,
                hashtags,
                url,
                steps,
                // これまで text は「投稿する文そのもの」だった。連投になっても、
                // 本文（1コマ目）を指すという意味は変わらない。
                // 通知やランチャーの古い版がここだけを見ていても壊れないように残す。
                text: steps[0].text,
                media: mediaPathFor(slot.repo),
                weightedLength: 0, // lint 側で埋める
                // 落選した案。ランチャーから差し替えられるようにする。
                alternatives: draft.alternatives ?? [],
                pickedBy: draft.pickedBy ?? null,
                pickReason: draft.pickReason ?? null,
            };
        })
        .filter(Boolean);
}

/** 予備の引き出しに入れる本数。 */
const STOCK_SIZE = 10;

/**
 * 予定に無いときのための投稿を作り置きする。
 *
 * なぜ作り置きなのか:
 *   「いま1本出したい」をその場で作るには、ブラウザから Gemini を呼ぶことになる。
 *   そのためには API キーを画面に持たせるしかなく、それは docs/ に秘密情報を
 *   置かないという決まり（CLAUDE.md §2）に反する。
 *   週に1回まとめて作っておけば、押した瞬間に出せて、費用も増えない。
 *
 * その週の予定に出ていないアプリから選ぶ。予定と同じものが並んでも引き出しにならない。
 */
async function buildStock({ model, policy, plan, profiles, profileByName, accounts, guardrails, monetization, context, weekId }) {
    const usedThisWeek = new Set(plan.map((p) => p.repo));
    const themes = context.themesConfig ?? null;
    void themes;

    const candidates = profiles.filter((p) => !usedThisWeek.has(p.name) && p.pagesUrl);
    if (candidates.length === 0) return [];

    // 週IDを種にして毎回同じ並びにする。作りなおしても引き出しの顔ぶれが変わらない。
    const picked = [...candidates]
        .sort((a, b) => (seedFrom(weekId + a.name) >>> 0) - (seedFrom(weekId + b.name) >>> 0))
        .slice(0, STOCK_SIZE);

    const stockPlan = picked.map((profile, i) => {
        const theme = plan[i % plan.length];
        return {
            id: `stock-${weekId}-${i + 1}`,
            date: '',
            weekday: '',
            slot: 'stock',
            slotLabel: '予備',
            hour: 0,
            minute: 0,
            theme: theme.theme,
            themeLabel: theme.themeLabel,
            themeIntent: theme.themeIntent,
            themeStructure: theme.themeStructure,
            repo: profile.name,
        };
    });

    let drafts;
    try {
        drafts = await askForDrafts({
            model,
            policy,
            plan: stockPlan,
            profileByName,
            monetization,
            guardrails,
            context,
            note: null,
            variants: 1, // 引き出しは数が要る。1案ずつでよい
        });
    } catch (error) {
        // 引き出しが作れなくても、その週の投稿は出せる。ここで止めない。
        console.error(`⚠ 予備の引き出しを作れませんでした: ${String(error.message).split('\n')[0]}`);
        return [];
    }

    const built = assemble(stockPlan, drafts, profileByName, accounts, guardrails);
    // 引き出しにも同じ検査をかける。押した瞬間に出すものなので、あとから直す機会がない。
    return built.filter((post) => lintPost(post, guardrails, monetization).length === 0);
}

/** カード画像がある場合だけパスを入れる。無ければ null（文字だけの投稿になる）。 */
function mediaPathFor(repo) {
    const file = `${repo}-card.png`;
    return fs.existsSync(paths.media(file)) ? `media/${file}` : null;
}

function loadProfiles() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(paths.data('profiles', f)));
}

main().catch(failWith);
