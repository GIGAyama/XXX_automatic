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
import { lintAlternative, lintPost } from './lib/lint.mjs';

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
    let badAlternatives = 0;

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

            // 落選案（ランチャーの［別の案］）も同じ基準で見る。
            // ここは失敗にしない。差し替え候補は build-launcher-data.mjs が配信時にふるい落とすので、
            // 検査を通らない案が外に出ることはない。見えるようにしておくのが目的である。
            for (const alt of post.alternatives ?? []) {
                const altProblems = lintAlternative(alt, post, guardrails, monetization);
                if (altProblems.length === 0) continue;
                badAlternatives += 1;
                info(`   ⚠ ${post.id} の別の案: ${altProblems[0]}`);
            }
        }
    }

    info(`\n検査 ${checked} 件、問題あり ${failed} 件`);
    if (badAlternatives > 0) {
        info(`別の案 ${badAlternatives} 件が基準を満たしていません（配信時に外れるので、投稿には出ません）`);
    }

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
