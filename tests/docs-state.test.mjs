/**
 * 端末に残す記録の手入れ。
 *
 * 放っておくと localStorage が無限に伸びる。かといって機械的に消すと、
 * まだ送っていない評価を送る前に捨ててしまう。その線引きを固定する。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPatch, pruneState, traceOf } from '../docs/lib/state.js';

const NOW = new Date('2026-08-10T00:00:00Z');

test('applyPatch は既存の値を保ったまま書き足す', () => {
    const a = applyPatch({}, 'x', { done: true }, NOW);
    const b = applyPatch(a, 'x', { rating: 'good' }, NOW);
    assert.equal(b.x.done, true);
    assert.equal(b.x.rating, 'good');
    assert.match(b.x.atJst, /^2026-08-10 09:00 JST$/);
});

test('applyPatch は元の state を書き換えない', () => {
    const before = { x: { done: true } };
    applyPatch(before, 'x', { rating: 'good' }, NOW);
    assert.equal(before.x.rating, undefined);
});

test('null を渡した項目は消える（評価の押し直し）', () => {
    const a = applyPatch({}, 'x', { rating: 'good', sent: true }, NOW);
    const b = applyPatch(a, 'x', { rating: null, sent: null }, NOW);
    assert.equal('rating' in b.x, false);
    assert.equal('sent' in b.x, false);
});

test('画面に出ている投稿の記録は、どれだけ古くても残す', () => {
    const state = { 'old-1': { done: true, date: '2020-01-01' } };
    const { state: kept, removed } = pruneState(state, { keepIds: ['old-1'], today: '2026-08-10' });
    assert.equal(removed, 0);
    assert.ok(kept['old-1']);
});

test('まだ送っていない評価は、古くても残す', () => {
    // 送る前に消すと、記録した意味そのものが消える。
    const state = { 'x-1': { done: true, rating: 'good', date: '2024-01-01' } };
    const { state: kept, removed } = pruneState(state, { keepIds: [], today: '2026-08-10' });
    assert.equal(removed, 0);
    assert.ok(kept['x-1']);
});

test('送りずみで古い記録は捨てる', () => {
    const state = { 'x-1': { done: true, rating: 'good', sent: true, date: '2024-01-01' } };
    const { state: kept, removed } = pruneState(state, { keepIds: [], today: '2026-08-10' });
    assert.equal(removed, 1);
    assert.equal(kept['x-1'], undefined);
});

test('60日以内なら残す', () => {
    const state = { 'x-1': { done: true, sent: true, date: '2026-07-15' } };
    const { removed } = pruneState(state, { keepIds: [], today: '2026-08-10' });
    assert.equal(removed, 0);
});

test('date が無くても ID から日付を読み取る', () => {
    const state = { '2024-01-01-morning': { done: true } };
    const { removed } = pruneState(state, { keepIds: [], today: '2026-08-10' });
    assert.equal(removed, 1);
});

test('日付の手がかりが無い記録は捨てない（note-2026-W33 など）', () => {
    // 消すか残すか分からないものは残す。誤って消すほうが害が大きい。
    const state = { 'note-2026-W33': { done: true } };
    const { removed } = pruneState(state, { keepIds: [], today: '2026-08-10' });
    assert.equal(removed, 0);
});

test('壊れた値は捨てる（画面を守るため）', () => {
    const state = { a: null, b: 'こわれている', c: { done: true, date: '2026-08-09' } };
    const { state: kept, removed } = pruneState(state, { keepIds: [], today: '2026-08-10' });
    assert.equal(removed, 2);
    assert.deepEqual(Object.keys(kept), ['c']);
});

test('traceOf は評価を送るのに要る項目だけを抜き出す', () => {
    const trace = traceOf({ id: 'x', repo: 'Typa', theme: 'intro', date: '2026-08-10', weekId: '2026-W33', text: '長い本文' });
    assert.deepEqual(trace, { repo: 'Typa', theme: 'intro', date: '2026-08-10', weekId: '2026-W33' });
});
