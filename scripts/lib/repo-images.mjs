/**
 * アプリのリポジトリに置いてある画像から、投稿に添えられそうなものを選ぶ。
 *
 * なぜ要るのか:
 *   紹介カードの複数コマは Playwright が「1.8秒待ってもう1枚撮る」だけなので、
 *   画面が自分から動くアプリでないと同じ絵が並ぶ。
 *   いっぽう note の記事を書くときに、実際にアプリを操作して撮った画像が
 *   すでにリポジトリへ置いてある（docs/note/images/01-home.png のような形）。
 *   機械には作れない「操作した結果の画面」なので、これを使えるようにする。
 *
 * 置き場所は repo ごとに違う（docs/note/images/ だったり docs/screenshot-*.png だったり）。
 * 決め打ちにすると次に作ったアプリで拾えないので、
 * 「画像であること」から始めて、アイコン類を落とす形にしてある。
 *
 * ⚠️ アイコンを落とすのは名前と大きさの両方で見る。
 *    docs/icons/ に置く repo（SchoolPlan_Editor）と public/ に置く repo（Reversi）が
 *    どちらもあるので、片方だけでは漏れる。
 *
 * ここは DOM も fetch も触らない純粋関数だけにしてある（tests/repo-images.test.mjs 用）。
 */

/** 既定の設定。config/media.json の repoImages で上書きできる。 */
export const DEFAULT_REPO_IMAGES = {
    enabled: true,
    maxPerRepo: 24,
    // アイコンは大きいものでも 90KB ほど。実際のスクリーンショットは 200KB を超える。
    // 名前の規則を外したアイコンを落とすための二段目の網である。
    minBytes: 30_000,
    // X が受け取れる画像の上限が 5MB。それより大きいものは渡しても弾かれる。
    maxBytes: 5_000_000,
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
};

/** アイコンやロゴだと分かる名前。投稿に添えても意味がないので候補から外す。 */
const ICON_NAME = /(favicon|apple-touch|maskable|splash|og[-_]?image|social[-_]?card|banner|^logo|[-_]logo|^icon[-_.]|[-_]icon\.|pwa[-_]?\d)/i;

/** アイコン置き場。ディレクトリ名で分かるものはここで落とす。 */
const ICON_DIR = /(^|\/)(icons?|favicons?|logos?)(\/|$)/i;

/** 先頭の連番（01-home.png の 01）。記事に並べた順そのものなので、並べ替えの第一基準にする。 */
const LEADING_NUMBER = /(^|\/)(\d{1,3})[-_]/;

/**
 * そのパスが入っているディレクトリ。ルート直下なら空文字。
 * lastIndexOf('/') をそのまま slice に渡すと、'README.md' が 'README.m' になる。
 */
function dirOf(filePath) {
    const at = String(filePath).lastIndexOf('/');
    return at < 0 ? '' : String(filePath).slice(0, at);
}

/** そのパスがアイコン類か。 */
export function isIconLike(filePath) {
    const path = String(filePath ?? '');
    const name = path.slice(path.lastIndexOf('/') + 1);
    return ICON_DIR.test(path) || ICON_NAME.test(name);
}

/** 拡張子が画像か。 */
export function isImagePath(filePath, extensions = DEFAULT_REPO_IMAGES.extensions) {
    const dot = String(filePath ?? '').lastIndexOf('.');
    if (dot < 0) return false;
    const ext = filePath.slice(dot + 1).toLowerCase();
    return extensions.map((e) => e.toLowerCase()).includes(ext);
}

/**
 * 並び順。記事に載せた順（連番）→ パスの辞書順、で決める。
 * 連番が無いものは後ろに置く。01, 02, ... 10 が 1, 10, 2 にならないよう数値で比べる。
 */
