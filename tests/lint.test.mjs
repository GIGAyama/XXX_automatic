/**
 * ガードレールのテスト。
 *
 * この検査は「人が毎回読んで確認しない」ことを前提に置いてある。
 * だから「合格しました」が本当に検査した結果なのかを、ここで確かめておく必要がある。
 * わざと危ない文章を入れて、ちゃんと落ちることを見る。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { lintPost } from '../scripts/lib/lint.mjs';
import { composePost, countEmoji, plainLength, weightedLength } from '../scripts/lib/x-text.mjs';

const guardrails = JSON.parse(readFileSync(new URL('../config/guardrails.json', import.meta.url), 'utf8'));
const monetizationOff = { enabled: false };
const monetizationOn = { enabled: true };

/** 検査を通るはずの、ふつうの投稿 */
function goodPost(overrides = {}) {
    return {
        id: 'test',
        text: composePost({
            body: 'くり上がりの説明で、ブロックを配る2分がもったいないと感じていました。画面の中で動かせるようにしたら、その2分を説明にまわせるようになりました。',
            url: 'https://gigayama.github.io/KEISAN-BLOCK/',
            hashtags: ['小学校', '算数'],
        }),
        ...overrides,
    };
}

test('ふつうの投稿は通る', () => {
    assert.deepEqual(lintPost(goodPost(), guardrails, monetizationOff), []);
});

test('長さは全角2・URL23で数える', () => {
    // 日本語10文字 = 20
    assert.equal(weightedLength('あいうえおかきくけこ'), 20);
    // 半角10文字 = 10
    assert.equal(weightedLength('abcdefghij'), 10);
    // URL は実際の長さに関係なく 23
    assert.equal(weightedLength('https://gigayama.github.io/KEISAN-BLOCK/'), 23);
    assert.equal(weightedLength('https://x.co/a'), 23, '短いURLでも23で数える');
    // 組み合わせ
    assert.equal(weightedLength('あい https://gigayama.github.io/Typa/'), 4 + 1 + 23);
});

test('長すぎる投稿は落ちる', () => {
    const post = { id: 'long', text: `${'あ'.repeat(200)}\nhttps://gigayama.github.io/Typa/` };
    const problems = lintPost(post, guardrails, monetizationOff);
    assert.ok(
        problems.some((p) => p.includes('長すぎます')),
        `落ちるはずが通った: ${JSON.stringify(problems)}`
    );
    assert.equal(post.weightedLength, 400 + 1 + 23, '実測値が書き戻されている');
});

test('短すぎる投稿は落ちる', () => {
    const post = { id: 'short', text: 'つくりました\n\nhttps://gigayama.github.io/Typa/' };
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('短すぎます')));
});

test('URL が無い投稿は落ちる', () => {
    const post = { id: 'nourl', text: 'くり上がりの説明で、ブロックを配る2分がもったいないと感じていました。画面の中で動かせるようにしました。' };
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('URL が入っていません')));
});

test('URL が2本以上あると落ちる', () => {
    const post = goodPost({
        text: 'くり上がりの説明で、ブロックを配る2分がもったいないと感じていました。\nhttps://gigayama.github.io/Typa/\nhttps://gigayama.github.io/Qalc/',
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('URL が 2 本')));
});

test('絵文字が多いと落ちる', () => {
    const post = goodPost({
        text: composePost({
            body: 'くり上がりの説明で、ブロックを配る2分がもったいないと感じていました🎉🎊✨🙌 画面の中で動かせるようにしました。',
            url: 'https://gigayama.github.io/KEISAN-BLOCK/',
            hashtags: ['算数'],
        }),
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('絵文字が多すぎます')));
});

test('ハッシュタグが多いと落ちる', () => {
    const post = goodPost({
        text: composePost({
            body: 'くり上がりの説明で、ブロックを配る2分がもったいないと感じていました。画面の中で動かせるようにしました。',
            url: 'https://gigayama.github.io/KEISAN-BLOCK/',
            hashtags: ['小学校', '算数', '教育', 'GIGAスクール'],
        }),
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('ハッシュタグが多すぎます')));
});

