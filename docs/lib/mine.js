/**
 * 自分で作らせた投稿を、この端末に貯めておくところ。
 *
 * 週の投稿（launcher.json）は毎週入れかわるが、こちらは注文して作らせたものなので、
 * 出すまでのあいだ誰も預かってくれない。docs/orders/<注文ID>.json は
 * 溜まりすぎないよう古いものから消える（scripts/generate-promo.mjs）ので、
 * 「あとで出そう」と思って1か月置いておいたら消えていた、では困る。
 * 一度受け取ったら端末側に写して、以降はネットワークを見ない。
 *
 * ⚠️ 端末のなかにしか無い。ブラウザのデータを消せば一緒に消えるし、機種変更でも消える。
 *    それを取り返す方法が無いのは怖いので、書き出し／読みこみ（toBackupText / fromBackupText）を
 *    用意してある。画面には［書き出す］として出る。
 *
 * DOM にも localStorage にも触らない純粋関数だけを置く（tests/docs-mine.test.mjs 用）。
 * 状態の置き場そのものは docs/lib/state.js と同じ考え方で、読み書きは app.js が受け持つ。
 */

export const MINE_KEY = 'launcher:mine:v1';

/**
 * 貯めておく上限。
 *
 * 1件あたり本文・連投・落選案・添付候補で 3〜6KB。localStorage は 5MB 程度なので、
 * 120 件でも 1MB に届かない。上限を置くのは容量というより、
 * 「一覧が長くなりすぎて出すものを探せなくなる」ほうを避けるためである。
 */
export const MAX_POSTS = 120;
/** 注文の記録。届いたかどうかを確かめるために持つので、投稿ほど数は要らない。 */
export const MAX_ORDERS = 30;

/** 注文の状態。 */
export const WAITING = 'waiting';
export const DONE = 'done';
export const FAILED = 'failed';

/** 空の保管庫。 */
export function emptyMine() {
  return { version: 1, orders: [], posts: [] };
}

/**
 * 読みこんだ中身を、いまの形に整える。
 *
 * 壊れていても画面が出ないより、読める部分だけ拾って動くほうがよい。
 * ただし「読めなかった」を黙って捨てない（呼び出し側が件数の差で気づける）。
 */
export function normalizeMine(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const orders = (Array.isArray(base.orders) ? base.orders : [])
    .filter((o) => o && typeof o === 'object' && typeof o.id === 'string')
    .slice(0, MAX_ORDERS);
  const seen = new Set();
  const posts = [];
  for (const post of Array.isArray(base.posts) ? base.posts : []) {
    if (!post || typeof post !== 'object') continue;
    if (typeof post.id !== 'string' || post.id === '') continue;
    if (!Array.isArray(post.steps) || post.steps.length === 0) continue;
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    posts.push(post);
    if (posts.length >= MAX_POSTS) break;
  }
  return { version: 1, orders, posts };
}

/** 注文を控える。同じ注文IDは1つだけ。 */
export function addOrder(store, order) {
  const base = normalizeMine(store);
  const orders = [order, ...base.orders.filter((o) => o.id !== order.id)].slice(0, MAX_ORDERS);
  return { ...base, orders };
}

/** 注文の状態を書きかえる。無ければ何もしない（消したあとに結果が届いても壊れない）。 */
export function patchOrder(store, orderId, patch) {
  const base = normalizeMine(store);
  return { ...base, orders: base.orders.map((o) => (o.id === orderId ? { ...o, ...patch } : o)) };
}

/** 注文の控えを消す。届いた投稿そのものは残す。 */
export function dropOrder(store, orderId) {
  const base = normalizeMine(store);
  return { ...base, orders: base.orders.filter((o) => o.id !== orderId) };
}

/** まだ結果が届いていない注文。 */
export function waitingOrders(store) {
  return normalizeMine(store).orders.filter((o) => o.state === WAITING);
}

/**
 * 届いた投稿を貯める。
 *
 * @param {object} store
 * @param {object[]} posts   launcher.json の投稿と同じ形
 * @param {object} [meta]    { orderId, gallery, gotAtJst } — 投稿ごとに写して持たせる
 * @returns {{store: object, added: number}}
 *
 * gallery を投稿ごとに持たせるのは、launcher.json の galleries には
 * その週に出てくるアプリぶんしか入っていないためである。
 * 注文はどのアプリにも出せるので、添付候補は結果と一緒に受け取って、そのまま抱えておく。
 */
