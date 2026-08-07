/**
 * 落選案（alternatives）の検査。
 *
 * 生成では1枠につき3案書かせ、編集者役が1つ選ぶ。
 * 選ばれなかった案もランチャーに載せていて、［別の案］からワンタップで本文になる。
 *
 * ところがガードレール検査（lintPost）が見ているのは steps だけなので、
 * 落選案は一度も検査されないまま画面に出ていた。
 * CLAUDE.md §3 の禁止事項（児童が特定できる書き方・学習効果の断定・煽り・収益化）を
 * 含む案が、押した瞬間に本文になる状態だった。
 *
 * 「人が毎回読んで確認する前提にしない」という設計方針（lib/lint.mjs 冒頭）を
 * 落選案にも及ぼす。ここもわざと危ない案を混ぜて、落ちることを確かめる。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { lintAlternative, lintPost, pruneAlternatives } from '../scripts/lib/lint.mjs';
import { swapToPassingAlternative } from '../scripts/lint-drafts.mjs';

const guardrails = JSON.parse(fs.readFileSync(new URL('../config/guardrails.json', import.meta.url), 'utf8'));
const monetizationOff = { enabled: false };
const monetizationOn = { enabled: true };

const URL_ = 'https://gigayama.github.io/KEISAN-BLOCK/';

const SAFE =
    'くり上がりの説明で、ブロックを配る2分がもったいないと感じていました。画面の中で動かせるようにしたら、その2分を説明にまわせるようになりました。';

function post(alternatives) {
    return {
        id: '2026-08-10-morning',
        url: URL_,
        hashtags: ['小学校', '算数'],
        alternatives,
    };
}

test('ふつうの落選案は通る', () => {
    assert.deepEqual(lintAlternative({ body: SAFE, thread: [] }, post([]), guardrails, monetizationOff), []);
});

test('学習効果を断定した落選案は落ちる', () => {
    const problems = lintAlternative(
        { body: 'このアプリを使えば、子どもたちの学力が必ず上がります。毎日5分続けるだけで教室の空気が変わります。', thread: [] },
        post([]),
        guardrails,
        monetizationOff
    );
    assert.ok(problems.some((p) => p.includes('学習効果の断定')), `落ちるはずが通った: ${JSON.stringify(problems)}`);
});

test('児童が特定できる落選案は落ちる', () => {
    const problems = lintAlternative(
        { body: 'うちの児童のたろうくんが、くり上がりでつまずいていました。だからこの教材を作って、教室で毎日使っています。', thread: [] },
        post([]),
        guardrails,
        monetizationOff
    );
    assert.ok(problems.some((p) => p.includes('個人が特定')), `落ちるはずが通った: ${JSON.stringify(problems)}`);
});

test('収益化の表現を含む落選案は、enabled が false のあいだ落ちる', () => {
    const alt = { body: 'くり上がりの教材を作りました。詳しい作り方は有料記事にまとめてあります。よければご覧ください。', thread: [] };
    assert.ok(lintAlternative(alt, post([]), guardrails, monetizationOff).some((p) => p.includes('収益化の表現')));
    assert.ok(!lintAlternative(alt, post([]), guardrails, monetizationOn).some((p) => p.includes('収益化の表現')));
});

test('本文に URL を書いた落選案は落ちる', () => {
    // 本文にリンクがあると X はリーチを大きく下げる。差し替えた瞬間にそうなるのを止める。
    const problems = lintAlternative(
        { body: `くり上がりの説明で困っていました。作ったものはこちらです。${URL_} 教室でそのまま使えます。`, thread: [] },
        post([]),
        guardrails,
        monetizationOff
    );
    assert.ok(problems.some((p) => p.includes('URL')), `落ちるはずが通った: ${JSON.stringify(problems)}`);
});

test('短すぎる落選案は落ちる', () => {
    const problems = lintAlternative({ body: 'つくりました。', thread: [] }, post([]), guardrails, monetizationOff);
    assert.ok(problems.some((p) => p.includes('短すぎます')), `落ちるはずが通った: ${JSON.stringify(problems)}`);
});

test('pruneAlternatives は危ない案だけを落とし、安全な案を残す', () => {
    const target = post([
        { body: SAFE, thread: [] },
        { body: 'このアプリを使えば、子どもたちの学力が必ず上がります。毎日5分続けるだけで教室の空気が変わります。', thread: [] },
    ]);
    const dropped = pruneAlternatives(target, guardrails, monetizationOff);

    assert.equal(dropped.length, 1, '危ない案が1件落ちるはず');
    assert.equal(target.alternatives.length, 1);
    assert.equal(target.alternatives[0].body, SAFE);
});

test('pruneAlternatives は全部落ちたら空配列にする（本文は残す）', () => {
    const target = post([{ body: 'つくりました。', thread: [] }]);
    pruneAlternatives(target, guardrails, monetizationOff);
    assert.deepEqual(target.alternatives, []);
});

test('pruneAlternatives は落選案を持たない投稿でも落ちない', () => {
    const target = { id: 'x', url: URL_ };
    assert.deepEqual(pruneAlternatives(target, guardrails, monetizationOff), []);
    assert.deepEqual(target.alternatives, []);
});

test('落選案の検査は本文の検査を書き換えない', () => {
    // lintPost は post.weightedLength を書き戻す。落選案の検査でそこを汚すと、
    // ランチャーの文字数表示が別の案のものになってしまう。
    const target = post([{ body: SAFE, thread: [] }]);
    target.weightedLength = 261;
    pruneAlternatives(target, guardrails, monetizationOff);
    assert.equal(target.weightedLength, 261);
});

/* ── 基準を厳しくしたあとの直しかた ──────────────────
 *
 * guardrails.json を厳しくすると、既に作ってある週が落ちる。それは正しい動きだが、
 * 直す手段が「その週をまるごと作りなおす」しかなかった。
 * 作りなおすと通っていた枠まで別の文章になるし、API キーが要るので手元では直せない。
 *
 * 落ちた枠には、そのとき選ばれなかった案が残っている。
 * そちらが基準を満たしていれば、生成を1回も呼ばずにその枠だけ直せる。 */

