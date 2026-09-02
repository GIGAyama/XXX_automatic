/* 撮影の土台（capture.mjs）が、撮る相手の CSP を破らないことを見る。
 *
 * ── なぜ要るのか ────────────────────────────────
 * 艦隊のアプリは Zero-CDN のために `style-src 'self'` を張っている。
 * ページの中へ <style> を 1 枚差しこむと、そのつど
 * 「Refused to apply inline style」がコンソールに出る。
 * capture.mjs は画面のエラーを集めて --strict で異常終了するので、
 * **CSP をきちんと張っているアプリほど --strict が使えなくなる**。
 * しかも差しこんだ CSS は当たっていないので、消したかったふりがなも消えない。
 *
 * 2026-09-02、さんすうブロックのマニュアル撮影で実際に踏んだ。
 * text() / has() / waitFor() / expect() が内側で visibleText() を呼ぶため、
 * 画面を 1 度読むたびに 1 件ずつ増える。
 *
 * ⚠️ 要素の `.style` へ代入するぶんは CSP に止められない（HTML に書かれた
 *    style 属性だけが止まる）。だから「差しこまない」ほうへ倒す。
 *
 * ここはブラウザを起動せずに、ページの中で走る文字列そのものを読む。
 * playwright が入っていない場所でも走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'capture.mjs'), 'utf8');

/** ページの中へ送りこまれる文字列（IN_PAGE）だけを取り出す */
function inPage() {
  const m = SRC.match(/const IN_PAGE = `([\s\S]*?)`;/);
  assert.ok(m, 'IN_PAGE が見つからない。名前を変えたなら、この検査も直す');
  return m[1];
}

test('ページの中へ <style> を差しこまない（style-src self を破らない）', () => {
  const src = inPage();
  assert.ok(
    !/createElement\(\s*['"]style['"]\s*\)/.test(src),
    'IN_PAGE が <style> を作っている。style-src \'self\' のアプリでは'
    + ' 1 回読むたびに CSP 違反が 1 件出て、--strict が使えなくなる',
  );
  assert.ok(
    !/\badoptedStyleSheets\b|\binsertRule\b/.test(src),
    'IN_PAGE がページのスタイルシートを触っている。要素の .style へ代入する形にする',
  );
});

test('ふりがなは 要素の .style で隠して、読み終わったら戻す', () => {
  const src = inPage();
  assert.match(src, /querySelectorAll\('rt, rp'\)/,
    'rt / rp を集めていない。visibleText() がふりがなを落とせていない');
  assert.match(src, /style\.display = 'none'/,
    'ふりがなを .style で隠していない');
  assert.match(src, /finally \{[\s\S]*?style\.display = prev\[i\]/,
    '隠したふりがなを戻していない。撮った絵からふりがなが消える');
});

test('ページ全体へ CSS を配る道具（freeze）を IN_PAGE に持ちこんでいない', () => {
  const src = inPage();
  assert.ok(!/animation-play-state/.test(src),
    'IN_PAGE に freeze の CSS が入っている。freeze は addStyleTag の側の仕事');
});
