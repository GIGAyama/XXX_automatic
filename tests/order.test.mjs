/**
 * 宣伝ポストの注文の形。
 *
 * ここが崩れると2種類の壊れ方をする。
 *   ① 注文がワークフローに届かない（頼んだのに何も起きない）
 *   ② 注文IDがそのままファイル名になるので、変な文字列を通すと
 *      リポジトリの意図しない場所に書きこめてしまう
 * ②は Issue が誰でも立てられる以上、必ず塞いでおく必要がある。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_COUNT,
    ISSUE_LABEL,
    MAX_COUNT,
    MAX_NOTE_CHARS,
    MAX_THEMES,
    MIN_COUNT,
    ORDER_ID_RE,
    RESULT_SCHEMA_ID,
    SCHEMA_ID,
    buildOrder,
    buildOrderIssueUrl,
    clampCount,
    extractOrder,
    newOrderId,
    resultPathOf,
    validateOrder,
    validateResult,
} from '../docs/lib/order.js';

const REPOS = ['Qalc', 'KANJI_Town'];
const THEMES = ['intro', 'pain', 'tips'];

function anOrder(patch = {}) {
    return buildOrder({ orderId: 'ord-abcd1234', repo: 'Qalc', count: 3, themes: ['pain'], note: 'ひとこと', ...patch });
}

test('注文を Issue の本文に載せて、そのまま読み戻せる', () => {
    const order = anOrder();
    const url = buildOrderIssueUrl('https://github.com/GIGAyama/XXX_automatic', order, {
        themeLabels: { pain: '困りごと→解決' },
    });

    assert.ok(url.startsWith('https://github.com/GIGAyama/XXX_automatic/issues/new?'));
    const body = new URL(url).searchParams.get('body');
    assert.equal(new URL(url).searchParams.get('labels'), ISSUE_LABEL);
    // 人が読める要約が、送信ボタンを押す前に見えること
    assert.match(body, /困りごと→解決/);
    assert.match(body, /\*\*3 本\*\*/);

    assert.deepEqual(extractOrder(body), order);
});

test('切り口を書かなくても本文になる', () => {
    const body = new URL(buildOrderIssueUrl('https://x/y', anOrder({ note: '' }))).searchParams.get('body');
    assert.ok(!body.includes('切り口'));
    assert.equal(extractOrder(body).note, '');
});

test('機械向けのブロックが無ければ null', () => {
    assert.equal(extractOrder('ふつうの Issue です'), null);
    assert.equal(extractOrder('```json ' + SCHEMA_ID + '\n{こわれた\n```'), null);
    assert.equal(extractOrder(null), null);
});

test('本数は決めた範囲に丸める', () => {
    assert.equal(clampCount(0), MIN_COUNT);
    assert.equal(clampCount(99), MAX_COUNT);
    assert.equal(clampCount('4'), 4);
    assert.equal(clampCount('あ'), DEFAULT_COUNT);
});

test('型は重複を落として上限までにする', () => {
    const order = buildOrder({ orderId: 'ord-abcd1234', repo: 'Qalc', themes: ['a', 'a', 'b', 'c', 'd', 'e'] });
    assert.equal(order.themes.length, MAX_THEMES);
    assert.deepEqual(order.themes, ['a', 'b', 'c']);
});

test('切り口は長さで切る', () => {
    const order = buildOrder({ orderId: 'ord-abcd1234', repo: 'Qalc', note: 'あ'.repeat(500) });
    assert.equal(order.note.length, MAX_NOTE_CHARS);
});

/* ── 検査 ─────────────────────────────────── */

test('ふつうの注文は通る', () => {
    const { ok, errors } = validateOrder(anOrder(), { repoNames: REPOS, themeIds: THEMES });
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
});

test('知らないアプリ・知らない型は通さない', () => {
    const a = validateOrder(anOrder({ repo: 'よそのアプリ' }), { repoNames: REPOS, themeIds: THEMES });
    assert.equal(a.ok, false);
    assert.match(a.errors.join(), /repo が data\/profiles\//);

    const b = validateOrder(anOrder({ themes: ['のっとり'] }), { repoNames: REPOS, themeIds: THEMES });
    assert.equal(b.ok, false);
    assert.match(b.errors.join(), /config\/themes\.json に無い型/);
});

test('本数が範囲の外なら通さない', () => {
    // buildOrder を通さず、手で書いた（＝外から来た）注文を想定する
    const raw = { ...anOrder(), count: 99 };
    assert.equal(validateOrder(raw, { repoNames: REPOS, themeIds: THEMES }).ok, false);
});

test('注文IDがファイル名として危ない形なら通さない', () => {
    // ⚠️ ここが破れると、Issue を立てるだけでリポジトリの任意の場所に書きこめる。
    for (const bad of [
        '../../../etc/passwd',
        'ord-../../secret',
        'ord-abc/def',
        'ord-ABCD1234', // 大文字は使わない
        'ord-abc', // 短すぎる
        'ord-' + 'a'.repeat(40), // 長すぎる
        '',
        null,
    ]) {
        assert.equal(ORDER_ID_RE.test(String(bad)), false, `通ってはいけない: ${bad}`);
        const { ok } = validateOrder({ ...anOrder(), orderId: bad }, { repoNames: REPOS, themeIds: THEMES });
        assert.equal(ok, false, `検査を通ってはいけない: ${bad}`);
        assert.throws(() => resultPathOf(bad), `パスを組めてはいけない: ${bad}`);
    }
});

test('発行した注文IDは、いつでも自分の検査を通る', () => {
    for (let i = 0; i < 200; i += 1) {
        const id = newOrderId(() => i / 200, 1_770_000_000_000 + i * 97);
        assert.match(id, ORDER_ID_RE, `自分で作った ID が通らない: ${id}`);
        assert.equal(resultPathOf(id), `orders/${id}.json`);
    }
});

test('注文IDは同じ時刻でも重ならない', () => {
    const a = newOrderId(() => 0.11, 1_770_000_000_000);
    const b = newOrderId(() => 0.87, 1_770_000_000_000);
    assert.notEqual(a, b);
});

/* ── 結果の検査 ────────────────────────────── */

const aResult = () => ({
    schema: RESULT_SCHEMA_ID,
    orderId: 'ord-abcd1234',
    posts: [{ id: '2026-08-09-promo-abcd1', steps: [{ kind: 'main', label: '本文', text: 'x' }] }],
});

test('ふつうの結果は通る', () => {
    assert.equal(validateResult(aResult(), { orderId: 'ord-abcd1234' }).ok, true);
});

test('別の注文の結果は受け取らない', () => {
    const { ok, errors } = validateResult(aResult(), { orderId: 'ord-99999999' });
    assert.equal(ok, false);
    assert.match(errors.join(), /別の注文の結果/);
});

test('中身が投稿の形をしていなければ受け取らない', () => {
    assert.equal(validateResult({ ...aResult(), posts: 'ちがう' }).ok, false);
    assert.equal(validateResult({ ...aResult(), posts: [{ id: 'x' }] }).ok, false); // steps が無い
    assert.equal(validateResult({ ...aResult(), schema: 'ほか' }).ok, false);
    // Pages の 404 ページが JSON として読めてしまった、のような取り違えもここで止まる
    assert.equal(validateResult(null).ok, false);
    assert.equal(validateResult('<!doctype html>').ok, false);
});

test('作れなかった（0本）も結果として通す', () => {
    // ここを弾くと、画面が永久に「たのんでいます」のままになる
    const { ok } = validateResult({ ...aResult(), posts: [], message: '検査に落ちました' });
    assert.equal(ok, true);
});
