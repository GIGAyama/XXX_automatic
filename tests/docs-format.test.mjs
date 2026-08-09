/**
 * 画面に出す文字列の組み立て。
 *
 * note のカードは「タイトル」と「本文の頭」を上下に並べる。
 * 貼り付ける本文（plain）は1行目がタイトルなので、そのまま切り出すと
 * まったく同じ文が2回並ぶ。実際にそう出ていた。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { bodyPreview, overLimitMessage, stepGuide, truncate } from '../docs/lib/format.js';

test('本文の頭には、タイトルの続きから出す', () => {
    const title = '教室で使えるかもしれないもの作り #◯ 「なぞれた」で終わらせない。';
    const plain = `${title}\n\n🏫 はじめに\n\n漢字の丸付けをしていて、`;

    const preview = bodyPreview(title, plain);
    assert.ok(!preview.startsWith('教室で使えるかもしれない'), 'カードにタイトルが2回並んでしまう');
    assert.ok(preview.startsWith('🏫 はじめに'));
});

test('本文がタイトルで始まっていなければ、そのまま出す', () => {
    // 手で書きかえた記事など、必ずしも1行目がタイトルとは限らない。
    assert.equal(bodyPreview('タイトル', 'まったく別の書き出し。'), 'まったく別の書き出し。');
    assert.equal(bodyPreview('', 'タイトルが無いとき。'), 'タイトルが無いとき。');
    assert.equal(bodyPreview('タイトル', ''), '');
});

test('長い本文は切って「…」を付ける', () => {
    assert.equal(bodyPreview('', 'あ'.repeat(200)).length, 161);
    assert.equal(truncate('あいうえお', 3), 'あいう…');
    assert.equal(truncate('あいう', 3), 'あいう');
});

test('何字オーバーかを添えて言う（「長すぎます」だけでは直しようがない）', () => {
    assert.equal(
        overLimitMessage(300, 280),
        '280 文字を超えています（20 字オーバー）。このままだと X で投稿できません。'
    );
});

test('連投の案内は、なぜ2回に分けるのかまで言う', () => {
    // 理由が分からないと、面倒になって1回でやめてしまう。
    assert.match(stepGuide({ kind: 'main' }, 0, 2), /このあと 1 回/);
    assert.match(stepGuide({ kind: 'url' }, 1, 2), /本文にリンクを入れると表示されにくくなる/);
});
