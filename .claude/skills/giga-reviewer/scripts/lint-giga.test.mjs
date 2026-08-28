import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { allowedHosts, commentMask, isNodeProgram, lintContent, shouldLint } from './lint-giga.mjs';

/* ⚠️ このファイルにも `https://<既知のCDN>` という完成した形を書かない。
      テストは全リポジトリの .claude/ と .agents/ へ配られるので、
      各リポジトリの品質ゲート（B2 など）がここを「外部CDN参照」として拾う。
      配っただけで、触っていないリポジトリが赤くなる（2026-08-28 に実測）。
      スキームを実行時に足して、資料としての意味だけを残す。 */
const U = (rest) => `https:/${'/'}${rest}`;


test('lintContent: Zero-CDN checks', () => {
  const badHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="stylesheet" href="${U('cdnjs.cloudflare.com')}/ajax/libs/font-awesome/6.0.0/css/all.min.css">
        <script src="${U('cdn.jsdelivr.net')}/npm/vue@3"></script>
      </head>
    </html>
  `;
  const resBad = lintContent('index.html', badHtml);
  assert.equal(resBad.errors.length, 2);
  assert.equal(resBad.errors[0].rule, 'zero-cdn');

  const goodHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="stylesheet" href="style.css">
        <script src="app.js"></script>
      </head>
    </html>
  `;
  const resGood = lintContent('index.html', goodHtml);
  assert.equal(resGood.errors.length, 0);
});

test('lintContent: Zero-PII checks', () => {
  const badHtml = `
    <form>
      <input type="text" id="student_name" placeholder="氏名を入力">
    </form>
  `;
  const resBad = lintContent('index.html', badHtml);
  assert.equal(resBad.errors.length, 2);
  assert.equal(resBad.errors[0].rule, 'zero-pii');

  const goodHtml = `
    <div id="player-select">
      <button data-avatar="cat">ねこ</button>
      <button data-avatar="dog">いぬ</button>
    </div>
  `;
  const resGood = lintContent('index.html', goodHtml);
  assert.equal(resGood.errors.length, 0);
});

/* ── ここから 2026-08-28 の修理ぶん ─────────────────────────────
   どれも「落ちるはずが落ちなかった」「落ちてはいけないのに落ちた」を
   実測してから足したもの。 */

test('CLI の入口: 空白を含むパスから走らせても検査が動く', () => {
  /* ⚠️ 以前は `file://${process.argv[1]}` を文字列で組み立てて import.meta.url と
        比べていた。百分率符号化される（空白→%20）ぶんと、Windows の
        file:///C:/… がスラッシュ3本であるぶんの2点でずれ、CLI の節が
        まるごと動かないまま **何も出力せず exit 0** で終わっていた。
        作者の作業機は Windows なので、そこでは一度も動いていない。
        ここは実際に走らせて、違反のある資料で exit 1 になることを見る。 */
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'giga lint '));  // 名前に空白を入れる
  try {
    const script = path.join(dir, 'lint-giga.mjs');
    fs.copyFileSync(new URL('./lint-giga.mjs', import.meta.url), script);
    const sample = path.join(dir, 'sample');
    fs.mkdirSync(sample);
    fs.writeFileSync(path.join(sample, 'bad.html'),
      '<script src="' + U('unpkg.com') + '/vue"></script>\n');

    const run = spawnSync(process.execPath, [script, sample], { encoding: 'utf-8' });
    assert.equal(run.status, 1, `違反があるのに exit ${run.status} で終わった: ${run.stdout}`);
    assert.match(run.stdout + run.stderr, /zero-cdn/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自分のテスト資料を検出しない（どのリポジトリでも赤くなっていた）', () => {
  // .claude/ と .agents/ に配られた giga-reviewer 自身のテストには
  // わざと CDN が書いてある。2026-08-28 に 44 本すべてで再現した
  for (const p of [
    '.claude/skills/giga-reviewer/scripts/lint-giga.test.mjs',
    '.agents/skills/giga-reviewer/scripts/lint-giga.test.mjs',
    'tests/foo.mjs',
    'src/thing.test.mjs',
    'scripts/self-test.mjs',
  ]) {
    assert.equal(shouldLint(p), false, p);
  }
  assert.equal(shouldLint('src/main.js'), true);
  assert.equal(shouldLint('index.html'), true);
});

test('取り消しの目印がある行は見逃す', () => {
  const src = [
    '// ビルド時に取り寄せて自己ホストする giga-lint-ignore-next-line',
    `const u = '${U('fonts.googleapis.com')}/css2';`,
  ].join('\n');
  assert.equal(lintContent('scripts/build-fonts.mjs', src).errors.length, 0);
  // 目印が無ければ、これまでどおり落ちる（検査が生きていることの確認）
  const bare = `const u = '${U('fonts.googleapis.com')}/css2';`;
  assert.equal(lintContent('scripts/build-fonts.mjs', bare).errors.length, 1);
});

