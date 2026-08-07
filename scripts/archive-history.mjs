#!/usr/bin/env node
/**
 * ⓪' 終わった週を履歴に移す。
 *
 *   node scripts/archive-history.mjs [--dry-run] [--today YYYY-MM-DD]
 *
 * data/queue/<週ID>.json のうち、最終日が今日以前になった週を data/history.json に写す。
 * plan-week.mjs はこの履歴を見て「同じアプリを近い日に出さない」「同じ型を続けない」を守る。
 *
 * ここが無かったあいだ、履歴はいつも空だった。
 * つまり rotation の設定（noSameRepoWithinDays: 4 など）は、
 * その週の中でしか効いていなかった。先週の月曜に出したアプリが、
 * 今週の月曜にまた出る、という重複を誰も止めていなかった。
 *
 * ⚠️ 判定は「最終日 <= 今日」。< ではない。
 *    週次ワークフローは日曜 20:00 JST に走る。この瞬間、今週（月〜日）の最終日は「今日」である。
 *    < にすると今週が履歴に入らないまま翌週を組むことになり、
 *    週をまたいだ重複回避が――まさにいま直そうとしている症状が――そのまま残る。
 *
 * なぜ generate-week.mjs や build-launcher-data.mjs に持たせないのか:
 *   generate-week は --dry-run や --week でのやり直しがある。書く側を兼ねると、
 *   作りなおすたびに履歴が汚れる。build-launcher-data は data/ を表示用に写すだけの
 *   変換であるべきで、ローカルで叩くたびに履歴が伸びるのは筋が悪い。読む人と書く人は分ける。
 */
import fs from 'node:fs';
import { fail, failWith, info, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { jstDateString, jstStamp } from './lib/jst.mjs';

/** 履歴に残す日数。plan-week.mjs は 60 日で頭打ちにしているので、それ以上は選択に効かない。 */
export const KEEP_DAYS = 90;

const EMPTY = { version: 1, posts: [] };

/**
 * 履歴に足すべき投稿を選ぶ。
 * @param {object[]} weeks  [{ weekId, dates, posts }]
 * @param {string} today    JST の 'YYYY-MM-DD'
 */
export function selectArchivable(weeks, today) {
    const out = [];
    for (const week of weeks) {
        const lastDay = week.dates?.[week.dates.length - 1];
        if (!lastDay) continue;
        // <= であること。日曜の夜に走ったとき、その日で終わる今週を取りこぼさないため。
        if (lastDay > today) continue;
        for (const post of week.posts ?? []) {
            out.push({
                id: post.id,
                date: post.date,
                weekId: week.weekId,
                repo: post.repo,
                theme: post.theme,
                slot: post.slot,
            });
        }
    }
    return out;
}

/** 既存の履歴に足して、古いものを落とす。同じ id は二度入れない（何度走らせても同じ結果になる）。 */
export function mergeHistory(current, incoming, today, keepDays = KEEP_DAYS) {
    const posts = [...(current?.posts ?? [])];
    const seen = new Set(posts.map((p) => p.id));

    let added = 0;
    for (const post of incoming) {
        if (seen.has(post.id)) continue;
        posts.push(post);
        seen.add(post.id);
        added += 1;
    }

    const cutoff = shiftDays(today, -keepDays);
    const kept = posts.filter((p) => p.date >= cutoff);
    kept.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1));

    return { posts: kept, added, dropped: posts.length - kept.length };
}

function shiftDays(dateString, n) {
    const [y, m, d] = dateString.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    at.setUTCDate(at.getUTCDate() + n);
    const pad = (v) => String(v).padStart(2, '0');
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

function loadWeeks() {
    const dir = paths.data('queue');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(paths.data('queue', f)))
        .filter((week) => week && Array.isArray(week.posts));
}

function main() {
    const args = parseArgs();
    const today = args.today ?? jstDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail("--today は 'YYYY-MM-DD' 形式で渡してください");

    info(`⓪' 終わった週を履歴に移します（${jstStamp()} / 基準日 ${today}）`);

    const weeks = loadWeeks();
    const incoming = selectArchivable(weeks, today);
    const current = readJson(paths.data('history.json'), EMPTY);
    const { posts, added, dropped } = mergeHistory(current, incoming, today);

    info(`   週 ${weeks.length} 件を確認 → 新たに ${added} 件を履歴へ / ${KEEP_DAYS} 日より古い ${dropped} 件を落としました`);
    info(`   履歴の合計: ${posts.length} 件`);

    if (added === 0 && dropped === 0 && fs.existsSync(paths.data('history.json'))) {
        info('   変更はありません');
        return;
    }

    if (args['dry-run']) {
        info('\n--dry-run なので保存しません。');
        return;
    }

    writeJson(paths.data('history.json'), { version: 1, updatedAtJst: jstStamp(), posts });
    info(`   ${rel(paths.data('history.json'))} を更新しました`);
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (error) {
        failWith(error);
    }
}
