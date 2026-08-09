/**
 * 投稿に添える画像を選ぶところ。
 *
 * 候補は2種類ある。
 *   card … このリポジトリで作った紹介カード（docs/media/ にある）
 *   repo … アプリのリポジトリに置いてある画像。note の記事のために
 *          実際にアプリを操作して撮ったものが入っている。
 *
 * repo のほうは raw.githubusercontent.com を直接読む。他所のドメインを読む唯一の場所なので、
 * 行き先はここで絞る（launcher.json は生成物だが、外から来た文字列を素通しにしない）。
 *
 * DOM も localStorage も触らない純粋関数だけを置く（tests/docs-media-pick.test.mjs 用）。
 */

/** X は1投稿に画像4枚まで。5枚目以降は渡しても載らない。 */
export const MAX_MEDIA = 4;

/** 画像を読みにいってよい先。 */
const ALLOWED_HOSTS = ['raw.githubusercontent.com'];

/**
 * その URL を読みにいってよいか。
 * 相対パス（このサイトの中）か、許可したドメインの https だけを通す。
 */
export function isAllowedMediaSrc(src) {
    const value = String(src ?? '');
    if (value === '') return false;
    // '//example.com/x.png' はプロトコル相対で外部を指す。相対パスに見えるので先に落とす。
    if (value.startsWith('//')) return false;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;

    try {
        const url = new URL(value);
        return url.protocol === 'https:' && ALLOWED_HOSTS.includes(url.hostname);
    } catch {
        return false;
    }
}

/**
 * その投稿で選べる画像の一覧。
 *
 * galleries（アプリごとの一覧）が無い古い launcher.json でも動くように、
 * そのときは mediaList を紹介カードの一覧として組みなおす。
 * Service Worker が古い app.js を配っている最中に新しい launcher.json を読む、
 * という組み合わせが普通に起きるためである。
 */
export function galleryOf(post, galleries = {}) {
    // ⚠️ 投稿自身が持っている一覧を最優先する。
    //    ［つくる］で注文して作った投稿は、launcher.json の galleries には載っていない
    //    （あそこにはその週に出てくるアプリぶんしか入れていない。52件ぜんぶ載せると、
    //      スマホが最初に読むファイルが理由もなく重くなるため）。
    //    代わりに結果ファイルと一緒に受け取った一覧を、投稿にくっつけて持ち歩いている。
    const own = post?.gallery;
    const fromGalleries = Array.isArray(own) && own.length > 0 ? own : (galleries ?? {})[post?.repo];
    const items = Array.isArray(fromGalleries) && fromGalleries.length > 0
        ? fromGalleries
        : (post?.mediaList ?? (post?.media ? [post.media] : [])).map((src, i) => ({
              id: `card:${i}`,
              src,
              kind: 'card',
              label: i === 0 ? '紹介カード' : `紹介カード ${i + 1}`,
          }));

    return items
        .filter((item) => item && typeof item.src === 'string' && typeof item.id === 'string')
        .filter((item) => isAllowedMediaSrc(item.src))
        .map((item) => ({
            id: item.id,
            src: item.src,
            kind: item.kind === 'repo' ? 'repo' : 'card',
            label: String(item.label ?? '画像'),
        }));
}

/**
 * 何も選んでいないときに選ばれている状態。
 *
 * 紹介カード1枚だけにする。今までと同じ見た目・同じ結果になるので、
 * 画像を選ばない人にとっては何も変わらない。
 */
export function defaultSelection(gallery) {
    const card = gallery.find((item) => item.kind === 'card') ?? gallery[0];
    return card ? [card.id] : [];
}

/**
 * 端末に残っている選択を、いまの候補に合わせて整える。
 *
 * 無くなった画像（アプリ側で消された、名前が変わった）を黙って残すと、
 * 共有のときに1枚足りないまま出てしまう。ここで落とす。
 */
export function normalizeSelection(saved, gallery) {
    if (!Array.isArray(saved)) return defaultSelection(gallery);

    const ids = new Set(gallery.map((item) => item.id));
    const seen = new Set();
    const kept = [];
    for (const id of saved) {
        if (!ids.has(id) || seen.has(id)) continue;
        seen.add(id);
        kept.push(id);
        if (kept.length >= MAX_MEDIA) break;
    }
    // 「全部はずした」は意思表示なので、既定に戻さずそのまま空で返す。
    // 本文だけで出したいときに、押すたび勝手に戻ると外せなくなる。
    return kept;
}

/**
 * 1枚ぶんの選択を切り替える。
 *
 * @returns {{selected: string[], reason: null|'max'|'unknown'}}
 *   reason は切り替えられなかった理由。画面で伝えるために返す（黙って無視しない）。
 */
export function toggleSelection(selected, id, gallery) {
    const current = normalizeSelection(selected, gallery);
    if (!gallery.some((item) => item.id === id)) return { selected: current, reason: 'unknown' };

    if (current.includes(id)) return { selected: current.filter((x) => x !== id), reason: null };
    if (current.length >= MAX_MEDIA) return { selected: current, reason: 'max' };
    return { selected: [...current, id], reason: null };
}

/** 選んだ順に並べた画像。共有シートにはこの順で渡る。 */
export function selectedItems(gallery, selected) {
    const byId = new Map(gallery.map((item) => [item.id, item]));
    return normalizeSelection(selected, gallery)
        .map((id) => byId.get(id))
        .filter(Boolean);
}

/** 共有シートに渡すときのファイル名。X では表に出ないが、保存したときに手がかりになる。 */
export function fileNameFor(repo, item, index) {
    const fromPath = item.src.split('?')[0].split('/').pop() ?? '';
    const ext = /\.([a-z0-9]+)$/i.exec(fromPath)?.[1]?.toLowerCase() ?? 'png';
    if (item.kind === 'card') return `${repo}-card-${index + 1}.${ext}`;
    return `${repo}-${fromPath || `${index + 1}.${ext}`}`;
}