test('quality.config.json で宣言済みのホストは赤くしない', () => {
  const line = '<script src="' + U('cdn.jsdelivr.net') + '/npm/peerjs@1.5.4/dist/peerjs.min.js"></script>';
  assert.equal(lintContent('index.html', line).errors.length, 1, '宣言が無ければ落ちる');
  const opts = { allowedHosts: ['cdn.jsdelivr.net'] };
  assert.equal(lintContent('index.html', line, opts).errors.length, 0, '宣言があれば見逃す');
  // 宣言していない別のホストまで通してはいけない
  const other = '<script src="' + U('unpkg.com') + '/peerjs"></script>';
  assert.equal(lintContent('index.html', other, opts).errors.length, 1);
});

test('allowedHosts: securityExceptions の external-runtime-host だけを読む', () => {
  const cfg = JSON.stringify({
    securityExceptions: [
      { rule: 'external-runtime-host', value: 'cdn.jsdelivr.net', reason: '…' },
      { rule: 'no-csp', value: 'index.html', reason: '…' },
      { rule: 'external-runtime-host', value: 'FONTS.googleapis.com', reason: '…' },
    ],
  });
  const hosts = allowedHosts('/x', () => cfg);
  assert.deepEqual(hosts, ['cdn.jsdelivr.net', 'fonts.googleapis.com']);
  // 設定が無い・壊れている repo でも落ちない
  assert.deepEqual(allowedHosts('/x', () => { throw new Error('ENOENT'); }), []);
  assert.deepEqual(allowedHosts('/x', () => 'not json'), []);
});

test('サブドメインは宣言した親ホストの範囲に入れる', () => {
  const opts = { allowedHosts: ['giga-school.com'] };
  const line = '<script src="' + U('typa.giga-school.com') + '/a.js"></script>';
  assert.equal(lintContent('index.html', line, opts).errors.length, 0);
});

test('canonical は読み込みではないので警告にしない', () => {
  // 自分の公開 URL を canonical に書いてあるページが全部ひっかかっていた
  const line = '<link rel="canonical" href="' + U('typa.giga-school.com') + '/privacy.html">';
  const res = lintContent('privacy.html', line);
  assert.equal(res.errors.length, 0);
  assert.equal(res.warnings.length, 0);
});

test('既知のCDN以外の外部読み込みは警告として出す（止めはしない）', () => {
  const line = '<script src="' + U('example.com/app.js') + '"></script>';
  const res = lintContent('index.html', line);
  assert.equal(res.errors.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].rule, 'external-origin');
});

test('CSP の宣言行は読み込みではないので赤くしない（警告にする）', () => {
  /* ⚠️ CSP をきちんと書いたリポジトリほど赤くなっていた。直し方が
        「CSP を消す」になってしまうので、数える側が間違っている。
        2026-08-28 時点で KAKE_Master・Digital-Newspaper など多数で発生。 */
  const csp = `<meta http-equiv="Content-Security-Policy" content="style-src 'self' ${U('fonts.googleapis.com')}; font-src 'self' ${U('fonts.gstatic.com')};">`;
  const res = lintContent('index.html', csp);
  assert.equal(res.errors.length, 0, '制限の宣言をエラーにしてはいけない');
  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].rule, 'csp-allows-external');

  // 本物の読み込みは、これまでどおり赤いままであること
  const real = '<link href="' + U('fonts.googleapis.com') + '/css2?family=X" rel="stylesheet">';
  assert.equal(lintContent('index.html', real).errors.length, 1);
});

test('検索欄や人名でない「名前」を PII として数えない', () => {
  // 2026-08-28 の実測では、PII 18 件のうち半分以上がこの形だった
  for (const line of [
    '<input type="search" placeholder="本の なまえで さがす">',
    '<input placeholder="キーワード (名前・題名・本文)" id="searchQuery">',
    '<input placeholder="単元のなまえ（例：町探検）">',
    '<input placeholder="みつけたものの なまえ">',
    '<input placeholder="名前の一部..." class="dash-filter">',
  ]) {
    assert.equal(lintContent('index.html', line).errors.length, 0, line);
  }
  // 本物の収集欄は、これまでどおり赤いまま（検査が生きていることの確認）
  for (const line of [
    '<input type="text" id="new-student-name" placeholder="名前">',
    '<input id="member-name" required placeholder="児童名">',
    '<input placeholder="じぶんの 名前">',
  ]) {
    assert.ok(lintContent('index.html', line).errors.length > 0, line);
  }
});

