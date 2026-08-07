#!/usr/bin/env node
/**
 * 生成済みの投稿をガードレールにかける。
 *
 *   node scripts/lint-drafts.mjs                 … 今週と翌週の queue を検査
 *   node scripts/lint-drafts.mjs --week 2026-W34
 *   node scripts/lint-drafts.mjs --all           … data/queue/ 全部
 *
 * generate-week.mjs は生成中にも同じ検査をしているので、
 * ここは「後から guardrails.json を厳しくしたときに、
 * 既に作ってある投稿を見なおす」ための入口である。
 * CI からも呼ばれる。
 */
import fs from 'node:fs';
import { fail, info, loadConfig, parseArgs, paths, readJson, rel } from './lib/io.mjs';
import { isoWeekId, jstDateString, nextWeekDates } from './lib/jst.mjs';
import { lintPost } from './lib/lint.mjs';

function main() {
    const args = parseArgs();
    const { guardrails, monetization } = loadConfig();

    const dir = paths.data('queue');
    if (!fs.existsSync(dir)) {
        info('data/queue/ がまだありません。検査するものがないので終了します。');
        return;
    }

    let files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (args.week) {
        files = files.filter((f) => f === `${args.week}.json`);
    } else if (!args.all) {
        const wanted = new Set([isoWeekId(jstDateString()), isoWeekId(nextWeekDates()[0])]);
        files = files.filter((f) => wanted.has(f.replace('.json', '')));
    }

    if (files.length === 0) {
        info('検査対象の週がありません。');
        return;
    }

    let checked = 0;
    let failed = 0;

    for (const file of files) {
        const queue = readJson(paths.data('queue', file));
        info(`\n▼ ${file} — ${queue.posts.length} 件`);

        for (const post of queue.posts) {
            checked += 1;
            const problems = lintPost(post, guardrails, monetization);
            if (problems.length === 0) {
                info(`   ✓ ${post.id} [${post.weightedLength}/${guardrails.maxWeightedLength}] ${post.repo}`);
            } else {
                failed += 1;
                info(`   ✖ ${post.id} ${post.repo}`);
                for (const p of problems) info(`       ${p}`);
            }
        }
    }

    info(`\n検査 ${checked} 件、問題あり ${failed} 件`);

    if (failed > 0) {
        fail(
            `${failed} 件が検査を通りませんでした。\n` +
                '  該当の週を作りなおす: npm run generate -- --week <週ID>\n' +
                '  基準を見なおす:       config/guardrails.json'
        );
    }

    info('すべて合格しました。');
}

main();
