/* A10（数量は算用数字）の検査だけを見るテスト。
 *
 * lint-article.mjs は上から下へ走る 1 本のスクリプトで、検査を関数として
 * 取り出していない。だから実際に起動して、出た行を読む。
 * 記事の体裁が整っていなくても ✗ が出るだけで ⚠ は出そろうので、
 * 見本は短くてよい。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT_ARTICLE = join(HERE, 'lint-article.mjs');
const LINT_DEVLOG = join(HERE, '..', '..', 'devlog-article', 'scripts', 'lint-devlog.mjs');

/** 見本の記事を書き出して検査にかけ、[表記] で出た語だけを返す */
function notation(body) {
  const dir = join(mkdtempSync(join(tmpdir(), 'lint-a10-')), 'docs', 'note');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'sample-note-article.md');
  writeFileSync(file, `# 教室で使えるかもしれないもの作り #1 「困りごと」に効くアプリ「見本」\n\n${body}\n`);
  const out = spawnSync(process.execPath, [LINT_ARTICLE, file], { encoding: 'utf8' }).stdout || '';
  return out.split('\n')
    .filter((l) => l.includes('[表記] 数量は算用数字で書く'))
    .map((l) => l.trim().split(/\s{2,}/).pop());
}

test('漢数字で書かれた数量を拾う', () => {
  const got = notation('四桁の数を十文字ならべます。十秒で終わります。二十五種類の図を三十人で見ます。');
  assert.deepEqual(got.sort(), ['三十人', '二十五種類', '十文字', '十秒', '四桁'].sort());
});

test('和語の数詞は拾わない。「3つ目」は「さんつめ」に見えるので漢字のまま', () => {
  assert.deepEqual(notation('一つ目は速いこと。二つ目は軽いこと。三つ目は安いことです。'), []);
});

test('数を数えていない言葉は拾わない', () => {
  assert.deepEqual(notation('一度も開いていないので一覧に出ません。一人ひとりに一枚ずつ、一斉に配ります。'), []);
});

test('算用数字で書けているものは拾わない', () => {
  assert.deepEqual(notation('4桁の数を10文字まで、10秒で終えられます。1回押すだけです。'), []);
});

/* ここから下は誤検知の除外。落とすと拾ってしまうことを確かめる。
 * 公開ずみ 32 本で測ったとき、この 3 つで 9 件の嘘の警告が出ていた。 */
test('「じゅうぶん」と読む十分は拾わない', () => {
  assert.deepEqual(notation('それだけで十分です。十分に伝わります。二つ目だけで十分だと思います。'), []);
});

test('百分率と四分の一は拾わない', () => {
  assert.deepEqual(notation('五年生の百分率なら、四分の一で当たってしまいます。'), ['五年']);
});

test('概数の「何十」は拾わない', () => {
  assert.deepEqual(notation('何十点もの画面が入ります。何十ページもある教科書です。'), []);
});

test('同じ十分でも、10 分のほうは拾う', () => {
  assert.deepEqual(notation('朝の十分間、名簿を見ます。'), ['十分']);
});

/* ⚠️ 一・二で始まる単独の数は見ない。「一度」「一人」「一覧」がそこに集まっていて、
 *    拾うと嘘の警告のほうが多くなる。そのぶん本物も素通りする。承知のうえの穴。 */
test('一・二で始まる単独の数は、本物でも素通りする', () => {
  assert.deepEqual(notation('二手先を数える子が出てきます。'), []);
});

/* 片方だけ直すと、書き手が 2 つの検査から違うことを言われる（style.md:5-8）。 */
test('note 版と開発記録版で、助数詞と除外の一覧がそろっている', () => {
  const pick = (src, name) => {
    const at = src.indexOf(name);
    assert.notEqual(at, -1, `${name} が見つからない`);
    const from = src.indexOf('[', at);
    return src.slice(from, src.indexOf(']', from) + 1).replace(/\s+/g, '');
  };
  const a = readFileSync(LINT_ARTICLE, 'utf8');
  const d = readFileSync(LINT_DEVLOG, 'utf8');
  assert.equal(pick(a, 'counters:'), pick(d, 'const COUNTERS ='));
  assert.equal(pick(a, 'keep:'), pick(d, 'const NUM_KEEP ='));
});

/* ── ふりがな ──────────────────────────────────────────────
 * ルビは語の途中に markup を挟むので、素の行に検査を当てると外れる。
 * 記事そのものは先生向けでふりがなを振らないが、開発記録は
 * ふりがなの話を書くことがあり、そこには <ruby> が入る。
 */

/** 見本を検査にかけて、出た行を全部返す */
function lintOf(body) {
  const dir = join(mkdtempSync(join(tmpdir(), 'lint-ruby-')), 'docs', 'note');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'sample-note-article.md');
  writeFileSync(file, `# 教室で使えるかもしれないもの作り #1 「困りごと」に効くアプリ「見本」\n\n${body}\n`);
  return spawnSync(process.execPath, [LINT_ARTICLE, file], { encoding: 'utf8' }).stdout || '';
}

test('ふりがなを振っても、言い回しの検査は当たる', () => {
  const plain = lintOf('結論から言うと、計算の練習は続きます。');
  const ruby = lintOf('<ruby>結論<rt>けつろん</rt></ruby>から言うと、'
    + '<ruby>計算<rt>けいさん</rt></ruby>の<ruby>練習<rt>れんしゅう</rt></ruby>は続きます。');
  assert.ok(plain.includes('[前置き] 結論から言うと'), 'この試験の前提が崩れている');
  assert.ok(ruby.includes('[前置き] 結論から言うと'),
    'ふりがなが語の途中に入ると、言い回しを見のがす');
});

test('ふりがなを振っても、実体験としての書き方を見のがさない', () => {
  const ruby = lintOf('子どもたちが<ruby>計算<rt>けいさん</rt></ruby>を'
    + '<ruby>練習<rt>れんしゅう</rt></ruby>していました。');
  assert.ok(ruby.includes('[事実]'), 'ふりがなで窓が埋まって、検査が外れている');
});

test('字数にふりがなを数えない', () => {
  const n = (out) => Number((out.match(/本文が ([\d,]+)字/) || [])[1]?.replace(/,/g, '') || 0);
  const plain = n(lintOf('計算の練習をします。'));
  const ruby = n(lintOf('<ruby>計算<rt>けいさん</rt></ruby>の<ruby>練習<rt>れんしゅう</rt></ruby>をします。'));
  assert.ok(plain > 0, 'この試験の前提が崩れている');
  assert.equal(ruby, plain, 'ふりがなの markup が字数に入っている');
});

test('コード枠の中のふりがなは、そのまま数える（書き方を見せる枠がある）', () => {
  const out = lintOf('```\n<ruby>設定<rt>せってい</rt></ruby>\n```\n\n本文。');
  assert.ok(!out.includes('内部エラー'), '枠の中で落ちている');
});
