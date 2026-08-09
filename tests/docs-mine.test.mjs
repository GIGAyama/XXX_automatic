/**
 * ［つくる］で作らせた投稿の保管庫（ランチャー側）。
 *
 * ここに入っているものは、この端末のなかにしか無い。
 * 週の投稿と違って毎週やってこないので、取りこぼすと本当に消える。
 * ブラウザを立てずに確かめられる形にしてある。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DONE,
    FAILED,
    MAX_POSTS,
    WAITING,
    addOrder,
    addPosts,
    dropOrder,
    dropPost,
    emptyMine,
    fromBackupText,
    minePosts,
    normalizeMine,
    patchOrder,
    repoCounts,
    toBackupText,
    waitingOrders,
} from '../docs/lib/mine.js';

const aPost = (id, repo = 'Qalc') => ({
    id,
    repo,
    theme: 'pain',
    themeLabel: '困りごと→解決',
    slot: 'promo',
    slotLabel: 'つくった投稿',
    date: '2026-08-09',
    steps: [{ kind: 'main', label: '本文', text: `本文 ${id}` }],
});

const anOrder = (id, patch = {}) => ({ id, repo: 'Qalc', count: 3, themes: [], note: '', state: WAITING, ...patch });

/* ── 形をととのえる ─────────────────────────── */

test('壊れていても読める部分だけ拾う', () => {
    const store = normalizeMine({
        orders: [anOrder('ord-a'), null, { なまえがない: true }],
        posts: [aPost('a'), null, { id: 'b' }, 'ちがう', aPost('c')],
    });
    assert.equal(store.orders.length, 1);
    // steps を持たないものは投稿として使えない（画面が描けない）ので落とす
    assert.deepEqual(store.posts.map((p) => p.id), ['a', 'c']);
});

test('null や壊れた JSON からでも空の形が返る', () => {
    assert.deepEqual(normalizeMine(null), emptyMine());
    assert.deepEqual(normalizeMine('こわれている'), emptyMine());
});

/* ── 注文 ──────────────────────────────────── */

test('注文を控えて、状態を書きかえられる', () => {
    let store = addOrder(emptyMine(), anOrder('ord-a'));
    store = addOrder(store, anOrder('ord-b'));
    assert.equal(waitingOrders(store).length, 2);

    store = patchOrder(store, 'ord-a', { state: DONE });
    assert.deepEqual(waitingOrders(store).map((o) => o.id), ['ord-b']);

    store = patchOrder(store, 'ord-b', { state: FAILED, message: 'だめでした' });
    assert.equal(waitingOrders(store).length, 0);
    assert.equal(store.orders.find((o) => o.id === 'ord-b').message, 'だめでした');
});

test('同じ注文を二度控えない', () => {
    let store = addOrder(emptyMine(), anOrder('ord-a'));
    store = addOrder(store, anOrder('ord-a', { count: 5 }));
    assert.equal(store.orders.length, 1);
    assert.equal(store.orders[0].count, 5);
});

test('取り消した注文にあとから結果が届いても壊れない', () => {
    let store = addOrder(emptyMine(), anOrder('ord-a'));
    store = dropOrder(store, 'ord-a');
    assert.doesNotThrow(() => patchOrder(store, 'ord-a', { state: DONE }));
    assert.equal(store.orders.length, 0);
});

/* ── 投稿 ──────────────────────────────────── */

test('届いた投稿を貯める。二度目は足さない', () => {
    const gallery = [{ id: 'card:0', src: 'media/Qalc-card.png', kind: 'card', label: '紹介カード' }];
    let { store, added } = addPosts(emptyMine(), [aPost('a'), aPost('b')], { orderId: 'ord-a', gallery, gotAtJst: 'いま' });
    assert.equal(added, 2);
    assert.equal(store.posts[0].source, 'order');
    assert.equal(store.posts[0].orderId, 'ord-a');
    // 添付候補を投稿ごとに抱えておく。launcher.json の galleries には載っていないため。
    assert.deepEqual(store.posts[0].gallery, gallery);

    ({ store, added } = addPosts(store, [aPost('a'), aPost('c')], { orderId: 'ord-b' }));
    assert.equal(added, 1);
    assert.deepEqual(store.posts.map((p) => p.id), ['c', 'a', 'b']);
    // 先に届いていたぶんの注文IDが、あとから来た注文で上書きされない
    assert.equal(store.posts.find((p) => p.id === 'a').orderId, 'ord-a');
});

test('上限を超えたら古いほうから落ちる', () => {
    const many = Array.from({ length: MAX_POSTS + 10 }, (_, i) => aPost(`p${i}`));
    const { store } = addPosts(emptyMine(), many);
    assert.equal(store.posts.length, MAX_POSTS);
});

test('消せる', () => {
    const { store } = addPosts(emptyMine(), [aPost('a'), aPost('b')]);
    assert.deepEqual(dropPost(store, 'a').posts.map((p) => p.id), ['b']);
    // 無いものを消しても壊れない
    assert.equal(dropPost(store, 'ない').posts.length, 2);
});

/* ── 並べる ────────────────────────────────── */

test('出していないものを先に出す', () => {
    const { store } = addPosts(emptyMine(), [aPost('a'), aPost('b'), aPost('c')]);
    const order = minePosts(store, { isDone: (id) => id === 'a' }).map((p) => p.id);
    assert.deepEqual(order, ['b', 'c', 'a']);
});

test('アプリで絞りこめる', () => {
    const { store } = addPosts(emptyMine(), [aPost('a', 'Qalc'), aPost('b', 'Typa'), aPost('c', 'Qalc')]);
    assert.deepEqual(minePosts(store, { repo: 'Qalc' }).map((p) => p.id), ['a', 'c']);
    assert.deepEqual(repoCounts(store), [['Qalc', 2], ['Typa', 1]]);
});

/* ── 書き出しと読みこみ ───────────────────────── */

test('書き出して、別の端末で読みこめる', () => {
    const { store } = addPosts(emptyMine(), [aPost('a'), aPost('b')], { orderId: 'ord-a', gotAtJst: '2026-08-09 10:00 JST' });
    const text = toBackupText(store);

    const { store: other, added, error } = fromBackupText(emptyMine(), text);
    assert.equal(error, null);
    assert.equal(added, 2);
    assert.deepEqual(other.posts.map((p) => p.id), ['a', 'b']);
    // どこから来た投稿かを、読みこみで失わない
    assert.equal(other.posts[0].orderId, 'ord-a');
    assert.equal(other.posts[0].gotAtJst, '2026-08-09 10:00 JST');
});

test('読みこみは置きかえではなく足しこみ（2台ぶんをまとめられる）', () => {
    const { store: a } = addPosts(emptyMine(), [aPost('a')]);
    const { store: b } = addPosts(emptyMine(), [aPost('b')]);
    const { store: merged, added } = fromBackupText(a, toBackupText(b));
    assert.equal(added, 1);
    assert.deepEqual(merged.posts.map((p) => p.id).sort(), ['a', 'b']);
});

test('よそのファイルは読みこまない', () => {
    for (const bad of ['{}', 'ただの文', '{"kind":"よそ","posts":[]}', '[]']) {
        const { added, error } = fromBackupText(emptyMine(), bad);
        assert.equal(added, 0);
        assert.ok(error, `理由を返すこと: ${bad}`);
    }
});

test('読みこんでも、いま持っているものは消えない', () => {
    const { store } = addPosts(emptyMine(), [aPost('a')]);
    const { store: after } = fromBackupText(store, '{"kind":"launcher:mine:v1","posts":[]}');
    assert.deepEqual(after.posts.map((p) => p.id), ['a']);
});
