/**
 * アプリのリポジトリに用意された note 記事の、配る形。
 *
 * ⚠️ このファイルはブラウザ（docs/app.js）と Node（scripts/collect-note-articles.mjs）の
 *    両方から import される。書く側と読む側でスキーマが二重定義されると、
 *    片方だけ直したときに黙って取りこぼす。定義はここ1つにする。
 *    そのため DOM にも node: モジュールにも依存してはいけない。
 *    docs/lib/order.js とまったく同じ約束である。
 *
 * ── なぜ本文を launcher.json に載せないのか ─────────────
 *
 * 記事は1本7,900字ほどある。画像の説明まで入れると1本で 25KB を超える。
 * launcher.json は画面を開くたびに必ず読むファイルなので、
 * そこに全部を混ぜると、note を出さない日の起動まで重くなる。
 * 一覧（見出しだけ）を launcher.json に載せ、本文は開いたときに読みにいく。
 *
 * ── 画像について ────────────────────────────────
 *
 * note に画像を上げる公式の口は無い。だから「1枚ずつ共有シートに渡す」形にしてある。
 * 画像そのものはアプリのリポジトリに置いたままで、raw.githubusercontent.com から直接読む
 * （このリポジトリに取り込むと、1本ぶんで数MB が毎週のコミットに乗る）。
 * 行き先の確認は docs/lib/media-pick.js の isAllowedMediaSrc に任せる。規則を2か所に置かない。
 */

import { isAllowedMediaSrc } from './media-pick.js';

/** 記事ファイル（docs/note-articles/<id>.json）の目印。 */
export const ARTICLE_SCHEMA_ID = 'note-article/v1';

/** 記事ファイルを置くディレクトリ（docs/ からの相対）。 */
export const ARTICLES_DIR = 'note-articles';

/**
 * 記事の id。
 *
 * ⚠️ これがそのままファイル名（docs/note-articles/<id>.json）になる。
 *    もとはアプリのリポジトリ名（GitHub から来る文字列）なので、
 *    docs/orders/ の注文IDと同じく、形を決めて受け取る側で必ず照合する。
 *    ここを緩めると、リポジトリ名しだいで docs/ の好きな場所を指せてしまう。
 */
export const ARTICLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 記事1本に並べる画像の上限。実例で27点なので、その倍を上限にしておく。 */
export const MAX_ARTICLE_IMAGES = 60;

/** id から記事ファイルの場所を決める。書く側と読む側で必ず同じ式を使う。 */
export function articlePathOf(id) {
    const value = String(id ?? '');
    // '..' を含む名前は ARTICLE_ID_RE を通らない（'.' は使えるが先頭には来られない）。
    if (!ARTICLE_ID_RE.test(value)) throw new Error(`記事の id の形が違います: ${id}`);
    return `${ARTICLES_DIR}/${value}.json`;
}

/**
 * 読みこんだ記事が、そのまま画面に出してよい形かを確かめる。
 *
 * 生成物とはいえ素通しにしない。ここに入ってくるのは
 * 「アプリのリポジトリに置いてある文章」で、このリポジトリの外で書かれたものである。
 *
 * @param {any} article  読みこんだ JSON
 * @param {{id?: string}} [expected]
 * @returns {{ok: boolean, errors: string[], article: object|null}}
 */
export function validateArticle(article, { id } = {}) {
    if (!article || typeof article !== 'object') return { ok: false, errors: ['JSON として読めません'], article: null };

    const errors = [];
    if (article.schema !== ARTICLE_SCHEMA_ID) errors.push(`schema が ${ARTICLE_SCHEMA_ID} ではありません: ${article.schema}`);
    if (id && article.id !== id) errors.push(`別の記事です: ${article.id}`);
    if (typeof article.plain !== 'string' || article.plain.trim() === '') errors.push('本文がありません');
    if (typeof article.title !== 'string' || article.title.trim() === '') errors.push('タイトルがありません');
    if (article.images !== undefined && !Array.isArray(article.images)) errors.push('images が配列ではありません');

    if (errors.length > 0) return { ok: false, errors, article: null };

    return { ok: true, errors: [], article: normalizeArticle(article) };
}

/**
 * 画面が読む形にそろえる。
 *
 * 渡せない画像（行き先が想定外・番号が無い）はここで落とす。
 * 落とさずに並べると、押しても何も起きないボタンが混ざる。
 * それは「壊れている」と区別がつかない。
 */
export function normalizeArticle(article) {
    const images = (article.images ?? [])
        .filter((image) => image && typeof image.src === 'string' && isAllowedMediaSrc(image.src))
        // 相対パス（このサイトの中）は記事の画像としてはありえない。実体はアプリのリポジトリにある。
        .filter((image) => /^https:\/\//i.test(image.src))
        .slice(0, MAX_ARTICLE_IMAGES)
        .map((image, at) => ({
            n: Number.isFinite(image.n) ? image.n : at + 1,
            src: image.src,
            label: String(image.label ?? `画像${at + 1}`),
            caption: String(image.caption ?? ''),
        }));

    return {
        id: String(article.id),
        repo: String(article.repo ?? ''),
        title: String(article.title),
        plain: String(article.plain),
        charCount: Number(article.charCount ?? article.plain.length),
        tags: (article.tags ?? []).map((tag) => String(tag).replace(/^#/, '')).filter(Boolean),
        images,
        // 本文が指しているのに渡せない画像がある、という事実を伏せない。
        // 「16点あるはずが15点しか出ない」を、画面で言えるようにしておく。
        imagesInText: Number(article.imagesInText ?? images.length),
        problems: (article.problems ?? []).map(String),
        styleWarnings: (article.styleWarnings ?? []).map(String),
        sourceUrl: typeof article.sourceUrl === 'string' ? article.sourceUrl : '',
        path: String(article.path ?? ''),
    };
}

/**
 * launcher.json に載せる、記事1本ぶんの見出し。
 *
 * 本文（7,900字）と画像の説明は入れない。ここに入れると、
 * note を出さない日の起動まで重くなる。src を頼りに、開いたときだけ読みにいく。
 */
export function toIndexEntry(article) {
    return {
        id: article.id,
        repo: article.repo,
        title: article.title,
        charCount: article.charCount,
        imageCount: (article.images ?? []).length,
        // 「気をつけること」があること自体は、開く前に分かったほうがよい。中身は本文と一緒に読む。
        problems: (article.problems ?? []).length,
        styleWarnings: (article.styleWarnings ?? []).length,
        src: articlePathOf(article.id),
    };
}

/**
 * 画像の番号から、本文のどの目印に対応するかを返す。
 *
 * 本文には ［画像3: 採点の内訳］ と入っている（scripts/lib/note-article.mjs）。
 * 渡すときに同じ文字列を見せられないと、27点ある記事では
 * 「いま何番目を上げているのか」が分からなくなる。
 */
export function markerFor(image) {
    return `［画像${image.n}: ${image.label}］`;
}
