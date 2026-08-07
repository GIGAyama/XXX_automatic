#!/usr/bin/env node
/**
 * 生成済みの投稿をガードレールにかける。
 *
 *   node scripts/lint-drafts.mjs                 … 今週と翌週の queue を検査
 *   node scripts/lint-drafts.mjs --week 2026-W34
 *   node scripts/lint-drafts.mjs --all           … data/queue/ 全部
 *   node scripts/lint-drafts.mjs --fix           … 落ちた枠を、検査を通る別の案に差し替える
 *
 * generate-week.mjs は生成中にも同じ検査をしているので、
 * ここは「後から guardrails.json を厳しくしたときに、
 * 既に作ってある投稿を見なおす」ための入口である。
 * CI からも呼ばれる。
 *
 * ── --fix があるのはなぜか ─────────────────────────
 *
 * 基準を厳しくすると、既に作ってある週が落ちる。それは正しい動きだが、
 * 直す手段が「その週をまるごと作りなおす」しかなかった。
 * 作りなおすと、通っていた13枠まで別の文章に入れかわる。
 * しかも API キーが要るので、手元やレビュー中には直せない。
 *
 * ところで、落ちた枠には**そのとき選ばれなかった案**が残っている。
 * 生成のときに3案書かせて編集者役が1つ選んでいるので、
 * 落ちたのが選ばれたほうで、残りが基準を満たしていることがある。
 * それなら、生成を1回も呼ばずにその枠だけ直せる。
 *
 * ⚠️ 人が文章を書き足すことはしない。差し替えるのは機械が書いた案だけである。
 *    「AI が書いた文」と「人が直した文」の境界を混ぜない（CLAUDE.md §6）。
 */
import fs from 'node:fs';
import { fail, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, nextWeekDates } from './lib/jst.mjs';
import { lintAlternative, lintPost } from './lib/lint.mjs';
import { composeSteps, seedFrom } from './lib/x-text.mjs';

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

    let fixed = 0;

    for (const file of files) {
        const queue = readJson(paths.data('queue', file));
        info(`\n▼ ${file} — ${queue.posts.length} 件`);
        let touched = false;

        for (const post of queue.posts) {
            checked += 1;
            let problems = lintPost(post, guardrails, monetization);

            // 落ちた枠に、検査を通る別の案が残っていれば差し替える。
            // 生成を1回も呼ばずに、その枠だけ直せる。
            if (problems.length > 0 && args.fix) {
                const swapped = swapToPassingAlternative(post, guardrails, monetization);
                if (swapped) {
                    touched = true;
                    fixed += 1;
                    info(`   ↻ ${post.id} ${post.repo} — 別の案に差し替えました`);
                    info(`       落ちた理由: ${problems[0]}`);
                    info(`       新しい本文: ${post.body}`);
                    problems = lintPost(post, guardrails, monetization);
                }
            }

            if (problems.length === 0) {
                info(`   ✓ ${post.id} [${post.weightedLength}/${guardrails.maxWeightedLength}] ${post.repo}`);
            } else {
                failed += 1;
                info(`   ✖ ${post.id} ${post.repo}`);
                for (const p of problems) info(`       ${p}`);
                if (args.fix) info('       通る別の案がありませんでした。この週を作りなおしてください');
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

        if (touched) {
            writeJson(paths.data('queue', file), queue);
            info(`   ${rel(paths.data('queue', file))} を書きかえました`);
        }
    }

    info(`\n検査 ${checked} 件、問題あり ${failed} 件${fixed > 0 ? ` / 差し替え ${fixed} 件` : ''}`);
    if (fixed > 0) {
        info('差し替えたぶんは `npm run build` でランチャーにも反映してください');
    }
    if (badAlternatives > 0) {
        info(`別の案 ${badAlternatives} 件が基準を満たしていません（配信時に外れるので、投稿には出ません）`);
    }

    if (failed > 0) {
        fail(
            `${failed} 件が検査を通りませんでした。\n` +
                '  通る別の案に差し替える: npm run lint:drafts -- --fix\n' +
                '  該当の週を作りなおす:   npm run generate -- --week <週ID>\n' +
                '  基準を見なおす:         config/guardrails.json'
        );
    }

    info('すべて合格しました。');
}

/**
 * 検査を通る別の案に差し替える。
 *
 * 落ちた本文は残さない。基準を満たしていないものを、
 * ランチャーの［別の案］として押せる場所に置いてはいけないためである。
 *
 * @returns {boolean} 差し替えたか
 */
export function swapToPassingAlternative(post, guardrails, monetization) {
    const candidates = post.alternatives ?? [];
    const hit = candidates.find((alt) => lintAlternative(alt, post, guardrails, monetization).length === 0);
    if (!hit) return false;

    post.body = hit.body;
    post.hook = hit.hook ?? post.hook ?? null;
    // 落ちた本文は捨てる。選ばれなかった案のうち、まだ基準を満たすものだけを残す。
    post.alternatives = candidates
        .filter((alt) => alt !== hit)
        .filter((alt) => lintAlternative(alt, post, guardrails, monetization).length === 0);

    // 本文が変われば連投の組み立ても変わる。生成のときとまったく同じ手で組みなおす。
    post.steps = composeSteps({
        body: post.body,
        thread: hit.thread ?? [],
        url: post.url,
        hashtags: post.hashtags ?? [],
        placement: guardrails.urlPlacement ?? 'reply',
        seed: seedFrom(post.id),
    });
    post.text = post.steps[0].text;
    // どこから来た本文かを残す。あとで「なぜ編集者の選んだ案でないのか」を追えるようにする。
    post.pickedBy = 'lint-fix';
    post.pickReason = '編集者が選んだ案が検査に落ちたので、基準を満たす別の案に差し替えました';

    return true;
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
