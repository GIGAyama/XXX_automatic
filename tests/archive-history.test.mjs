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

import { KEEP_DAYS, mergeHistory, selectArchivable, selectPrunableWeeks } from '../scripts/archive-history.mjs';

function week(weekId, monday) {
    const dates = Array.from({ length: 7 }, (_, i) => shift(monday, i));
    return {
        weekId,
        dates,
        posts: dates.flatMap((date, i) => [
            {
                id: `${date}-morning`,
                date,
                repo: `Repo${i}`,
                theme: 'intro',
                slot: 'morning',
                body: `ほんぶん${i}`,
                hook: 'scene',
                hashtags: ['小学校'],
                url: `https://gigayama.github.io/Repo${i}/`,
                alternatives: [{ body: `べつの案${i}`, thread: [] }],
            },
            {
                id: `${date}-evening`,
                date,
                repo: `Repo${i}b`,
                theme: 'pain',
                slot: 'evening',
                body: `よるのほんぶん${i}`,
                hook: 'confess',
                hashtags: [],
                url: `https://gigayama.github.io/Repo${i}b/`,
                alternatives: [],
            },
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

test('本文・フック・落選案まで写す', () => {
    // 以前は id / date / repo / theme / slot だけだった。そのため
    //   ・週をまたいだ「同じ言い回し」を機械で防げない
    //   ・反応がよかった投稿を出し直す材料が data/queue/ にしか無い
    //   ・その data/queue/ を消せない（消すと上の2つができなくなる）
    // という3つが同時に詰んでいた。本文を持たせると、まとめて解ける。
    const [first] = selectArchivable([W33], '2026-08-16');
    assert.deepEqual(
        Object.keys(first).sort(),
        ['alternatives', 'body', 'date', 'hashtags', 'hook', 'id', 'repo', 'slot', 'theme', 'url', 'weekId']
    );
    assert.equal(first.body, 'ほんぶん0');
    assert.equal(first.hook, 'scene');
    assert.equal(first.alternatives.length, 1);
});

test('本文を持たない古い週でも落ちない', () => {
    // data/queue/ には、本文を残していなかったころの週が残っている。
    const old = { weekId: '2026-W20', dates: ['2026-05-11'], posts: [{ id: 'x', date: '2026-05-11', repo: 'R', theme: 'intro', slot: 'morning' }] };
    const [entry] = selectArchivable([old], '2026-08-16');
    assert.equal(entry.body, null);
    assert.deepEqual(entry.alternatives, []);
});

test('本文を持たない記録に、あとから本文が来たら上書きする', () => {
    // 履歴に本文を写すようにしたのは途中から。上書きしないと、
    // 既に入っている週だけ永久に本文なしのまま残り、重複検出も再放送も効かない。
    const old = { posts: [{ id: '2026-08-10-morning', date: '2026-08-10', repo: 'Repo0', theme: 'intro', slot: 'morning' }] };
    const incoming = selectArchivable([W33], '2026-08-16');
    const { posts, added, upgraded } = mergeHistory(old, incoming, '2026-08-16');

    assert.equal(added, 13, '残り13件は新規');
    assert.equal(upgraded, 1);
    assert.equal(posts.find((p) => p.id === '2026-08-10-morning').body, 'ほんぶん0');
    assert.equal(posts.length, 14, '件数は増えない');
});

test('落選案は2件までしか残さない（履歴が太りすぎないように）', () => {
    const many = {
        weekId: '2026-W20',
        dates: ['2026-05-11'],
        posts: [
            {
                id: 'x',
                date: '2026-05-11',
                repo: 'R',
                theme: 'intro',
                slot: 'morning',
                body: 'ほんぶん',
                alternatives: [{ body: 'a' }, { body: 'b' }, { body: 'c' }, { body: 'd' }],
            },
        ],
    };
    assert.equal(selectArchivable([many], '2026-08-16')[0].alternatives.length, 2);
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

/* ── 古い中間ファイルの掃除 ─────────────────────
 *
 * data/queue・data/note・data/trends には消す処理がどこにも無く、
 * 週に3〜4ファイルずつ増えつづけていた。
 * 本文は履歴に写してあるので、消しても重複検出も再放送も効きつづける。 */

test('保持期間より古い週だけを消す', () => {
    const weeks = ['2026-W33', '2026-W20', '2026-W05', '2025-W40'];
    // 基準日 2026-08-16 から 26 週前は 2026-02-15 あたり
    const prunable = selectPrunableWeeks(weeks, '2026-08-16');
    assert.deepEqual(prunable.sort(), ['2025-W40', '2026-W05']);
});

test('いま使っている週は消さない', () => {
    // ランチャーは過去3週ぶんを載せる。再放送は履歴（90日）から拾う。
    // どちらにも余裕があることを固定しておく。
    const prunable = selectPrunableWeeks(['2026-W33', '2026-W32', '2026-W31', '2026-W30'], '2026-08-16');
    assert.deepEqual(prunable, []);
});

test('週IDの形をしていないものには触れない', () => {
    assert.deepEqual(selectPrunableWeeks(['まちがい', '', 'history'], '2026-08-16'), []);
});

test('保持週数を変えられる', () => {
    assert.deepEqual(selectPrunableWeeks(['2026-W30'], '2026-08-16', 1), ['2026-W30']);
    assert.deepEqual(selectPrunableWeeks(['2026-W30'], '2026-08-16', 52), []);
});