test('品質ゲート自身とコメント行は読み込みではない', () => {
  /* 各リポジトリの check-project.mjs / verify-gate.mjs は、わざと CDN を
     差しこんで「ゲートが本当に落ちるか」を確かめるためのもの。
     ブラウザへ配られることはないので、読み込みとして数えない。 */
  for (const p of ['scripts/check-project.mjs', 'scripts/verify-gate.mjs', 'tools/check-project.mjs']) {
    assert.equal(shouldLint(p), false, p);
  }
  // コメントに書いてあるだけの URL（古い構成の説明・コメントアウト）
  for (const line of [
    ' *   ' + U('cdn.tailwindcss.com') + '                （CSS を その場で 生成）',
    '// <script src="' + U('unpkg.com') + '/react@18/umd/react.production.min.js"></script>',
    '<!-- <script src="' + U('cdn.jsdelivr.net') + '/npm/vue@3"></script> -->',
  ]) {
    assert.equal(lintContent('tools/build.mjs', line).errors.length, 0, line);
  }
  // 本物の読み込みは赤いまま
  assert.equal(
    lintContent('index.html', '<script src="' + U('unpkg.com') + '/vue"></script>').errors.length, 1);
});

// ==========================================================================
// ブロックコメントの途中の行（2026-08-28 に直したもの）
//
// COMMENT_LINE はコメントの「始まる行」しか見ていなかった。
// /* … */ の途中の行は素通りして違反として数えられ、実測で 4 件が
// これだった（KANA_Master/tools/build.mjs の「もとはこう読んでいた」一覧）。
// ==========================================================================

test('commentMask: ブロックコメントの途中の行も覆う', () => {
  const lines = [
    'const a = 1;',
    '/*',
    `  ${U('cdn.jsdelivr.net')}/npm/x.js  ← 昔こう読んでいた`,
    '*/',
    'const b = 2;',
  ];
  assert.deepEqual(commentMask(lines, 'tools/build.mjs'), [false, true, true, true, false]);
});

test('commentMask: HTML のコメントも覆う', () => {
  const lines = ['<p>a</p>', '<!--', `  <script src="${U('unpkg.com')}/x.js"></script>`, '-->', '<p>b</p>'];
  assert.deepEqual(commentMask(lines, 'index.html'), [false, true, true, true, false]);
});

test('commentMask: 1 行で閉じるコメントは次の行へ持ち越さない', () => {
  const lines = ['/* めも */', `<script src="${U('unpkg.com')}/x.js"></script>`];
  assert.deepEqual(commentMask(lines, 'a.js'), [true, false]);
});

test('commentMask: 文字列の中の /* をコメントの開きと読まない', () => {
  const lines = [`const glob = "src/*.js";`, `import x from "${U('unpkg.com')}/x.js";`];
  assert.deepEqual(commentMask(lines, 'a.js'), [false, false]);
});

test('ブロックコメントに書かれた CDN は違反にしない', () => {
  const src = [
    '// もとは これを 読ませていた:',
    '/*',
    `     ${U('cdn.tailwindcss.com')}`,
    `     ${U('unpkg.com')}/react@18/…`,
    '*/',
    'console.log(1);',
  ].join('\n');
  const { errors } = lintContent('src/note.js', src);
  assert.equal(errors.filter((e) => e.rule === 'zero-cdn').length, 0);
});

test('⚠️ コメントの外に出したら、ちゃんと違反になる（検査が空回りしていない）', () => {
  const src = `const s = document.createElement('script');\ns.src = '${U('cdn.jsdelivr.net')}/npm/x.js';`;
  const { errors } = lintContent('src/app.js', src);
  assert.equal(errors.filter((e) => e.rule === 'zero-cdn').length, 1);
});

// ==========================================================================
// ビルド時にしか動かない Node のプログラム
// ==========================================================================

test('isNodeProgram: shebang と node: の取りこみで見分ける', () => {
  assert.ok(isNodeProgram('#!/usr/bin/env node\nconsole.log(1)'));
  assert.ok(isNodeProgram("import fs from 'node:fs';"));
  assert.ok(isNodeProgram("const fs = require('node:fs');"));
  assert.ok(!isNodeProgram("import React from 'react';"));
  assert.ok(!isNodeProgram('<script>alert(1)</script>'));
});

test('ビルド時のコードの CDN は、赤ではなく警告になる', () => {
  const src = [
    '#!/usr/bin/env node',
    '// CSP が効いていることを、わざと読ませて確かめる',
    `const url = '${U('cdn.jsdelivr.net')}/npm/chart.js';`,
  ].join('\n');
  const { errors, warnings } = lintContent('tools/measure-csp.mjs', src);
  assert.equal(errors.length, 0, 'ビルド時のコードで赤くなっている');
  assert.equal(warnings.filter((w) => w.rule === 'external-in-tooling').length, 1);
});

test('⚠️ 同じ中身でも、配信するファイルなら赤くなる', () => {
  const src = `const url = '${U('cdn.jsdelivr.net')}/npm/chart.js';`;
  const { errors } = lintContent('src/app.js', src);
  assert.equal(errors.filter((e) => e.rule === 'zero-cdn').length, 1);
});
