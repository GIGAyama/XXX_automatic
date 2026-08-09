/**
 * アプリのリポジトリに用意されている note 記事を読むところ。
 *
 * なぜ要るのか:
 *   note の記事は、これまで週次が Gemini に書かせるものだけだった（scripts/generate-note.mjs）。
 *   けれど実際には、アプリを作った本人がそのアプリの中で記事を書き上げていることがある。
 *   KANJI_Town でいえば docs/note/ に、本文（約7,900字）と実際に操作して撮った画面が27点、
 *   さらに「note に貼る手順」を書いた README まで置いてある。
 *   これは機械が書いたものより中身が濃いのに、投稿ランチャーからは存在しないものだった。
 *   結果として、いちばん出したい記事だけが手作業のまま残っていた。
 *
 * 何をするか:
 *   置いてある Markdown を、note に貼れる形（plain）と、画像の並び（何番目にどれを入れるか）に分ける。
 *   note には公式 API が無いので、貼るのも画像を上げるのも人の手になる。
 *   だからここでの仕事は「順番どおりに、迷わず渡せる形にする」ことである。
 *
 * ⚠️ 記事の中身は書きかえない。
 *    人が書いたものを機械が直すと、直した理由が本人に伝わらないまま文章が変わる。
 *    体裁の指摘（lib/note-lint.mjs）は別に出して、直すかどうかは本人が決める。
 *
 * ここは fetch もファイル読み書きも触らない純粋関数だけにしてある（tests/note-article.test.mjs 用）。
 */
import { MAX_ARTICLE_IMAGES } from '../../docs/lib/note-doc.js';
import { dirOf, isImagePath, resolvePath } from './repo-images.mjs';

/** 記事だと認めるいちばん短い長さ。これ未満は入稿メモや書きかけとみなす。 */
export const MIN_ARTICLE_CHARS = 1200;

/** 画像のすぐ下に置かれた一文を、その画像の説明とみなす長さの上限。 */
const CAPTION_MAX_CHARS = 120;

/** 記事の置き場。`docs/note/` や `note/` の下にある Markdown を候補にする。 */
const NOTE_DIR = /(^|\/)note(s)?(\/|$)/i;

/** 名前から記事だと分かるもの。置き場が違っても拾えるようにする第二の網。 */
const ARTICLE_NAME = /note[-_]?article|article[-_]?note/i;

/** 入稿メモ・目次のたぐい。本文ではないので候補から外す。 */
const NOT_ARTICLE_NAME = /^(readme|index|_index|contributing|changelog|license)\.md$/i;

const TITLE_RE = /^#\s+(.+?)\s*$/;
const HEADING_RE = /^(#{2,6})\s+(.+?)\s*$/;
const IMAGE_RE = /^!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)\s*$/;

/** そのパスが「用意された記事」らしいか。 */
export function isNoteArticlePath(filePath) {
    const path = String(filePath ?? '');
    if (!/\.md$/i.test(path)) return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (NOT_ARTICLE_NAME.test(name)) return false;
    return NOTE_DIR.test(dirOf(path)) || ARTICLE_NAME.test(name);
}

/**
 * git tree の中身から、用意された記事を選ぶ。
 *
 * 1つのリポジトリに何本もあることがある（連載で2回書いたアプリなど）。
 * 並びはパスの辞書順にする。tree の返す順に頼ると、
 * 同じリポジトリを取りなおしただけで並びが変わり、ファイル名（id）がずれる。
 *
 * @param {{path: string, type?: string}[]} entries
 * @param {number} [limit] 1リポジトリから拾う上限
 * @returns {string[]} 記事のパス
 */
export function pickArticlePaths(entries, limit = 5) {
    return (entries ?? [])
        .filter((entry) => entry && (entry.type ?? 'blob') === 'blob')
        .map((entry) => entry.path)
        .filter((path) => isNoteArticlePath(path))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, Math.max(0, limit));
}

