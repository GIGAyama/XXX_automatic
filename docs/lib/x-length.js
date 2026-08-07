/**
 * X の数え方で本文の長さを測る（ブラウザ側）。
 *
 * 本文をその場で直せるようにした以上、直した結果が投稿できる長さなのかを
 * その場で出さないと意味がない。生成時の判定（scripts/lib/lint.mjs）と
 * 同じ数え方でなければ「画面では 268 なのに X で弾かれる」が起きる。
 *
 * scripts/lib/x-text.mjs の weightedLength と同じ規則を写している。
 * ずれないことは tests/docs-x-length.test.mjs が両方を import して確かめている。
 */

/** X が「1文字」として数える文字の範囲。ここに入らない文字は 2 文字ぶんになる。 */
const SINGLE_WEIGHT_RANGES = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

/**
 * URL とみなす文字列。scripts/lib/x-text.mjs と同じ規則の写し。
 *
 * https:// が無くても X は自動でリンクにして t.co に短縮するので、ここも拾う。
 * 拾わないと「画面では あと10字入る と出ているのに X が弾く」が起きる。
 *
 * ⚠️ 後読み（lookbehind）を使わない。iOS Safari が対応したのは 16.4 で、
 *    それ以前の端末では正規表現の時点で構文エラーになり、この画面が丸ごと出なくなる。
 *    直前の1文字は捨てグループ（$1）で受けている。置換は '$1' で戻すこと。
 */
const TLDS =
  'com|net|org|jp|io|dev|app|me|co|ai|edu|gov|info|biz|site|page|link|blog|shop|tech|xyz|cloud|tv|fm|ly|gl|be|to|cc';

const URL_PATTERN = new RegExp(
  `(^|[^\\w@.\\-/])` +
    `(` +
    `https?://[^\\s<>"'）】」]+` +
    `|` +
    `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9-])(?:/[^\\s<>"'）】」]*)?` +
    `)`,
  'gi'
);

/** URL 1本の重み。t.co により実際の長さに関係なく固定。 */
export const URL_WEIGHT = 23;

/** X の上限。日本語だと実質140字。 */
export const MAX_WEIGHTED_LENGTH = 280;

/** 本文に含まれる URL。 */
export function extractUrls(text) {
  if (!text) return [];
  return [...String(text).matchAll(URL_PATTERN)].map((m) => m[2]);
}

export function weightedLength(text, urlWeight = URL_WEIGHT) {
  if (!text) return 0;

  const urls = extractUrls(text);
  const withoutUrls = String(text).replace(URL_PATTERN, '$1');

  let total = urls.length * urlWeight;
  for (const ch of withoutUrls) {
    const code = ch.codePointAt(0);
    total += SINGLE_WEIGHT_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? 1 : 2;
  }
  return total;
}
