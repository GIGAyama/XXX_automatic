/**
 * X の投稿文を組み立てて、長さを数える。
 *
 * 文字数の数え方が独特なので、素の String.length で判断すると必ずずれる。
 *   ・日本語などの全角文字は 2 文字として数えられる（上限280 = 日本語140字）
 *   ・URL は実際の長さに関係なく一律 23 文字として数えられる（t.co で短縮されるため）
 * 「140字以内のつもりが投稿できない」を防ぐため、ここで実測する。
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

/** X の数え方での長さ。 */
export function weightedLength(text, urlWeight = URL_WEIGHT) {
    if (!text) return 0;

    // URL は本文から抜いて、本数 × 23 を足す
    const urls = text.match(URL_PATTERN) ?? [];
    const withoutUrls = text.replace(URL_PATTERN, '');

    let total = urls.length * urlWeight;
    for (const ch of withoutUrls) {
        const code = ch.codePointAt(0);
        total += SINGLE_WEIGHT_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? 1 : 2;
    }
    return total;
}

/** 本文に含まれる URL。 */
export function extractUrls(text) {
    return text?.match(URL_PATTERN) ?? [];
}

/** URL・ハッシュタグ・空白を除いた「中身」の文字数。短すぎる投稿を弾くのに使う。 */
export function plainLength(text) {
    if (!text) return 0;
    return text
        .replace(URL_PATTERN, '')
        .replace(/#[^\s#]+/g, '')
        .replace(/\s+/g, '')
        .length;
}

/**
 * 絵文字の個数。
 * 見た目1個の絵文字が複数のコードポイントでできていること（家族の絵文字など）があるため、
 * Intl.Segmenter で書記素に割ってから数える。
 */
export function countEmoji(text) {
    if (!text) return 0;
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    let count = 0;
    for (const { segment } of segmenter.segment(text)) {
        if (/\p{Extended_Pictographic}/u.test(segment)) count += 1;
    }
    return count;
}

/** 本文に含まれるハッシュタグ。 */
export function extractHashtags(text) {
    return text?.match(/#[^\s#]+/g) ?? [];
}

/**
 * 投稿文を組み立てる。
 *
 * 本文・URL・ハッシュタグをこちらで結合するのは、
 * 生成 AI に全部書かせると URL を落としたり形式がぶれたりするためである。
 * AI には本文だけを書かせて、機械的に決まる部分は機械で付ける。
 */
export function composePost({ body, url, hashtags = [] }) {
    const parts = [String(body ?? '').trim()];
    if (url) parts.push(url);
    if (hashtags.length) {
        parts.push(hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).join(' '));
    }
    return parts.filter(Boolean).join('\n\n');
}
