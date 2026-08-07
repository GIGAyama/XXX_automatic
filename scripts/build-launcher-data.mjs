#!/usr/bin/env node
/**
 * ⑤ ランチャー用のデータを組む。
 *
 *   node scripts/build-launcher-data.mjs
 *
 * data/ の中身から、投稿ランチャー（docs/）が読む1つの JSON を作る。
 *
 * なぜ docs/ に別ファイルを置くのか:
 *   ランチャーは GitHub Pages 上の素の HTML/JS で動く。
 *   data/ の中はスクリプト向けの形で、profiles や repos の全文まで入っていて重い。
 *   スマホで開く画面が、使わないデータのダウンロードを待つのは無駄である。
 *   表示に要るものだけをここで抜き出す。
 */
import fs from 'node:fs';
import { fail, info, loadConfig, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, nextWeekDates } from './lib/jst.mjs';

function main() {
    const { accounts, slots } = loadConfig();

    // 今週と翌週を載せる。日曜の夜に翌週分ができるので、
    // 週末は「今週の残り」と「来週の分」が両方見える状態になる。
    const weekIds = [...new Set([isoWeekId(jstDateString()), isoWeekId(nextWeekDates()[0])])];

    const posts = [];
    const notes = [];

    for (const weekId of weekIds) {
        const queue = readJson(paths.data('queue', `${weekId}.json`), null);
        if (queue) {
            for (const post of queue.posts) {
                posts.push({
                    id: post.id,
                    weekId,
                    date: post.date,
                    weekday: post.weekday,
                    slot: post.slot,
                    slotLabel: post.slotLabel,
                    hour: post.hour,
                    theme: post.theme,
                    themeLabel: post.themeLabel,
                    repo: post.repo,
                    text: post.text,
                    url: post.url,
                    media: post.media,
                    weightedLength: post.weightedLength ?? null,
                });
            }
        }

        const note = readJson(paths.data('note', `${weekId}.json`), null);
        if (note) {
            notes.push({
                weekId,
                title: note.title,
                tags: note.tags,
                featured: note.featured,
                plain: note.plain,
                charCount: note.charCount,
            });
        }
    }

    posts.sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date < b.date ? -1 : 1));

    if (posts.length === 0 && notes.length === 0) {
        info('⚠ 載せるものがありません。先に `npm run generate` を実行してください。');
    }

    const outPath = paths.docs('launcher.json');
    writeJson(outPath, {
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        weekIds,
        launcherUrl: accounts.launcherUrl,
        noteEditorUrl: accounts.noteEditorUrl,
        xHandle: accounts.xHandle,
        // 「反応がよかった」の記録を Issue にして送り返すために使う。
        // トークンを画面に持たせずに書き戻せる唯一の方法がこれ。
        repoUrl: `https://github.com/${accounts.githubOwner}/${accounts.repoName}`,
        slots: slots.slots.map((s) => ({ id: s.id, label: s.label, hour: s.hour })),
        posts,
        notes,
    });

    info(`⑤ 完了 — ${rel(outPath)}`);
    info(`   投稿 ${posts.length} 件 / note 下書き ${notes.length} 本（${weekIds.join(', ')}）`);

    const missingMedia = posts.filter((p) => !p.media).length;
    if (missingMedia > 0) {
        info(`   ※ ${missingMedia} 件は画像がありません。\`npm run media\` を実行すると付きます`);
    }
}

try {
    main();
} catch (error) {
    fail(error.stack ?? error.message);
}

export {};
