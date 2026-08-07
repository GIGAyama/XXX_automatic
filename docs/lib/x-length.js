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

const URL_PATTERN = /https?:\/\/[^\s<>"'）】」]+/g;

/** URL 1本の重み。t.co により実際の長さに関係なく固定。 */
export const URL_WEIGHT = 23;

/** X の上限。日本語だと実質140字。 */
export const MAX_WEIGHTED_LENGTH = 280;

export function weightedLength(text, urlWeight = URL_WEIGHT) {
  if (!text) return 0;

  const urls = text.match(URL_PATTERN) ?? [];
  const withoutUrls = text.replace(URL_PATTERN, '');

  let total = urls.length * urlWeight;
  for (const ch of withoutUrls) {
    const code = ch.codePointAt(0);
    total += SINGLE_WEIGHT_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? 1 : 2;
  }
  return total;
}
