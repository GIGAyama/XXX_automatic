/**
 * 「どのタブに何を出すか」と「上のひとことに何と書くか」の検証。
 *
 * ここがずれると、一覧に2件並んでいるのに「今日はあと1件」と出る、
 * まだ一度も投稿していないのに「今日出すぶんは終わりました」と出る、
 * といった食い違いが起きる。どちらも実際に起きていた。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyMessageFor, selectPosts, summaryOf, todaysPool, unsentRatings } from '../docs/lib/select.js';

const WEEK = '2026-W33';
const PAST = '2026-W32';

function post(id, date, extra = {}) {
    return {
        id,
        weekId: WEEK,
        date,
        hour: 7,
        slot: 'morning',
        slotLabel: '朝',
        repo: 'Typa',
        theme: 'intro',
        themeLabel: 'アプリ紹介',
        text: 'ほんぶん',
        ...extra,
    };
}

const active = new Set([WEEK]);

test('今日タブは「今日以前・未投稿」を出す', () => {
    const posts = [post('a', '2026-08-09'), post('b', '2026-08-10'), post('c', '2026-08-11')];
    const got = selectPosts({ posts, state: {}, view: 'today', today: '2026-08-10', activeWeeks: active });
    assert.deepEqual(got.map((p) => p.id), ['a', 'b']);
});

test('投稿ずみにしたものは今日タブから消える', () => {
    const posts = [post('a', '2026-08-09'), post('b', '2026-08-10')];
    const state = { a: { done: true } };
    const got = selectPosts({ posts, state, view: 'today', today: '2026-08-10', activeWeeks: active });
    assert.deepEqual(got.map((p) => p.id), ['b']);
});

test('サマリと今日タブが同じ母数を数える（前日の出し忘れを含む）', () => {
    // 以前はサマリが date === today、一覧が date <= today を見ていて、
    // 前日ぶんが残っていると数が食い違った。
    const posts = [post('a', '2026-08-09'), post('b', '2026-08-10')];
    const shown = selectPosts({ posts, state: {}, view: 'today', today: '2026-08-10', activeWeeks: active });
    const summary = summaryOf({ posts, state: {}, today: '2026-08-10', activeWeeks: active });
    assert.equal(shown.length, 2);
    assert.match(summary, /あと 2 件/);
});

test('今日ぶんの割当が無いときは「終わりました」と言わず、次の予定を出す', () => {
    // 日曜の夜に翌週ぶんだけができた直後がこの状態。
    // ここで「おつかれさまでした」と出すのは、まだ何もしていない人に対して嘘になる。
    const posts = [post('a', '2026-08-10'), post('b', '2026-08-11')];
    const message = emptyMessageFor({ view: 'today', posts, state: {}, today: '2026-08-07', activeWeeks: active });
    assert.doesNotMatch(message, /終わりました/);
    assert.match(message, /8\/10/);

    const summary = summaryOf({ posts, state: {}, today: '2026-08-07', activeWeeks: active });
    assert.match(summary, /次は 8\/10/);
});

test('今日ぶんを全部出し終えたときだけ「終わりました」と出す', () => {
    const posts = [post('a', '2026-08-10')];
    const state = { a: { done: true } };
    const message = emptyMessageFor({ view: 'today', posts, state, today: '2026-08-10', activeWeeks: active });
    assert.match(message, /終わりました/);
});

test('下書きが1件も無いときは、その旨を出す', () => {
    const message = emptyMessageFor({ view: 'today', posts: [], state: {}, today: '2026-08-10', activeWeeks: active });
    assert.match(message, /下書きがまだありません/);
});

test('あすが次の予定なら「あす」と書く', () => {
    const posts = [post('a', '2026-08-11')];
    const message = emptyMessageFor({ view: 'today', posts, state: {}, today: '2026-08-10', activeWeeks: active });
    assert.match(message, /あす/);
});

test('過去タブは今週ぶんに入っていない週を出す', () => {
    const posts = [post('a', '2026-08-10'), post('old', '2026-08-03', { weekId: PAST })];
    const got = selectPosts({ posts, state: {}, view: 'past', today: '2026-08-10', activeWeeks: active });
    assert.deepEqual(got.map((p) => p.id), ['old']);

    // 今週ぶんのタブには過去週が混ざらない
    const week = selectPosts({ posts, state: {}, view: 'week', today: '2026-08-10', activeWeeks: active });
    assert.deepEqual(week.map((p) => p.id), ['a']);
});

test('投稿ずみタブは過去週のものも残す（反応を記録するため）', () => {
    const posts = [post('a', '2026-08-10'), post('old', '2026-08-03', { weekId: PAST })];
    const state = { a: { done: true }, old: { done: true } };
    const got = selectPosts({ posts, state, view: 'done', today: '2026-08-10', activeWeeks: active });
    assert.deepEqual(got.map((p) => p.id), ['a', 'old']); // 新しい順
});

test('todaysPool は投稿ずみも含む母数を返す', () => {
    const posts = [post('a', '2026-08-09'), post('b', '2026-08-11')];
    assert.equal(todaysPool({ posts, today: '2026-08-10', activeWeeks: active }).length, 1);
});

test('未送信の評価だけを集める', () => {
    const posts = [post('a', '2026-08-10'), post('b', '2026-08-11')];
    const state = {
        a: { done: true, rating: 'good' },
        b: { done: true, rating: 'bad', sent: true },
    };
    const got = unsentRatings({ posts, state });
    assert.deepEqual(got.map((e) => e.id), ['a']);
    assert.equal(got[0].theme, 'intro');
    assert.equal(got[0].repo, 'Typa');
});

test('launcher.json から消えた投稿でも、控えてある情報から送れる', () => {
    // 評価を押したあと週が入れかわると、post が見つからなくなる。
    // そこで取りこぼすと、記録した意味が消える。
    const state = {
        'zzz-2026-01-01-morning': {
            done: true,
            rating: 'good',
            repo: 'Qalc',
            theme: 'pain',
            date: '2026-01-01',
            weekId: '2026-W01',
        },
    };
    const got = unsentRatings({ posts: [], state });
    assert.equal(got.length, 1);
    assert.equal(got[0].repo, 'Qalc');
});

test('手がかりが足りない記録は送らない（壊れた入力を投げ返さない）', () => {
    const state = { broken: { done: true, rating: 'good' } };
    assert.equal(unsentRatings({ posts: [], state }).length, 0);
});