export function compareImagePath(a, b) {
    const na = LEADING_NUMBER.exec(a.slice(a.lastIndexOf('/')));
    const nb = LEADING_NUMBER.exec(b.slice(b.lastIndexOf('/')));
    if (na && nb && Number(na[2]) !== Number(nb[2])) return Number(na[2]) - Number(nb[2]);
    if (na && !nb) return -1;
    if (!na && nb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * git tree の中身から候補を選ぶ。
 *
 * @param {{path: string, size?: number, type?: string}[]} entries  git tree の blob 一覧
 * @param {object} [options] config/media.json の repoImages
 * @returns {{path: string, size: number}[]} 選ばれたもの（表示順）
 */
export function pickRepoImages(entries, options = {}) {
    const config = { ...DEFAULT_REPO_IMAGES, ...options };
    const picked = (entries ?? [])
        .filter((entry) => entry && (entry.type ?? 'blob') === 'blob')
        .filter((entry) => isImagePath(entry.path, config.extensions))
        .filter((entry) => !isIconLike(entry.path))
        .filter((entry) => {
            const size = Number(entry.size ?? 0);
            // 大きさが分からないものは落とさない。判定できないことを理由に捨てると、
            // tree が size を返さなかったときに全部消える。
            if (!Number.isFinite(size) || size === 0) return true;
            return size >= config.minBytes && size <= config.maxBytes;
        })
        .map((entry) => ({ path: entry.path, size: Number(entry.size ?? 0) }));

    picked.sort((a, b) => compareImagePath(a.path, b.path));
    return picked.slice(0, Math.max(0, config.maxPerRepo));
}

/**
 * 画像の説明文が書いてありそうな Markdown を、tree の中から選ぶ。
 *
 * 画像と同じ場所か、その1つ上に置いてあるものだけを見る。
 * リポジトリ中の .md を全部取りにいくと、SchoolPlan_Editor のように
 * docs/ に20本以上ある repo で API のリクエストが跳ね上がる。
 */
export function captionSourcePaths(entries, imagePaths, limit = 3) {
    const dirs = new Set();
    for (const path of imagePaths) {
        const dir = dirOf(path);
        dirs.add(dir);
        dirs.add(dirOf(dir));
    }

    return (entries ?? [])
        .filter((entry) => entry && (entry.type ?? 'blob') === 'blob' && /\.md$/i.test(entry.path))
        .map((entry) => entry.path)
        .filter((path) => dirs.has(dirOf(path)))
        .sort(compareImagePath)
        .slice(0, limit);
}

/** '01-home.png' のような名前を、そのまま見出しにできる形に直す。 */
export function labelFromPath(filePath) {
    const name = String(filePath).slice(String(filePath).lastIndexOf('/') + 1);
    return name
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/^\d{1,3}[-_]/, '')
        .replace(/[-_]+/g, ' ')
        .trim();
}

/** 説明文として意味を成さないもの（README の書き方の例など）を弾く。 */
function usableCaption(text) {
    const caption = String(text ?? '').trim();
    if (caption.length === 0 || caption.length > 40) return false;
    // 「![...](images/xx-....png)」のような、書き方を示すためだけの行がある。
    if (/^[.．…]+$/.test(caption)) return false;
    return true;
}

/**
 * Markdown から「この画像は何の画面か」を拾う。
 *
 * 2つの書き方に対応する。GIGAyama のリポジトリで実際に使われている形である。
 *   1. 本文中の  ![音読の画面](images/02-read-aloud.png)
 *   2. README の表  | 01-week-plan.png | 週案グリッド全体 | ... |
 *
 * 表のほうを先に採らないのは、本文の alt のほうが投稿に添える文脈に近いためである。
 *
 * @param {{path: string, text: string}[]} documents  読んだ Markdown（path はリポジトリ内のパス）
 * @param {string[]} imagePaths  説明を付けたい画像のパス
 * @returns {Map<string, string>} 画像パス → 説明文
 */
export function parseCaptions(documents, imagePaths) {
    const captions = new Map();
    const byBasename = new Map();
    for (const path of imagePaths) {
        const base = path.slice(path.lastIndexOf('/') + 1);
        // 同じ名前の画像が別の場所にもあるときは、どちらの説明か決められない。付けない。
        byBasename.set(base, byBasename.has(base) ? null : path);
    }
    const known = new Set(imagePaths);

    for (const doc of documents ?? []) {
        const dir = dirOf(doc.path);
        const text = String(doc.text ?? '');

        // ① 本文中の ![alt](path)
        for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) {
            const [, alt, target] = match;
            if (/^https?:/i.test(target)) continue;
            const resolved = resolvePath(dir, target);
            if (!known.has(resolved) || captions.has(resolved)) continue;
            if (usableCaption(alt)) captions.set(resolved, alt.trim());
        }

        // ② | ファイル名 | 何の画面か | …
        for (const line of text.split('\n')) {
            if (!line.trimStart().startsWith('|')) continue;
            const cells = line.split('|').map((cell) => cell.trim());
            const fileCell = cells.find((cell) => /\.(png|jpe?g|webp|gif)$/i.test(cell));
            if (!fileCell) continue;
            const at = cells.indexOf(fileCell);
            const caption = cells[at + 1];
            const target = byBasename.get(fileCell) ?? resolvePath(dir, fileCell);
            if (!target || !known.has(target) || captions.has(target)) continue;
            if (usableCaption(caption)) captions.set(target, caption);
        }
    }

    return captions;
}

/** 'docs/note' と 'images/01-home.png' から 'docs/note/images/01-home.png' を作る。 */
function resolvePath(dir, relative) {
    const parts = [...(dir ? dir.split('/') : []), ...String(relative).replace(/^\.\//, '').split('/')];
    const stack = [];
    for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
    }
    return stack.join('/');
}

/**
 * raw.githubusercontent.com の URL を組む。
 *
 * コミット SHA で固定する。ブランチ名で組むと、アプリ側で画像を差しかえたときに
 * 「ランチャーに出ている絵」と「共有される絵」が食い違う。
 * SHA なら中身が変わらないので、端末のキャッシュもそのまま効く。
 */
export function rawUrl(owner, repo, sha, filePath) {
    const segments = String(filePath)
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${segments}`;
}
