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

/**
 * URL とみなす文字列。
 *
 * ⚠️ https:// が無いものも拾う。
 *    X は「ドメインらしき文字列」を自動でリンクにして t.co に短縮する。
 *    つまり本文に `gigayama.github.io/Typa/` と書いた投稿は、
 *    本文に外部リンクがある投稿として扱われ、リーチが大きく下がる。
 *    本文からリンクを外すのはこのリポジトリの中心的な判断なのに、
 *    スキーム付きしか見ていなかったせいで、生成側と配信側の二重の検査が
 *    どちらも同じ穴を持っていた。
 *
 *    広げすぎると「app.js を直しました」「1.5倍」まで URL 扱いになって投稿が作れなくなる。
 *    そこで末尾は既知の TLD だけに限る。
 *
 * ⚠️ 後読み（lookbehind）を使わない。
 *    iOS Safari が対応したのは 16.4 で、それ以前の端末では正規表現の時点で
 *    構文エラーになり、ランチャーが丸ごと白い画面になる。
 *    代わりに直前の1文字を捨てグループ（$1）で受けている。
 *    置換のときは '$1' で戻すこと（'' にすると1文字消える）。
 */
const TLDS =
    'com|net|org|jp|io|dev|app|me|co|ai|edu|gov|info|biz|site|page|link|blog|shop|tech|xyz|cloud|tv|fm|ly|gl|be|to|cc';

const URL_PATTERN = new RegExp(
    // ① 直前の1文字（行頭も可）。@ や / や英数字のあとは URL の始まりではない
    `(^|[^\\w@.\\-/])` +
        // ② URL 本体
        `(` +
        // ②-a スキーム付き。ホスト名を限定しない（localhost や見慣れない TLD も通す）
        `https?://[^\\s<>"'）】」]+` +
        `|` +
        // ②-b スキームなし。「ラベル.」の繰り返し + 既知の TLD + 任意のパス
        `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9-])(?:/[^\\s<>"'）】」]*)?` +
        `)`,
    'gi'
);

/** URL 1本の重み。t.co により実際の長さに関係なく固定。 */
export const URL_WEIGHT = 23;

/** X の数え方での長さ。 */
export function weightedLength(text, urlWeight = URL_WEIGHT) {
    if (!text) return 0;

    // URL は本文から抜いて、本数 × 23 を足す
    const urls = extractUrls(text);
    const withoutUrls = String(text).replace(URL_PATTERN, '$1');

    let total = urls.length * urlWeight;
    for (const ch of withoutUrls) {
        const code = ch.codePointAt(0);
        total += SINGLE_WEIGHT_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? 1 : 2;
    }
    return total;
}

/** 本文に含まれる URL。 */
export function extractUrls(text) {
    if (!text) return [];
    return [...String(text).matchAll(URL_PATTERN)].map((m) => m[2]);
}

/** URL・ハッシュタグ・空白を除いた「中身」の文字数。短すぎる投稿を弾くのに使う。 */
export function plainLength(text) {
    if (!text) return 0;
    return text
        .replace(URL_PATTERN, '$1')
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

/** リンクを置く返信に添える一言。毎回同じだと機械が書いたように見えるので、投稿ごとに変える。 */
const LINK_LINES = [
    'アプリはこちらです。ブラウザで開くだけで使えます。',
    '使ってみたい方はこちらからどうぞ。登録は要りません。',
    'こちらで公開しています。無料で、そのまま授業で使えます。',
    '実物はこちらです。インストールは要りません。',
];

/**
 * 1つの投稿を「連投の手順」に組み立てる。
 *
 * ⚠️ 本文に URL を入れない（urlPlacement が 'reply' のとき）。
 *    X は本文に外部リンクがある投稿のリーチを大きく下げる。
 *    Premium でないアカウントだと、ほとんど誰にも表示されない。
 *    費用の面では本文に入れて困らないが、読まれないなら発信した意味がない。
 *    本文はリンク無しで書き、リンクは最初の返信に置く。
 *
 * @param {object} input
 * @param {string} input.body        本文（リンクなし）
 * @param {string[]} [input.thread]  連投で続けるぶん
 * @param {string} input.url         アプリの URL
 * @param {string[]} [input.hashtags]
 * @param {string} [input.placement] 'reply'（既定）か 'body'
 * @param {number} [input.seed]      添える一言を選ぶための種。同じ投稿なら毎回同じ文になる
 * @returns {{kind:string,label:string,text:string}[]}
 */
export function composeSteps({ body, thread = [], url, hashtags = [], placement = 'reply', seed = 0 }) {
    const tags = hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
    const steps = [];

    if (placement === 'body') {
        // 従来どおり本文に URL を入れる形。リーチは落ちるが、設定で選べるようにしてある。
        steps.push({ kind: 'main', label: '本文', text: composePost({ body, url, hashtags }) });
    } else {
        steps.push({
            kind: 'main',
            label: '本文',
            text: [String(body ?? '').trim(), tags.join(' ')].filter(Boolean).join('\n\n'),
        });
    }

    for (const [i, part] of thread.entries()) {
        const text = String(part ?? '').trim();
        if (text) steps.push({ kind: 'thread', label: `つづき ${i + 1}`, text });
    }

    if (placement !== 'body' && url) {
        const line = LINK_LINES[Math.abs(seed) % LINK_LINES.length];
        steps.push({ kind: 'link', label: 'リンクの返信', text: `${line}\n${url}` });
    }

    return steps;
}

/** 文字列から安定した数を作る。添える一言を投稿ごとに変えるのに使う（毎回同じ投稿なら同じ文になる）。 */
export function seedFrom(text) {
    let h = 0;
    for (let i = 0; i < String(text).length; i += 1) h = (Math.imul(h, 31) + String(text).charCodeAt(i)) | 0;
    return h;
}

/** 最初の1行。タイムラインで最初に目に入るのはここだけなので、別に扱う。 */
export function hookOf(text) {
    return String(text ?? '').split('\n')[0].trim();
}
