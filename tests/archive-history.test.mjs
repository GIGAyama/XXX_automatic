/**
 * 終わった週を履歴に移す部分の検証。
 *
 * いちばん大事なのは境目の1つ。週次ワークフローは日曜 20:00 JST に走る。
 * この瞬間、今週（月〜日）の最終日は「今日」である。
 * 判定を < にすると今週が履歴に入らないまま翌週を組むことになり、
 * 週をまたいだ重複回避が効かない。<= であることを固定する。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { KEEP_DAYS, mergeHistory, selectArchivable } from '../scripts/archive-history.mjs';

function week(weekId, monday) {
    const dates = Array.from({ length: 7 }, (_, i) => shift(monday, i));
    return {
        weekId,
        dates,
        posts: dates.flatMap((date, i) => [
            { id: `${date}-morning`, date, repo: `Repo${i}`, theme: 'intro', slot: 'morning' },
            { id: `${date}-evening`, date, repo: `Repo${i}b`, theme: 'pain', slot: 'evening' },
        ]),
    };
}

function shift(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    at.setUTCDate(at.getUTCDate() + n);
    const pad = (v) => String(v).padStart(2, '0');
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

const W33 = week('2026-W33', '2026-08-10'); // 月 8/10 〜 日 8/16
const W34 = week('2026-W34', '2026-08-17');

test('最終日が今日と同じ週も履歴に入る（日曜の夜に走るため）', () => {
    // ここが < だと、日曜 20:00 に走ったとき今週が入らない。
    const got = selectArchivable([W33], '2026-08-16');
    assert.equal(got.length, 14);
});

test('まだ終わっていない週は入れない', () => {
    assert.equal(selectArchivable([W33], '2026-08-15').length, 0);
    assert.equal(selectArchivable([W33, W34], '2026-08-16').length, 14); // W34 は入らない
});

test('終わった週が複数あればまとめて入る', () => {
    assert.equal(selectArchivable([W33, W34], '2026-08-23').length, 28);
});

test('dates が無い週は飛ばす（壊れた入力で落ちない）', () => {
    assert.equal(selectArchivable([{ weekId: 'x', posts: [] }], '2026-08-16').length, 0);
});

test('残すのは id / date / weekId / repo / theme / slot だけ', () => {
    const [first] = selectArchivable([W33], '2026-08-16');
    assert.deepEqual(Object.keys(first).sort(), ['date', 'id', 'repo', 'slot', 'theme', 'weekId']);
});

test('同じ週を二度流しても増えない（何度走らせても同じ結果になる）', () => {
    const incoming = selectArchivable([W33], '2026-08-16');
    const once = mergeHistory({ posts: [] }, incoming, '2026-08-16');
    const twice = mergeHistory({ posts: once.posts }, incoming, '2026-08-16');
    assert.equal(once.added, 14);
    assert.equal(twice.added, 0);
    assert.equal(twice.posts.length, 14);
});

test('保持期間より古いものは落ちる', () => {
    const old = [{ id: 'old', date: '2025-01-01', weekId: '2025-W01', repo: 'A', theme: 'intro', slot: 'morning' }];
    const { posts, dropped } = mergeHistory({ posts: old }, [], '2026-08-16');
    assert.equal(dropped, 1);
    assert.equal(posts.length, 0);
});

test('保持期間の内側にあるものは残る', () => {
    const inside = shift('2026-08-16', -(KEEP_DAYS - 1));
    const kept = [{ id: 'x', date: inside, weekId: '2026-W20', repo: 'A', theme: 'intro', slot: 'morning' }];
    const { posts, dropped } = mergeHistory({ posts: kept }, [], '2026-08-16');
    assert.equal(dropped, 0);
    assert.equal(posts.length, 1);
});

test('履歴は新しい順に並ぶ', () => {
    const { posts } = mergeHistory({ posts: [] }, selectArchivable([W33, W34], '2026-08-23'), '2026-08-23');
    for (let i = 1; i < posts.length; i += 1) {
        assert.ok(posts[i - 1].date >= posts[i].date);
    }
});

test('履歴が無い状態から始められる', () => {
    const { posts, added } = mergeHistory(null, selectArchivable([W33], '2026-08-16'), '2026-08-16');
    assert.equal(added, 14);
    assert.equal(posts.length, 14);
});
