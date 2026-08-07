#!/usr/bin/env node
/**
 * ② 理解 — README などを読んで、アプリごとの「プロフィール」を作る。
 *
 *   node scripts/build-profiles.mjs
 *   node scripts/build-profiles.mjs --limit 3     … まず3件だけ試す
 *   node scripts/build-profiles.mjs --force       … キャッシュを無視して作りなおす
 *   node scripts/build-profiles.mjs --repo Typa   … 1件だけ
 *
 * なぜこの工程を分けているか:
 *   投稿文を作るたびに README 全文（1万字あることもある）をプロンプトに入れると、
 *   毎週その分のトークンを使うことになり、無料枠をすぐ使い切る。
 *   一度だけ読んで「投稿の材料になる形」に圧縮しておけば、
 *   毎週のプロンプトはこの圧縮済みプロフィールだけで済む。
 *
 *   さらに、コミット SHA を保存しておいて、変わっていないリポジトリは
 *   Gemini を呼ばない。初回だけ 50 回ほど呼び、以降は更新されたものだけになる。
 */
import fs from 'node:fs';
import { generateJson, requireApiKey, sleep } from './lib/gemini.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';

/**
 * 出させる形。responseSchema で縛ると、項目の欠けや余計な前置きが混ざらない。
 * ここに無い情報は投稿文生成のプロンプトに渡らないので、
 * 「投稿でこういうことに触れてほしい」と思ったらこのスキーマに足す。
 */
const PROFILE_SCHEMA = {
    type: 'object',
    properties: {
        oneLine: { type: 'string', description: '30字以内。このアプリが何をするものかを一文で' },
        catchCopy: { type: 'string', description: '20字以内。紹介カード画像に載せる短い惹句' },
        targetGrade: { type: 'string', description: '対象学年。例「小1〜小3」「全学年」「教員向け」' },
        subject: { type: 'string', description: '教科・領域。例「算数」「国語」「学級経営」「校務」' },
        painPoints: {
            type: 'array',
            items: { type: 'string' },
            description: 'このアプリが引き受ける、教室で実際に起きる困りごと。2〜4個。抽象語を使わず具体的な場面で書く',
        },
        howToUse: {
            type: 'array',
            items: { type: 'string' },
            description: '使い方を3ステップで。各30字以内',
        },
        strengths: {
            type: 'array',
            items: { type: 'string' },
            description: '他と違う点・作り手のこだわり。2〜4個',
        },
        classroomScenes: {
            type: 'array',
            items: { type: 'string' },
            description: '授業のどの場面で開くか。具体的に。2〜3個',
        },
        designDecisions: {
            type: 'array',
            items: { type: 'string' },
            description: 'なぜその作りにしたかという設計判断。README に書かれていれば拾う。無ければ空配列',
        },
        keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'ハッシュタグ候補。#は付けない。3〜6個',
        },
        postability: {
            type: 'integer',
            description: '1〜5。SNS の話題にしやすいか。5=単体で紹介記事が書ける、1=説明が難しい/地味',
        },
    },
    required: [
        'oneLine',
        'catchCopy',
        'targetGrade',
        'subject',
        'painPoints',
        'howToUse',
        'strengths',
        'classroomScenes',
        'designDecisions',
        'keywords',
        'postability',
    ],
};

const SYSTEM = `あなたは日本の小学校教員が作った学習アプリを読み解き、SNS発信の材料に整理する編集者です。
リポジトリの README や MANUAL に書かれていることだけを根拠にしてください。
書かれていないことを推測で補わないでください。特に学習効果については、
README に書かれていない限り一切言及しないでください。
出力はすべて日本語にしてください。`;