/**
 * その記事が使えそうな画像の一覧。記事と同じディレクトリの下だけを見る。
 *
 * 本文が指している画像が本当にリポジトリにあるかを、あとで確かめるために控える。
 * 無いものを指したまま配ると、ランチャーには壊れたサムネイルが並び、
 * しかも「なぜ出ないのか」がどこにも出ない。
 *
 * @param {{path: string, type?: string}[]} entries
 * @param {string} articlePath
 * @returns {string[]}
 */
export function assetPathsFor(entries, articlePath) {
    const dir = dirOf(articlePath);
    const prefix = dir ? `${dir}/` : '';
    return (entries ?? [])
        .filter((entry) => entry && (entry.type ?? 'blob') === 'blob')
        .map((entry) => entry.path)
        .filter((path) => path.startsWith(prefix) && isImagePath(path))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Markdown を、貼り付け用の本文と画像の並びに分ける。
 *
 * 記事の書き方は実例（KANJI_Town / Qalc）にそろえてある。
 *   # タイトル
 *   ## 🏫 見出し
 *   本文の段落
 *   ![説明](images/01-home.png)
 *   画像の下に置く一文
 *   #ハッシュタグ #ハッシュタグ
 *
 * @param {string} markdown  記事の中身
 * @param {object} options
 * @param {string} options.path            リポジトリ内での記事のパス（画像の相対指定を解くのに要る）
 * @param {string[]} [options.assetPaths]  そのリポジトリに実在する画像のパス
 * @returns {{title: string, plain: string, charCount: number, tags: string[],
 *            images: {n: number, path: string, label: string, caption: string, external: boolean, missing: boolean}[],
 *            problems: string[]}}
 */
export function parseArticle(markdown, { path, assetPaths = [] } = {}) {
    const dir = dirOf(String(path ?? ''));
    const known = new Set(assetPaths);
    const lines = String(markdown ?? '').split(/\r?\n/);

    let title = '';
    const blocks = [];
    let paragraph = [];

    // 段落は空行で切れる。溜めてある行を1つのかたまりにして流す。
    const flush = () => {
        if (paragraph.length === 0) return;
        blocks.push({ kind: 'text', text: paragraph.join('\n') });
        paragraph = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') {
            flush();
            continue;
        }

        if (!title) {
            const hit = TITLE_RE.exec(trimmed);
            if (hit) {
                title = hit[1];
                continue;
            }
        }

        const heading = HEADING_RE.exec(trimmed);
        if (heading) {
            flush();
            blocks.push({ kind: 'heading', text: heading[2] });
            continue;
        }

        const image = IMAGE_RE.exec(trimmed);
        if (image) {
            flush();
            blocks.push({ kind: 'image', alt: image[1].trim(), target: image[2] });
            continue;
        }

        paragraph.push(trimmed);
    }
    flush();

    const images = [];
    for (const [at, block] of blocks.entries()) {
        if (block.kind !== 'image') continue;

        const external = /^[a-z][a-z0-9+.-]*:/i.test(block.target);
        const resolved = external ? block.target : resolvePath(dir, block.target);

        // 画像のすぐ下の一文を、その画像の説明として控える。
        // note では画像とキャプションが別の欄になっているので、渡すときに分けて見せられると手数が減る。
        // ただし本文からは消さない。ここの見立てを外したときに、文章が1段落ぶん消えることになる。
        const next = blocks[at + 1];
        const caption =
            next?.kind === 'text' && !next.text.includes('\n') && next.text.length <= CAPTION_MAX_CHARS
                ? next.text
                : '';

        const n = images.length + 1;
        images.push({
            n,
            path: resolved,
            label: block.alt || labelFromFile(resolved),
            caption,
            external,
            // 実在するかを確かめられるのは、リポジトリの中を指しているものだけ。
            // 一覧を渡されていないときは判定しない（「分からない」を「無い」にしない）。
            missing: !external && known.size > 0 && !known.has(resolved),
        });
        block.n = n;
        block.label = block.alt || labelFromFile(resolved);
    }

    const tags = tagsIn(blocks);
    const plain = toPlainText(title, blocks);

    return {
        title,
        plain,
        charCount: plain.length,
        tags,
        images,
        problems: problemsIn({ title, plain, blocks, images }),
    };
}

