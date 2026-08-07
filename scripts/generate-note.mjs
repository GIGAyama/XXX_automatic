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
 * 出力を Markdown ではなくプレーンテキスト寄りにしているのは、
 * note のエディタが Markdown 記法をそのまま解釈しないためである。
 * 「## 見出し」を貼ると「## 見出し」という文字列がそのまま残ってしまう。
 */
import { generateJson, requireApiKey } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { fail, failWith, info, loadConfig, loadPolicy, parseArgs, paths, readJson, rel, writeJson, writeText } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, nextWeekDates } from './lib/jst.mjs';
import fs from 'node:fs';

const NOTE_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string', description: '記事タイトル。30字以内。煽らず、内容が分かるもの' },
        lead: { type: 'string', description: '冒頭の導入。150字程度。読者の困りごとから入る' },
        sections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    heading: { type: 'string', description: '見出し。20字以内' },
                    paragraphs: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '本文の段落。1段落200〜400字。2〜4段落',
                    },
                },
                required: ['heading', 'paragraphs'],
            },
            description: '3〜5個の節',
        },
        closing: { type: 'string', description: '結び。150字程度。押しつけがましくない終わり方' },
        tags: { type: 'array', items: { type: 'string' }, description: 'note のハッシュタグ。#は付けない。4〜6個' },
        appLinks: {
            type: 'array',
            items: { type: 'string' },
            description: '記事で触れたアプリのリポジトリ名。与えられた候補の中から選ぶ',
        },
    },
    required: ['title', 'lead', 'sections', 'closing', 'tags', 'appLinks'],
};

async function main() {
    const args = parseArgs();
    const { accounts, monetization } = loadConfig();

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

    info(`④' note の下書きを作ります（${jstStamp()}）`);
    info(`   対象週: ${weekId}`);
    info(`   題材: ${featured.map((p) => p.name).join(', ')}`);

    const { model, source } = await resolveGeminiModel(accounts);
    info(`   モデル: ${model}（${source}）\n`);

    const article = await generateJson({
        model,
        system: buildSystem(loadPolicy(), monetization),
        prompt: buildPrompt(featured, accounts),
        schema: NOTE_SCHEMA,
        temperature: 0.95,
    });

    const plain = renderPlainText(article, featured, accounts, monetization);
    const markdown = renderMarkdown(article, featured, accounts, weekId);

    if (args['dry-run']) {
        info('──── 生成結果（--dry-run なので保存しません）────\n');
        info(plain);
        return;
    }

    const jsonPath = paths.data('note', `${weekId}.json`);
    const mdPath = paths.data('note', `${weekId}.md`);

    writeJson(jsonPath, {
        weekId,
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        title: article.title,
        tags: article.tags,
        featured: featured.map((p) => p.name),
        // plain がランチャーからクリップボードに入る本文の正体。
        plain,
        charCount: plain.length,
    });
    writeText(mdPath, markdown);

    info(`④' 完了 — ${rel(jsonPath)}（${plain.length}字）`);
    info(`   読む用: ${rel(mdPath)}`);
}

function buildSystem(policy, monetization) {
    return `あなたは日本の小学校教員です。生成AIを使って自作した学習アプリについて、note に記事を書きます。

${policy}

【note の記事として守ること】
- 読者は同じ現場の先生です。教室の具体的な場面を必ず入れてください。
- 宣伝記事にしないでください。「こういう困りごとがあって、こう考えて、こう作った」という道筋が主役です。
- アプリの機能を並べるのではなく、なぜその機能が要ったのかを書いてください。
- 全体で1500〜2500字程度。読み切れる長さにしてください。
- 見出しに記号（#、■、【】など）を付けないでください。文字だけで書いてください。
- 段落の中で改行を入れないでください。1段落は続けて書いてください。
${monetization?.enabled ? '' : '- 有料記事への誘導、アフィリエイト、支援のお願いは一切書かないでください。'}`;
}

function buildPrompt(featured, accounts) {
    const blocks = featured.map((p) => {
        return [
            `### ${p.name}`,
            `公開URL: ${p.pagesUrl ?? `${accounts.pagesBase}${p.name}/`}`,
            `一言: ${p.oneLine}`,
            `対象: ${p.targetGrade} / ${p.subject}`,
            `引き受ける困りごと: ${(p.painPoints ?? []).join(' / ')}`,
            `使い方: ${(p.howToUse ?? []).join(' → ')}`,
            `こだわり: ${(p.strengths ?? []).join(' / ')}`,
            `使う場面: ${(p.classroomScenes ?? []).join(' / ')}`,
            p.designDecisions?.length ? `設計判断: ${p.designDecisions.join(' / ')}` : null,
        ]
            .filter(Boolean)
            .join('\n');
    });

    return `次のアプリを題材に、note の記事を1本書いてください。
全部を平等に紹介する必要はありません。1つを軸にして、他は関連として触れる形でもかまいません。
記事の切り口はあなたが決めてください（開発の経緯、現場の困りごと、AIを使った教材づくりの実際、など）。

${blocks.join('\n\n')}

資料に書かれていないことは書かないでください。特に学習効果については、書かれていない限り触れないでください。`;
}

/**
 * note のエディタに貼り付ける本文。
 * 見出しは装飾記号を付けず、前後に空行を置いて視覚的に区切る。
 * note 側で見出しにしたいときは、貼り付けた後にその行を選んで見出しにできる。
 */
function renderPlainText(article, featured, accounts, monetization) {
    const parts = [article.lead, ''];

    for (const section of article.sections) {
        parts.push(section.heading, '');
        for (const paragraph of section.paragraphs) parts.push(paragraph, '');
    }

    parts.push(article.closing, '');

    // 記事で触れたアプリのリンクを最後にまとめる。
    // 本文中に URL を挟むと読む流れが切れるので、末尾に置く。
    const linked = featured.filter((p) => (article.appLinks ?? []).includes(p.name));
    const links = linked.length > 0 ? linked : featured;
    parts.push('この記事で紹介したアプリ', '');
    for (const p of links) {
        parts.push(`${p.name}（${p.oneLine}）`, p.pagesUrl ?? `${accounts.pagesBase}${p.name}/`, '');
    }

    parts.push('すべてブラウザで動きます。登録もインストールも要りません。');

    if (monetization?.enabled && monetization.links?.membership) {
        parts.push('', monetization.links.membership);
    }

    parts.push('', (article.tags ?? []).map((t) => `#${t.replace(/^#/, '')}`).join(' '));

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** リポジトリの中で読むための Markdown。note に貼るのは plain のほう。 */
function renderMarkdown(article, featured, accounts, weekId) {
    const parts = [
        `# ${article.title}`,
        '',
        `> ${weekId} の下書き。note に貼るときは data/note/${weekId}.json の \`plain\` を使ってください`,
        '> （このファイルの Markdown 記法は note のエディタでは解釈されません）。',
        '',
        article.lead,
        '',
    ];

    for (const section of article.sections) {
        parts.push(`## ${section.heading}`, '');
        for (const paragraph of section.paragraphs) parts.push(paragraph, '');
    }

    parts.push('## おわりに', '', article.closing, '', '## 紹介したアプリ', '');
    for (const p of featured) {
        parts.push(`- [${p.name}](${p.pagesUrl ?? `${accounts.pagesBase}${p.name}/`}) — ${p.oneLine}`);
    }
    parts.push('', (article.tags ?? []).map((t) => `#${t.replace(/^#/, '')}`).join(' '), '');

    return parts.join('\n');
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
