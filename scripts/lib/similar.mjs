/**
 * 文章がどれくらい似ているかを測る。
 *
 * なぜ要るのか:
 *   1回の生成では1週間ぶんをまとめて投げているので、その週のなかの重複は
 *   AI 自身が避けてくれる。避けられないのは週をまたいだほうである。
 *   同じアプリ・同じ型が数週間おきに回ってくるので、
 *   「先月とほとんど同じ文章」が出ても、これまで誰も気づけなかった。
 *   （履歴に本文が残っていなかったので、比べる相手がそもそも無かった。）
 *
 * どう測るか:
 *   日本語は単語で切るのが難しい。形態素解析を入れると実行時の依存が増え、
 *   それは CLAUDE.md §6 の方針に反する。
 *   代わりに文字2-gram（隣り合う2文字の集合）の Jaccard 係数を使う。
 *   語順が変わっても、言い回しを少し変えただけなら高い値になる。
 *   依存ゼロで、30行で書ける。
 *
 * ⚠️ この値だけで投稿を捨てない。
 *    同じアプリの話は、書き方を変えても文字が似る（アプリ名・教科・「授業」など）。
 *    閾値を強くすると、正しい投稿まで落ちて枠が空く。
 *    使い方は「書きなおしのときに、似ていることを指摘する」まで。
 *    捨てるかどうかを決めるのはガードレール（lib/lint.mjs）の仕事である。
 */

/** 比べる前に、意味に関わらない部分を落とす。 */
function normalize(text) {
    return String(text ?? '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/#[^\s#]+/g, '')
        // 記号と空白は落とす。読点の打ち方の違いで似ていないことにしない。
        .replace(/[\s、。，．,.!！?？「」『』（）()【】・…‥ー\-—–_"'"'`~〜]/g, '');
}

/** 文字2-gram の集合。1文字しか無いときは、その1文字を要素にする。 */
export function bigramsOf(text) {
    const chars = [...normalize(text)];
    if (chars.length === 0) return new Set();
    if (chars.length === 1) return new Set(chars);

    const out = new Set();
    for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
    return out;
}

/**
 * 2つの文章の似ぐあい（0〜1）。1 は同じ。
 * 片方が空なら 0（比べるものが無い＝似ていない、として扱う）。
 */
export function similarity(a, b) {
    const setA = bigramsOf(a);
    const setB = bigramsOf(b);
    if (setA.size === 0 || setB.size === 0) return 0;

    let shared = 0;
    // 小さいほうを回す。片方が長文（note の本文など）でも計算量が跳ねない。
    const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const gram of small) if (large.has(gram)) shared += 1;

    return shared / (setA.size + setB.size - shared);
}

/**
 * 過去の文章のなかから、いちばん似ているものを返す。
 *
 * @param {string} text
 * @param {{id?: string, date?: string, body: string}[]} past
 * @returns {{score: number, hit: object|null}}
 */
export function mostSimilar(text, past) {
    let best = { score: 0, hit: null };
    for (const item of past) {
        if (!item?.body) continue;
        const score = similarity(text, item.body);
        if (score > best.score) best = { score, hit: item };
    }
    return best;
}
