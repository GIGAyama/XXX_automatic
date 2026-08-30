#!/usr/bin/env node
/**
 * 【正本】standards/agents/hooks/announce-checks.mjs
 * 配布先へは .claude/hooks/announce-checks.mjs としてコピーする（中身は変えない）。
 *
 * セッションの初めに、「このリポジトリで実際に走る検査」だけを並べて出す。
 *
 * ── なぜ要るのか ──────────────────────────────────────
 *
 * ルール文書にはこう書いてある。
 *
 *   「そのリポジトリに在るものだけを走らせること。無いものを走らせて
 *     ENOENT で止まるのは『検査に通っていない』であって『検査が無い』ではない」
 *
 * ところが在るかどうかは、42 本それぞれで違う。v5 ゲートは 18 本、
 * `tools/build-sw.mjs` は 25 本、`npm run check` は 33 本にしかない。
 * 毎回 `package.json` を開いて確かめるのは、人にもエージェントにも続かない。
 * 続かない手順は、いずれ「たぶん在るだろう」に置き換わる。
 *
 * だから機械が数えて、実在するものだけを最初に出す。
 * SessionStart の標準出力は、そのまま文脈に入る。
 *
 * ⚠️ 出す内容は「実在するもの」に限ること。ここに在りもしないコマンドを
 *    並べると、この hook 自身が「無いものを走らせる」原因になる。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * このリポジトリで実際に走る検査コマンドを並べる。
 *
 * @param {string} root リポジトリ直下
 * @param {object} deps テスト用の差しかえ口
 * @returns {string[]} 走らせてよいコマンド（実在するものだけ）
 */
export function availableChecks(root, deps = {}) {
  const { exists = fs.existsSync, read = fs.readFileSync } = deps;
  const out = [];
  const has = (p) => exists(path.join(root, p));
  const readSafe = (p, r) => { try { return String(r(p, 'utf8')); } catch { return ''; } };

  let scripts = {};
  if (has('package.json')) {
    try { scripts = JSON.parse(read(path.join(root, 'package.json'), 'utf8')).scripts || {}; }
    catch { scripts = {}; }
  }

  // 並びは「速いものから」。落ちたら先へ進まないので、安いものを先に置く。
  if (scripts.typecheck) out.push('npm run typecheck');
  if (scripts.test) out.push('npm test');
  if (scripts.build) out.push('npm run build');
  /* ⚠️ 「build のあとに」は、build が在るリポジトリでしか言わない。
        無いところで言うと、この hook 自身が事実と違うことを教えることになる。 */
  if (scripts.check) {
    out.push(scripts.build
      ? 'npm run check    ★ build のあとに走らせること（dist/ を読む検査があるため）'
      : 'npm run check');
  }
  /* ⚠️ 中身を見てから出す。`--check` を受けつけない build-sw.mjs が在る
        （手書きのもの、正本が古いまま配られたもの）。受けつけない版に
        `--check` を渡すと、黙って無視して **dist/sw.js を書き換える**。
        検査のつもりで走らせた人の作業ツリーが変わるうえ、レビューでは
        「検査は通った」と読まれる。この hook 自身が「無いものを走らせる」
        原因にならないよう、実在を字で確かめる。 */
  if (has('tools/build-sw.mjs') && readSafe(path.join(root, 'tools/build-sw.mjs'), read).includes('--check')) {
    out.push('node tools/build-sw.mjs --check');
  }

  /* 正本整合性。配布先に standards/ は無いので、ポータルを隣に置いて指す。
     ⚠️ `node standards/check-drift.mjs` と打つと配布先では必ず ENOENT。
        この 1 行を出さないと、そのたびに間違える。 */
  if (has('standards-map.json')) {
    out.push(has('standards/check-drift.mjs')
      ? 'node standards/check-drift.mjs --standards standards'
      : 'node ../GIGAyama.github.io/standards/check-drift.mjs --standards ../GIGAyama.github.io/standards');
  }
  return out;
}

/** 文脈に入れる文面。無いなら黙る（空文字を返す） */
export function announcement(root, deps = {}) {
  const checks = availableChecks(root, deps);
  if (checks.length === 0) return '';
  return [
    '## このリポジトリで実際に走る検査（実在を確認したものだけ）',
    '',
    '```bash',
    ...checks,
    '```',
    '',
    'ここに無いものは、このリポジトリには在りません。走らせて ENOENT で',
    '止まるのは「検査に通っていない」であって「検査が無い」ではありません。',
    '',
    '検査は**直し終わってから**走らせます。途中で通しても、そのあとの 1 行で',
    '崩れます。とくに SW の版は配信物の中身から作るので、最後に 1 文字',
    '直しただけで合わなくなり、CI で初めて赤くなります。',
  ].join('\n');
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith('announce-checks.mjs');
if (invokedDirectly) {
  try {
    const text = announcement(process.cwd());
    if (text) process.stdout.write(text + '\n');
  } catch { /* 出せなくてもセッションは始める */ }
  process.exit(0);
}