export function addPosts(store, posts, { orderId = '', gallery = null, gotAtJst = '' } = {}) {
  const base = normalizeMine(store);
  const known = new Set(base.posts.map((p) => p.id));
  const fresh = [];

  for (const post of posts ?? []) {
    if (!post || typeof post !== 'object' || typeof post.id !== 'string' || post.id === '') continue;
    if (!Array.isArray(post.steps) || post.steps.length === 0) continue;
    if (known.has(post.id)) continue;
    known.add(post.id);
    fresh.push({
      ...post,
      // ここで付ける印。画面が「これは注文して作らせたもの」と分かるようにするため。
      source: 'order',
      // 書き出したものを読みこむときは meta が空で来る。
      // そのとき元の注文IDや受け取り時刻を '' で上書きすると、どこから来た投稿か分からなくなる。
      orderId: orderId || post.orderId || '',
      gotAtJst: gotAtJst || post.gotAtJst || '',
      ...(gallery ? { gallery } : {}),
    });
  }

  // 新しいものを上に。上限を超えたぶんは古いほうから落ちる。
  return { store: { ...base, posts: [...fresh, ...base.posts].slice(0, MAX_POSTS) }, added: fresh.length };
}

/** 1件だけ消す。 */
export function dropPost(store, id) {
  const base = normalizeMine(store);
  return { ...base, posts: base.posts.filter((p) => p.id !== id) };
}

/**
 * 並べる順に取り出す。
 *
 * 未投稿を先に出す。出したものが上に居座ると、次に出すものを毎回探すことになる。
 * @param {object} store
 * @param {object} [opts]
 * @param {string} [opts.repo]   このアプリのぶんだけ
 * @param {(id:string)=>boolean} [opts.isDone]  投稿ずみかどうか（判定は app.js が持つ）
 */
export function minePosts(store, { repo = '', isDone = () => false } = {}) {
  const posts = normalizeMine(store).posts.filter((p) => !repo || p.repo === repo);
  return posts
    .map((post, i) => ({ post, i, done: Boolean(isDone(post.id)) }))
    .sort((a, b) => (a.done === b.done ? a.i - b.i : a.done ? 1 : -1))
    .map((x) => x.post);
}

/** 貯まっているアプリの一覧（件数つき）。絞りこみのボタンに使う。 */
export function repoCounts(store) {
  const counts = new Map();
  for (const post of normalizeMine(store).posts) {
    counts.set(post.repo, (counts.get(post.repo) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* ────────────────────────────────────────────
 *  書き出しと読みこみ
 * ──────────────────────────────────────────── */

/**
 * 端末の外に持ち出せる形にする。
 *
 * 機種変更やブラウザのデータ削除で消えるものなので、逃がす道を用意しておく。
 * 圧縮も暗号化もしない。中身は自分が出そうとしている投稿文で、
 * 読めない形にすると「本当に入っているのか」を本人が確かめられなくなる。
 */
export function toBackupText(store) {
  const base = normalizeMine(store);
  return JSON.stringify({ kind: MINE_KEY, version: 1, posts: base.posts }, null, 2);
}

/**
 * 書き出したものを読みこむ。いま持っているものは消さずに足す。
 *
 * 置きかえにしないのは、2台の端末で作ったものを1台にまとめられるようにするため。
 * 同じ投稿IDは重複しない（addPosts が落とす）。
 *
 * @returns {{store: object, added: number, error: string|null}}
 */
export function fromBackupText(store, text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { store: normalizeMine(store), added: 0, error: 'JSON として読めませんでした' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== MINE_KEY) {
    return { store: normalizeMine(store), added: 0, error: 'このランチャーが書き出したものではないようです' };
  }
  if (!Array.isArray(parsed.posts)) {
    return { store: normalizeMine(store), added: 0, error: 'posts が入っていません' };
  }
  // 書き出したものには source / gallery が入っているので、そのまま足せる。
  const { store: next, added } = addPosts(store, parsed.posts);
  return { store: next, added, error: null };
}