/**
 * note のエディタに貼り付ける本文。
 *
 * note は Markdown 記法をそのまま解釈しない。「## 見出し」を貼ると
 * 「## 見出し」という文字列がそのまま残る。だから記号を落として、
 * 見出しは前後の空行だけで区切る（scripts/generate-note.mjs と同じ扱い）。
 *
 * 画像は自動では入らないので、記法のかわりに「ここに入れる」と番号つきで書く。
 * 番号は画面に出る画像の並びと同じなので、上から順に渡していけば迷わない。
 */
export function toPlainText(title, blocks) {
    const parts = title ? [title, ''] : [];

    for (const block of blocks) {
        if (block.kind === 'image') {
            parts.push(`［画像${block.n}: ${block.label}］`, '');
            continue;
        }
        // 絵文字は見出しの目印なので残す。note で見出しにするときの手がかりになる。
        parts.push(block.text, '');
    }

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 末尾に置かれたハッシュタグの行から、タグを拾う。 */
function tagsIn(blocks) {
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
        const block = blocks[at];
        if (block.kind !== 'text') continue;
        const words = block.text.split(/\s+/).filter(Boolean);
        // 全部が # で始まる行だけをタグの行とみなす。本文の途中に出てくる
        // 「#GIGAスクール のこと」のような書き方を巻きこまないため。
        if (words.length > 0 && words.every((word) => /^#\S+$/.test(word))) {
            return words.map((word) => word.slice(1));
        }
        // タグの行は末尾にある。本文の段落に当たった時点で打ち切る。
        return [];
    }
    return [];
}

/**
 * そのまま出すと困るところ。
 *
 * ⚠️ ここで捨てない。捨てると「用意したのに出てこない」になり、
 *    しかも理由が画面のどこにも出ない。伝えて、出すかどうかは本人が決める。
 */
function problemsIn({ title, plain, blocks, images }) {
    const problems = [];

    if (!title) problems.push('1行目に「# タイトル」がありません（note のタイトル欄に貼るものです）');
    if (plain.length < MIN_ARTICLE_CHARS) {
        problems.push(`本文が ${plain.length} 字しかありません（記事なら ${MIN_ARTICLE_CHARS} 字は超えるはずです）`);
    }
    if (!blocks.some((block) => block.kind === 'heading')) {
        problems.push('見出し（## 〜）が1つもありません');
    }

    const missing = images.filter((image) => image.missing);
    if (missing.length > 0) {
        problems.push(
            `本文が指している画像 ${missing.length} 点がリポジトリにありません: ${missing.map((i) => i.path).join(', ')}`
        );
    }

    const external = images.filter((image) => image.external);
    if (external.length > 0) {
        problems.push(
            `よそのアドレスを指した画像が ${external.length} 点あります（ランチャーからは渡せません）: ${external
                .map((i) => i.path)
                .join(', ')}`
        );
    }

    if (images.length > MAX_ARTICLE_IMAGES) {
        problems.push(`画像が ${images.length} 点あります（${MAX_ARTICLE_IMAGES} 点までを渡せる形にします）`);
    }

    return problems;
}

/** '01-home.png' のような名前を、そのまま見出しにできる形にする。 */
function labelFromFile(filePath) {
    const name = String(filePath).slice(String(filePath).lastIndexOf('/') + 1);
    return (
        name
            .replace(/\.[a-z0-9]+$/i, '')
            .replace(/^\d{1,3}[-_]/, '')
            .replace(/[-_]+/g, ' ')
            .trim() || name
    );
}
