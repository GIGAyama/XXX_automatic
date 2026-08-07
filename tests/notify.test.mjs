/**
 * 通知の後片づけ。
 *
 * 毎日の知らせは 1日2枠 × 365日で、年に730件たまる。
 * 閉じないと Issue の一覧が使いものにならなくなり、
 * 「週次の失敗」や「反応の記録」のような、開いていることに意味がある知らせが埋もれる。
 *
 * ⚠️ ここで見るのは「閉じてよいものだけを閉じるか」である。
 *    機械が Issue を閉じる処理なので、判定がゆるいと人の立てた Issue まで消える。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldClose } from '../scripts/notify-daily.mjs';

const STAMP = (date) => `本文です。\n\n<!-- notify-daily ${date} -->`;

test('きのうまでの知らせは閉じる', () => {
    assert.equal(shouldClose(STAMP('2026-08-09'), '2026-08-10'), true);
    assert.equal(shouldClose(STAMP('2026-07-01'), '2026-08-10'), true);
});

test('今日の知らせは閉じない', () => {
    // 朝の知らせは、夜の知らせが立ったあとも
    // 「今日まだ出していないもの」を見るために開いていてほしい。
    assert.equal(shouldClose(STAMP('2026-08-10'), '2026-08-10'), false);
});

test('あすの知らせは閉じない（手で先に立てた場合）', () => {
    assert.equal(shouldClose(STAMP('2026-08-11'), '2026-08-10'), false);
});

test('目印を持たないものは閉じない', () => {
    // この仕組みより前に立てた知らせや、人が手で立てた Issue に
    // 同じラベルが付いていることがある。機械が消してよいのは、
    // 機械が立てたと分かるものだけである。
    assert.equal(shouldClose('ふつうの Issue の本文です。', '2026-08-10'), false);
    assert.equal(shouldClose('', '2026-08-10'), false);
    assert.equal(shouldClose(null, '2026-08-10'), false);
    assert.equal(shouldClose(undefined, '2026-08-10'), false);
});

test('目印の形が違うものは閉じない', () => {
    assert.equal(shouldClose('<!-- notify-daily きのう -->', '2026-08-10'), false);
    assert.equal(shouldClose('<!-- notify-weekly 2026-08-09 -->', '2026-08-10'), false);
    assert.equal(shouldClose('notify-daily 2026-08-09', '2026-08-10'), false);
});

test('年をまたいでも正しく比べる', () => {
    // タイトル（【8/10（月）朝】…）には年が入っていない。
    // そこから読み取る形にすると、ここが必ず壊れる。
    assert.equal(shouldClose(STAMP('2026-12-31'), '2027-01-01'), true);
    assert.equal(shouldClose(STAMP('2027-01-01'), '2026-12-31'), false);
});