/* ── ここからが本題。安全に関わる検査が本当に効いているか ── */

test('根拠のない学習効果の断定は落ちる', () => {
    const post = goodPost({
        text: 'このアプリを使えば、子どもたちの学力が必ず上がります。毎日5分続けるだけで効果が出ます。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    const problems = lintPost(post, guardrails, monetizationOff);
    assert.ok(problems.some((p) => p.includes('学習効果の断定')), `落ちるはずが通った: ${JSON.stringify(problems)}`);
});

test('煽り表現は落ちる', () => {
    const post = goodPost({
        text: '知らないと損する、算数の教え方があります。これを使っていない先生はもったいないです。ぜひ試してみてください。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('煽り表現')));
});

test('誇大表現は落ちる', () => {
    const post = goodPost({
        text: 'たった3分でわかる、くり上がりの教え方です。教室でそのまま使えるように作りました。ぜひ見てみてください。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('誇大表現')));
});

test('公的機関のお墨付きを装う表現は落ちる', () => {
    const post = goodPost({
        text: '文部科学省も推奨している考え方をもとに、くり上がりの教材を作りました。教室でそのまま使えます。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('公的機関')));
});

test('他サービスの批判は落ちる', () => {
    const post = goodPost({
        text: '市販のドリルは使えないと感じていたので、自分で作りました。教室でそのまま配れるようにしてあります。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('批判')));
});

test('児童が特定できる書き方は落ちる', () => {
    const post = goodPost({
        text: 'うちの児童のたろうくんが、くり上がりでつまずいていました。だからこのアプリを作りました。教室で使っています。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('個人が特定')));
});

test('勤務校が特定できる書き方は落ちる', () => {
    const post = goodPost({
        text: 'わたしが勤務している小学校に赴任してから、くり上がりの指導をずっと考えていました。それで作ったのがこれです。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    assert.ok(lintPost(post, guardrails, monetizationOff).some((p) => p.includes('勤務校')));
});

/* ── 収益化スイッチ ── */

test('enabled が false のあいだ、収益化の表現は落ちる', () => {
    const post = goodPost({
        text: 'くり上がりの教材を作りました。詳しい作り方は有料記事にまとめてあります。よければご覧ください。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    const problems = lintPost(post, guardrails, monetizationOff);
    assert.ok(problems.some((p) => p.includes('収益化の表現')), `落ちるはずが通った: ${JSON.stringify(problems)}`);
});

test('enabled が true なら収益化の表現は通る', () => {
    const post = goodPost({
        text: 'くり上がりの教材を作りました。詳しい作り方は有料記事にまとめてあります。よければご覧ください。\n\nhttps://gigayama.github.io/KEISAN-BLOCK/',
    });
    const problems = lintPost(post, guardrails, monetizationOn);
    assert.ok(!problems.some((p) => p.includes('収益化の表現')), '切り替えが効いていない');
});

/* ── 数え方の細部 ── */

test('countEmoji は複数コードポイントの絵文字を1個と数える', () => {
    assert.equal(countEmoji('あ'), 0);
    assert.equal(countEmoji('🎉'), 1);
    assert.equal(countEmoji('👨‍👩‍👧‍👦'), 1, '家族の絵文字は見た目どおり1個');
    assert.equal(countEmoji('🎉🎊'), 2);
});

test('plainLength は URL とハッシュタグを除く', () => {
    assert.equal(plainLength('あいう https://example.com/x #タグ'), 3);
});

test('composePost は本文・URL・タグをこの順で組む', () => {
    assert.equal(composePost({ body: '本文', url: 'https://e.com/', hashtags: ['a', '#b'] }), '本文\n\nhttps://e.com/\n\n#a #b');
    assert.equal(composePost({ body: '本文', url: null, hashtags: [] }), '本文');
});
