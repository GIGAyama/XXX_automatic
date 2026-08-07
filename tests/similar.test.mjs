/**
 * 週をまたいだ「同じ言い回し」を見つけられるか。
 *
 * 1回の生成では1週間ぶんをまとめて投げているので、週のなかの重複は AI が避ける。
 * 避けられないのは週をまたいだほうで、しかも履歴に本文が無かったころは
 * 比べる相手すらいなかった。
 *
 * ⚠️ ここで大事なのは「似ているものを見つけられる」ことと同じくらい、
 *    「似ていないものを似ていると言わない」ことである。
 *    同じアプリの話は、書き方を変えても文字が似る。強すぎる判定は
 *    正しい投稿まで落として枠を空ける。両方向を確かめる。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { bigramsOf, mostSimilar, similarity } from '../scripts/lib/similar.mjs';

const A = '漢字の宿題を出しても、丸つけが追いつきませんでした。1クラスぶんで放課後がまるごと消えます。';
// A の言い回しを少し変えただけ。これは見つけたい。
const A2 = '漢字の宿題を出しても丸つけが追いつきません。1クラスぶんで放課後がまるごと消えました。';
// 同じアプリの話だが、切り口がちがう。これは落としたくない。
const B = 'くり上がりの説明で、ブロックを配る2分がもったいないと感じていました。画面の中で動かせるようにしました。';

test('同じ文章は 1', () => {
    assert.equal(similarity(A, A), 1);
});

test('言い回しを変えただけの文章は、高い値になる', () => {
    assert.ok(similarity(A, A2) > 0.6, `似ているのに ${similarity(A, A2)} でした`);
});

test('切り口のちがう文章は、低い値になる', () => {
    assert.ok(similarity(A, B) < 0.2, `似ていないのに ${similarity(A, B)} でした`);
});

test('記号と空白のちがいでは変わらない', () => {
    // 読点の打ち方が違うだけで「別の文章」と判定されると、意味がない。
    assert.equal(similarity('今日は、算数の授業です', '今日は算数の授業です！'), 1);
});

test('URL とハッシュタグは比べる前に落とす', () => {
    const withExtras = `${A}\n\nhttps://gigayama.github.io/Typa/\n\n#小学校 #GIGAスクール`;
    assert.equal(similarity(A, withExtras), 1);
});

test('空文字は 0（比べるものが無い）', () => {
    assert.equal(similarity('', A), 0);
    assert.equal(similarity(A, ''), 0);
    assert.equal(similarity(null, undefined), 0);
});

test('bigramsOf は隣り合う2文字を集める', () => {
    assert.deepEqual([...bigramsOf('あいう')], ['あい', 'いう']);
    assert.deepEqual([...bigramsOf('あ')], ['あ'], '1文字でも空にしない');
    assert.equal(bigramsOf('').size, 0);
});

test('mostSimilar は、いちばん似ている過去の投稿を返す', () => {
    const past = [
        { id: 'old-1', body: B },
        { id: 'old-2', body: A2 },
    ];
    const { score, hit } = mostSimilar(A, past);
    assert.equal(hit.id, 'old-2');
    assert.ok(score > 0.6);
});

test('mostSimilar は、本文を持たない履歴を飛ばす', () => {
    // 履歴に本文を写すようにしたのは途中から。古い記録には body が無い。
    const { score, hit } = mostSimilar(A, [{ id: 'old-1' }, { id: 'old-2', body: null }]);
    assert.equal(hit, null);
    assert.equal(score, 0);
});

test('長い文章に丸ごと含まれていても、判定の閾値には届かない', () => {
    // 短い投稿が長文の一部と一致していても、全体としては別のものである。
    // Jaccard は「片方に含まれている」を 1 とは言わないので、そこが守られる。
    const long = A + B.repeat(30);
    assert.ok(similarity(A, long) < 0.5, `${similarity(A, long)}`);
});

test('実際に出た投稿どうしは、はっきり離れている', () => {
    // 閾値を決めた根拠をここに残す。data/queue の実データで測った値は
    //   別々の投稿どうし（同じ週・別アプリ）        … 最大 0.10
    //   本文と落選案（同じアプリ・同じ型・別の切り口）… 最大 0.14
    //   言い回しを変えただけの同じ文章              … 0.88
    // だった。0.5 はそのあいだに広く空いている。
    assert.ok(similarity(A, B) < 0.5);
    assert.ok(similarity(A, A2) > 0.5);
});
