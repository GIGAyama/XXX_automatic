/**
 * 更新ログの書式の検査のテスト。
 *
 * この検査が緩むと「書いたのに公開ページに出ない」が黙って通る。気づくのは
 * 翌朝で、しかも「書いたはずなのに無い」という形なので、原因にたどり着けない。
 *
 * ⚠️ 落とすのは機械が拾えなくなるものだけ。言い回しは warn で止めない
 *    （検査で好みを強制すると、書き手がこの検査を通さなくなる）。
 *    ここでもその線引きを検査する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintChangelog } from './lint-changelog.mjs';

const TODAY = '2026-08-31';
const errors = (md) => lintChangelog(md, TODAY).filter((f) => f.level === 'error');
const warns = (md) => lintChangelog(md, TODAY).filter((f) => f.level === 'warn');

const GOOD = `# 更新の記録

このアプリの変わったところです。

## 2026-08-23
- 写真の上限をなくしました
- 音が出ない端末があったのを直しました

## 2026-06-01
- はじめて公開しました
`;

test('ちゃんと書けているものは、何も言わない', () => {
  assert.deepEqual(lintChangelog(GOOD, TODAY), []);
});

test('日付の見出しの形ちがいを落とす（書いたのに出ない、の大半）', () => {
  /* tools/lib/changelog.mjs の DATE_RE が拾わないので、下の項目ごと消える */
  for (const bad of ['## 2026/08/23', '## 2026-8-3', '## v1.2.0', '## 8月23日']) {
    const found = errors(`${bad}\n- 何かを直しました\n`);
    assert.ok(found.length, `${bad} が素通りしている`);
  }
});

test('日付の見出しが 1 つも無ければ落とす', () => {
  assert.ok(errors('- 写真の上限をなくしました\n').length);
});

test('中身の無い日付を落とす（見出しごと黙って消える）', () => {
  const found = errors('## 2026-08-23\n\n## 2026-06-01\n- はじめて公開しました\n');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /中身の無い日付/);
});

test('存在しない日付を落とす', () => {
  assert.ok(errors('## 2026-02-31\n- 何かを直しました\n').length);
});

test('同じ日付が 2 回あれば落とす', () => {
  const found = errors('## 2026-08-23\n- あれを直しました\n\n## 2026-08-23\n- これを直しました\n');
  assert.ok(found.some((f) => /同じ日付/.test(f.message)));
});

test('コミットの題をそのまま貼ったものを落とす', () => {
  /* 正本配布が 42 本へ撒くので、使う人から見ると何も変わっていない */
  assert.ok(errors('## 2026-08-23\n- chore(standards): Sync with latest standards\n').length);
  assert.ok(errors('## 2026-08-23\n- fix: iOS Safari の音を直す\n').length);
  assert.ok(errors('## 2026-08-23\n- feat(ui): ボタンを足す\n').length);
});

test('入れ子の箇条書きを落とす（親と並べて拾われる）', () => {
  const found = errors('## 2026-08-23\n- 写真をあつかえるようにしました\n  - ついでに上限もなくしました\n');
  assert.ok(found.some((f) => /入れ子/.test(f.message)));
});

test('コード枠の中は見ない（書き方の例を貼れる）', () => {
  const md = `## 2026-08-23
- 写真の上限をなくしました

\`\`\`
## 2026/08/23
- fix: これは例なので落とさない
\`\`\`
`;
  assert.deepEqual(errors(md), []);
});

test('言い回しは落とさず、言うだけ', () => {
  /* ⚠️ ここが error になると、書き手はこの検査を通さなくなる */
  const md = '## 2026-08-23\n- キャッシュを消しました\n';
  assert.deepEqual(errors(md), []);
  assert.ok(warns(md).some((f) => /届かない言葉/.test(f.message)));
});

test('トップで切られる本数を、書く前に知らせる', () => {
  const md = '## 2026-08-23\n- あれを直しました\n- これを直しました\n'
    + '- それを直しました\n- どれかを直しました\n';
  assert.deepEqual(errors(md), []);
  assert.ok(warns(md).some((f) => /黙って落ちる/.test(f.message)));
});

test('未来の日付は言うだけ（時計のずれで落としたくない）', () => {
  const md = '## 2026-12-31\n- 何かを直しました\n';
  assert.deepEqual(errors(md), []);
  assert.ok(warns(md).some((f) => /未来の日付/.test(f.message)));
});

test('空でも undefined でも落ちない', () => {
  assert.ok(lintChangelog('', TODAY).length);
  assert.ok(lintChangelog(undefined, TODAY).length);
});
