/**
 * 連投の組み立てと、その検査。
 *
 * いちばん大事なのは1つ。**本文に URL を入れないこと**。
 * X は本文に外部リンクがある投稿のリーチを大きく下げ、
 * Premium でないアカウントではほとんど表示されない。
 * 「うっかり本文に URL が混ざる」は生成でいちばん起きやすい壊れ方なので、
 * 組み立ての側と検査の側の両方で固定しておく。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { composeSteps, extractUrls, hookOf, seedFrom } from '../scripts/lib/x-text.mjs';
import { lintPost } from '../scripts/lib/lint.mjs';

const guardrails = JSON.parse(fs.readFileSync(new URL('../config/guardrails.json', import.meta.url), 'utf8'));
const monetization = { enabled: false };

const URL_ = 'https://gigayama.github.io/KANJI_Town/';
const BODY = '漢字の宿題を出しても、丸つけが追いつきませんでした。1クラスぶんで放課後がまるごと消えます。いまは端末で書いて、その場で判定が出るようにしています。';

function stepsOf(over = {}) {
    return composeSteps({ body: BODY, url: URL_, hashtags: ['小学校', 'GIGAスクール'], seed: 1, ...over });
}

test('本文・リンクの返信の順に組み立つ', () => {
    const steps = stepsOf();
    assert.deepEqual(steps.map((s) => s.kind), ['main', 'link']);
});

test('本文に URL が入らない', () => {
    const [main] = stepsOf();
    assert.equal(/https?:\/\//.test(main.text), false, `本文に URL が入っています: ${main.text}`);
});

test('本文にハッシュタグは入る', () => {
    const [main] = stepsOf();
    assert.match(main.text, /#小学校/);
    assert.match(main.text, /#GIGAスクール/);
});

test('リンクの返信に URL がちょうど1本入る', () => {
    const steps = stepsOf();
    const link = steps.at(-1);
    assert.equal((link.text.match(/https?:\/\//g) ?? []).length, 1);
    assert.ok(link.text.includes(URL_));
});

test('つづきを渡すと本文とリンクのあいだに入る', () => {
    const steps = stepsOf({ thread: ['つづきの1コマ目です。', 'つづきの2コマ目です。'] });
    assert.deepEqual(steps.map((s) => s.kind), ['main', 'thread', 'thread', 'link']);
});

test('空のつづきは落とす', () => {
    const steps = stepsOf({ thread: ['', '   ', 'ちゃんとある'] });
    assert.equal(steps.filter((s) => s.kind === 'thread').length, 1);
});

test('placement を body にすると、これまでどおり本文に URL が入る', () => {
    const steps = composeSteps({ body: BODY, url: URL_, hashtags: [], placement: 'body' });
    assert.deepEqual(steps.map((s) => s.kind), ['main']);
    assert.ok(steps[0].text.includes(URL_));
});

test('リンクに添える一言は投稿ごとに変わり、同じ投稿では変わらない', () => {
    // 毎回同じ文だと機械が書いたように見える。かといって実行のたびに変わると、
    // 作りなおしたときに前と違う文になって混乱する。
    const a = composeSteps({ body: BODY, url: URL_, seed: seedFrom('2026-08-10-morning') });
    const b = composeSteps({ body: BODY, url: URL_, seed: seedFrom('2026-08-10-morning') });
    const c = composeSteps({ body: BODY, url: URL_, seed: seedFrom('2026-08-11-evening') });
    assert.equal(a.at(-1).text, b.at(-1).text);
    assert.notEqual(a.at(-1).text, c.at(-1).text);
});

test('hookOf は最初の1行を返す', () => {
    assert.equal(hookOf('1行目\n2行目'), '1行目');
    assert.equal(hookOf('  空白つき  \n次'), '空白つき');
    assert.equal(hookOf(''), '');
});

/* ── 検査 ─────────────────────────────────── */

test('正しく組み立てた連投は検査を通る', () => {
    const post = { id: 'x', steps: stepsOf() };
    assert.deepEqual(lintPost(post, guardrails, monetization), []);
});

test('本文に URL が混ざったら落ちる', () => {
    // これがこの変更でいちばん大事な検査。わざと壊して落ちることを確かめる。
    const steps = stepsOf();
    steps[0].text += `\n${URL_}`;
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(
        problems.some((p) => p.includes('本文に URL が入っています')),
        `本文の URL を見逃しています: ${JSON.stringify(problems)}`
    );
});

test('つづきに URL が混ざったら落ちる', () => {
    const steps = stepsOf({ thread: [`使い方はこちらです ${URL_}`] });
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(problems.some((p) => p.includes('URL')));
});

