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
import { jstDateString, jstStamp, weekDatesOfIsoWeek } from './lib/jst.mjs';

/** 履歴に残す日数。plan-week.mjs は 60 日で頭打ちにしているので、それ以上は選択に効かない。 */
export const KEEP_DAYS = 90;

/**
 * data/queue・data/note・data/trends を何週ぶん残すか。
 *
 * ここまでは消さない、という線であって、消してよい線ではない。
 * ランチャーは過去3週ぶんを載せるし、再放送は履歴（90日＝約13週）から拾う。
 * どちらにも余裕を持たせて 26 週にしてある。
 *
 * 消す処理を置いたのは、どこにも無かったからである。週に3〜4ファイルずつ、
 * ただ増えつづけていた。
 */
export const KEEP_WEEKS = 26;

/** 履歴に載せる落選案の数。再放送の材料になる。 */
const KEEP_ALTERNATIVES = 2;

const EMPTY = { version: 1, posts: [] };

/**
 * 履歴に足すべき投稿を選ぶ。
 *
 * ⚠️ 本文・フック・落選案まで写す。
 *    以前は id / date / repo / theme / slot だけだった。そのため
 *    ・週をまたいだ「同じ言い回し」を機械で防げない
 *    ・反応がよかった投稿を出し直す材料が data/queue/ にしか無い
 *    ・その data/queue/ を消せない（消すと上の2つができなくなる）
 *    という3つが同時に詰んでいた。本文を履歴に持たせると、まとめて解ける。
 *
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
                // 以下は「あとで使う材料」。無い週（古い形）もあるので、あるときだけ載せる。
                body: post.body ?? null,
                hook: post.hook ?? null,
                hashtags: post.hashtags ?? [],
                url: post.url ?? null,
                alternatives: (post.alternatives ?? [])
                    .slice(0, KEEP_ALTERNATIVES)
                    .map((a) => ({ body: a.body, thread: a.thread ?? [] })),
            });
        }
    }
    return out;
}

/**
 * 既存の履歴に足して、古いものを落とす。同じ id は二度入れない（何度走らせても同じ結果になる）。
 *
 * ただし、本文を持たない古い形の記録に本文が来たときだけは上書きする。
 * 履歴に本文を写すようにしたのは途中からなので、そうしないと
 * 既に入っている週だけ永久に本文なしのまま残り、重複検出も再放送も効かない。
 */
export function mergeHistory(current, incoming, today, keepDays = KEEP_DAYS) {
    const posts = [...(current?.posts ?? [])];
    const indexById = new Map(posts.map((p, i) => [p.id, i]));

    let added = 0;
    let upgraded = 0;
    for (const post of incoming) {
        const at = indexById.get(post.id);
        if (at === undefined) {
            indexById.set(post.id, posts.length);
            posts.push(post);
            added += 1;
            continue;
        }
        if (!posts[at].body && post.body) {
            posts[at] = { ...posts[at], ...post };
            upgraded += 1;
        }
    }

    const cutoff = shiftDays(today, -keepDays);
    const kept = posts.filter((p) => p.date >= cutoff);
    kept.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1));

    return { posts: kept, added, upgraded, dropped: posts.length - kept.length };
}

/**
 * 保持期間より古い中間ファイル（週ごとの下書き・note・話題）を選ぶ。
 *
 * 消す処理がどこにも無く、週に3〜4ファイルずつ増えつづけていた。
 * 本文は履歴（data/history.json）に写してあるので、ここを消しても
 * 重複検出も再放送も効きつづける。
 *
 * @param {string[]} weekIds  data/ に置いてある週ID
 * @param {string} today      JST の 'YYYY-MM-DD'
 * @returns {string[]} 消してよい週ID
 */
export function selectPrunableWeeks(weekIds, today, keepWeeks = KEEP_WEEKS) {
    const cutoff = shiftDays(today, -keepWeeks * 7);
    return weekIds.filter((weekId) => {
        const m = /^(\d{4})-W(\d{2})$/.exec(weekId);
        if (!m) return false; // 形が違うものには触れない
        // その週の日曜（最終日）で判定する。週の途中で切らない。
        const lastDay = weekDatesOfIsoWeek(Number(m[1]), Number(m[2]))[6];
        return lastDay < cutoff;
    });
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
    const { posts, added, upgraded, dropped } = mergeHistory(current, incoming, today);

    info(`   週 ${weeks.length} 件を確認 → 新たに ${added} 件を履歴へ / ${KEEP_DAYS} 日より古い ${dropped} 件を落としました`);
    if (upgraded > 0) info(`   本文を持っていなかった ${upgraded} 件に本文を補いました`);
    info(`   履歴の合計: ${posts.length} 件（本文あり ${posts.filter((p) => p.body).length} 件）`);

    // ── 古い中間ファイルを消す ──
    // 本文は履歴に写してあるので、消しても重複検出と再放送は効きつづける。
    const prunable = selectPrunableWeeks(knownWeekIds(), today);
    const files = prunable.flatMap((weekId) => [
        paths.data('queue', `${weekId}.json`),
        paths.data('note', `${weekId}.json`),
        paths.data('note', `${weekId}.md`),
        paths.data('trends', `${weekId}.json`),
    ]).filter((f) => fs.existsSync(f));

    if (files.length > 0) {
        info(`   ${KEEP_WEEKS} 週より古い ${prunable.length} 週ぶん（${files.length} ファイル）を消します`);
    }

    const nothingChanged = added === 0 && upgraded === 0 && dropped === 0 && files.length === 0;
    if (nothingChanged && fs.existsSync(paths.data('history.json'))) {
        info('   変更はありません');
        return;
    }

    if (args['dry-run']) {
        info('\n--dry-run なので保存も削除もしません。');
        for (const f of files) info(`     消す予定: ${rel(f)}`);
        return;
    }

    writeJson(paths.data('history.json'), { version: 1, updatedAtJst: jstStamp(), posts });
    info(`   ${rel(paths.data('history.json'))} を更新しました`);

    for (const f of files) {
        fs.rmSync(f);
        info(`   消しました: ${rel(f)}`);
    }
}

/** data/ に置いてある週ID（queue / note / trends のどこかにあるもの）。 */
function knownWeekIds() {
    const ids = new Set();
    for (const dir of ['queue', 'note', 'trends']) {
        const at = paths.data(dir);
        if (!fs.existsSync(at)) continue;
        for (const name of fs.readdirSync(at)) {
            const m = /^(\d{4}-W\d{2})\.(json|md)$/.exec(name);
            if (m) ids.add(m[1]);
        }
    }
    return [...ids];
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (error) {
        failWith(error);
    }
}