function buildPrompt(repo) {
    const parts = [
        `# 対象アプリ: ${repo.name}`,
        repo.description ? `GitHub の説明文: ${repo.description}` : null,
        repo.topics?.length ? `トピック: ${repo.topics.join(', ')}` : null,
        repo.pagesUrl ? `公開URL: ${repo.pagesUrl}` : '公開URL: なし（ブラウザで動くアプリではない可能性があります）',
        '',
        repo.source?.readme ? `## README.md\n${repo.source.readme}` : '## README.md\n（ありません）',
        repo.source?.manual ? `\n## MANUAL.md\n${repo.source.manual}` : '',
        repo.source?.manifest ? `\n## manifest.webmanifest\n${repo.source.manifest}` : '',
        repo.recentCommits?.length
            ? `\n## 直近のコミット\n${repo.recentCommits.map((c) => `- ${c.message}`).join('\n')}`
            : '',
        '',
        '上の資料を読んで、このアプリのプロフィールを JSON で出力してください。',
        'painPoints と classroomScenes は、実際に教室で起きる場面が目に浮かぶ具体性で書いてください。',
        '「便利」「使いやすい」のような、どのアプリにも当てはまる言葉は使わないでください。',
    ];
    return parts.filter((p) => p !== null && p !== '').join('\n');
}

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();

    // 1件目を投げる前に確かめる。キーが無いまま走らせると、
    // 全リポジトリぶん失敗を繰り返したうえで「完了」と表示され、原因が埋もれる。
    requireApiKey();

    const collected = readJson(paths.data('repos.json'), null);
    if (!collected) fail('data/repos.json がありません。先に `npm run collect` を実行してください。');

    let targets = collected.repos;
    if (args.repo) targets = targets.filter((r) => r.name === args.repo);
    if (args.limit) targets = targets.slice(0, Number(args.limit));

    if (targets.length === 0) fail(`対象のリポジトリが見つかりません（--repo ${args.repo ?? ''}）`);

    info(`② 理解を開始します — ${targets.length} 件が対象`);

    let built = 0;
    let cached = 0;
    let skipped = 0;
    let failed = 0;
    const failures = [];

    for (const [index, repo] of targets.entries()) {
        const label = `[${index + 1}/${targets.length}] ${repo.name}`;
        const outPath = paths.data('profiles', `${repo.name}.json`);

        // 素材が何も無いものは、何を書いても中身の無い紹介文にしかならない。
        // 無理に投稿の題材にせず、はっきり除外する。
        if (!repo.source?.readme && !repo.description) {
            info(`   − ${label} 素材（README・説明文）が無いので飛ばします`);
            skipped += 1;
            continue;
        }

        const existing = fs.existsSync(outPath) ? readJson(outPath) : null;
        if (!args.force && existing?.sourceSha && existing.sourceSha === repo.headSha) {
            cached += 1;
            continue;
        }

        try {
            const profile = await generateJson({
                model: accounts.geminiModel,
                system: SYSTEM,
                prompt: buildPrompt(repo),
                schema: PROFILE_SCHEMA,
                temperature: 0.4, // 事実の整理なので、ここは振らさない
            });

            writeJson(outPath, {
                name: repo.name,
                sourceSha: repo.headSha,
                pagesUrl: repo.pagesUrl,
                hasPages: repo.hasPages,
                pushedAt: repo.pushedAt,
                generatedAt: new Date().toISOString(),
                ...profile,
            });

            built += 1;
            info(`   ✓ ${label} ${profile.oneLine}`);

            // 無料枠は1分あたりのリクエスト数にも上限がある。
            // 連続で投げると 429 を踏んで待ち時間が増えるだけなので、ここで間隔を空ける。
            await sleep(4000);
        } catch (error) {
            failed += 1;
            failures.push(`${repo.name}: ${error.message.split('\n')[0]}`);
            console.error(`   ✖ ${label} — ${error.message.split('\n')[0]}`);
        }
    }

    info('');
    info(
        `② 集計 — 新規/更新 ${built} 件、キャッシュ据え置き ${cached} 件、` +
            `素材なしで除外 ${skipped} 件、失敗 ${failed} 件`
    );

    // 全滅したときに「完了」と出して次へ進むと、後続の工程が
    // 「プロフィールが空です」という無関係な顔で落ちる。
    // 原因が出ている場所で止める。
    if (failed > 0 && built === 0) {
        fail(
            `${failed} 件すべてで失敗しました。1件も作れていません。\n` +
                `  最初の失敗: ${failures[0]}\n` +
                '  同じ原因が全件に効いている可能性が高いので、まずそこを直してください。'
        );
    }

    if (failed > 0) {
        info(`   ※ ${failed} 件は失敗しました（成功した ${built} 件で先へ進みます）`);
    }

    if (built === 0 && cached === 0) {
        fail('プロフィールが1件もありません。このままでは投稿を作れないのでここで止めます。');
    }

    info(`   出力先: ${rel(paths.data('profiles'))}/`);
}

main().catch(failWith);