test('リンクの返信から URL が消えたら落ちる', () => {
    const steps = stepsOf();
    steps.at(-1).text = 'アプリはこちらです。';
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(problems.some((p) => p.includes('URL')));
});

test('つづきが多すぎたら落ちる', () => {
    const steps = stepsOf({ thread: Array.from({ length: 6 }, (_, i) => `じゅうぶんな長さのつづきのコマです。これは${i + 1}コマ目です。`) });
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(problems.some((p) => p.includes('つづきが多すぎます')));
});

test('つづきが短すぎたら落ちる（数だけ増やすのを防ぐ）', () => {
    const steps = stepsOf({ thread: ['短い'] });
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(problems.some((p) => p.includes('短すぎます')));
});

test('つづきや返信に禁止表現が入っていても落ちる', () => {
    // 本文だけ見て安心しないこと。返信も同じように外に出る。
    const steps = stepsOf({ thread: ['これを使うと学力が必ず上がります。うちのクラスでも試しています。'] });
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(problems.some((p) => p.includes('学習効果')));
});

test('本文が長すぎたら落ちる', () => {
    const steps = stepsOf({ body: 'あ'.repeat(200) });
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(problems.some((p) => p.includes('長すぎます')));
});

test('各コマの長さが書き戻される（画面の表示に使う）', () => {
    const post = { id: 'x', steps: stepsOf() };
    lintPost(post, guardrails, monetization);
    assert.ok(post.steps.every((s) => typeof s.weightedLength === 'number' && s.weightedLength > 0));
    assert.equal(post.weightedLength, post.steps[0].weightedLength);
});

test('steps を持たない古い形の投稿も、これまでどおり検査できる', () => {
    // data/queue/ には前の週のものが残っている。読めなくなると困る。
    const old = { id: 'old', text: `${BODY}\n\n${URL_}\n\n#小学校` };
    assert.deepEqual(lintPost(old, guardrails, monetization), []);
    assert.ok(old.weightedLength > 0);
});

test('古い形でも URL が無ければ落ちる', () => {
    const old = { id: 'old', text: BODY };
    assert.ok(lintPost(old, guardrails, monetization).some((p) => p.includes('URL')));
});

test('本文が空なら、それだけを言う', () => {
    assert.deepEqual(lintPost({ id: 'x', steps: [{ kind: 'main', label: '本文', text: '  ' }] }, guardrails, monetization), [
        '本文が空です',
    ]);
});

/* ── スキームなしの URL ─────────────────────────
 *
 * X は https:// が無くても、ドメインらしき文字列を自動でリンクにする。
 * つまり「gigayama.github.io/Typa/」と書いた投稿は、本文にリンクがある投稿として扱われ、
 * リーチが下がる。本文からリンクを外すというこのリポジトリの中心的な判断が、
 * ここを見ていないせいで素通りしていた。 */

test('スキームなしの URL も URL として拾う', () => {
    assert.deepEqual(extractUrls('詳しくは gigayama.github.io/Typa/ をどうぞ'), ['gigayama.github.io/Typa/']);
    assert.deepEqual(extractUrls('note.com/gigayama で書いています'), ['note.com/gigayama']);
    assert.deepEqual(extractUrls('example.co.jp が入口です'), ['example.co.jp']);
});

test('URL でないものを URL にしない', () => {
    // ここを広げすぎると、ふつうの日本語やファイル名が URL 扱いになって投稿が作れなくなる。
    for (const text of [
        'app.js を直しました',
        'docs/sw.js の VERSION です',
        '1.5倍の速さで進みます',
        '国語。算数。理科。社会。',
        '午前8.30に集合です',
        'メールは taro@example.com です',
    ]) {
        assert.deepEqual(extractUrls(text), [], `URL でないものを拾っています: ${text}`);
    }
});

test('スキームなしの URL が本文にあったら落ちる', () => {
    const steps = stepsOf();
    steps[0].text += '\n詳しくは gigayama.github.io/KANJI_Town/ をどうぞ';
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(
        problems.some((p) => p.includes('本文に URL が入っています')),
        `スキームなしの URL を見逃しています: ${JSON.stringify(problems)}`
    );
});

test('スキームなしの URL も1本として数える（返信に2本入るのを止める）', () => {
    const steps = stepsOf();
    steps.at(-1).text = `アプリはこちらです。\n${URL_}\nミラーは gigayama.github.io/Typa/ です。`;
    const problems = lintPost({ id: 'x', steps }, guardrails, monetization);
    assert.ok(problems.some((p) => p.includes('1本にしてください')), `2本目を見逃しています: ${JSON.stringify(problems)}`);
});