const DANGEROUS = 'うちのクラスでは、休み時間に子どもたちが同じゲームばかりで飽きていました。だから作りなおしました。';

function postWithBody(body, alternatives) {
    return {
        id: '2026-08-10-evening',
        url: URL_,
        hashtags: ['小学校', '算数'],
        body,
        hook: 'scene',
        alternatives,
        steps: [{ kind: 'main', label: '本文', text: body }],
        text: body,
        pickedBy: 'editor',
    };
}

test('落ちた本文を、検査を通る別の案に差し替える', () => {
    const post = postWithBody(DANGEROUS, [{ body: SAFE, thread: [], hook: 'number' }]);
    assert.ok(lintPost(post, guardrails, monetizationOff).length > 0, '前提: いまの本文は落ちる');

    assert.equal(swapToPassingAlternative(post, guardrails, monetizationOff), true);
    assert.equal(post.body, SAFE);
    assert.equal(post.hook, 'number', '案が持っていたフックに入れかわる');
    assert.deepEqual(lintPost(post, guardrails, monetizationOff), [], '差し替えたあとは通る');
});

test('差し替えると連投も組みなおされる', () => {
    // 本文だけ入れかえて steps を古いままにすると、
    // ランチャーが出すのは古い文章になる（画面と data が食い違う）。
    const post = postWithBody(DANGEROUS, [{ body: SAFE, thread: [], hook: 'number' }]);
    swapToPassingAlternative(post, guardrails, monetizationOff);

    assert.deepEqual(post.steps.map((s) => s.kind), ['main', 'link']);
    assert.ok(post.steps[0].text.startsWith(SAFE));
    assert.equal(post.text, post.steps[0].text);
    assert.ok(post.steps.at(-1).text.includes(URL_), 'リンクの返信は残る');
});

test('落ちた本文は別の案としても残さない', () => {
    // 基準を満たしていないものを、ワンタップで本文になる場所に置かない。
    const post = postWithBody(DANGEROUS, [{ body: SAFE, thread: [], hook: 'number' }]);
    swapToPassingAlternative(post, guardrails, monetizationOff);
    assert.equal(post.alternatives.some((a) => a.body === DANGEROUS), false);
});

test('残った別の案のうち、基準を満たさないものも落とす', () => {
    const post = postWithBody(DANGEROUS, [
        { body: SAFE, thread: [], hook: 'number' },
        { body: 'これを使えば学力が必ず上がります。毎日5分でクラスの空気が変わると思います。', thread: [] },
    ]);
    swapToPassingAlternative(post, guardrails, monetizationOff);
    assert.deepEqual(post.alternatives, []);
});

test('通る案が1つも無ければ差し替えない', () => {
    // ここで無理に何かを入れると、基準を満たさないものが出ていく。
    const post = postWithBody(DANGEROUS, [{ body: 'みじかい。', thread: [] }]);
    assert.equal(swapToPassingAlternative(post, guardrails, monetizationOff), false);
    assert.equal(post.body, DANGEROUS, '本文はそのまま。呼び出し側が週を作りなおす');
});

test('別の案を持たない投稿でも落ちない', () => {
    const post = postWithBody(DANGEROUS, undefined);
    assert.equal(swapToPassingAlternative(post, guardrails, monetizationOff), false);
});

test('どこから来た本文かが残る', () => {
    // 「なぜ編集者の選んだ案でないのか」をあとから追えるようにする。
    const post = postWithBody(DANGEROUS, [{ body: SAFE, thread: [], hook: 'number' }]);
    swapToPassingAlternative(post, guardrails, monetizationOff);
    assert.equal(post.pickedBy, 'lint-fix');
    assert.match(post.pickReason, /検査に落ちた/);
});
