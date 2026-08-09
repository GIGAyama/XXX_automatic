/**
 * 「このアプリの宣伝ポストを作ってほしい」という注文の形。
 *
 * ⚠️ このファイルはブラウザ（docs/app.js）と Node（scripts/generate-promo.mjs）の
 *    両方から import される。書く側と読む側でスキーマが二重定義されると、
 *    片方だけ直したときに黙って取りこぼす。定義はここ1つにする。
 *    そのため DOM にも node: モジュールにも依存してはいけない。
 *    docs/lib/feedback-payload.js とまったく同じ約束である。
 *
 * ── なぜ Issue を経由するのか ──────────────────────
 *
 * 週次の生成は日曜の夜にしか動かない。ところが「このアプリの話を、いま出したい」は
 * 予定とは無関係にやってくる（誰かに聞かれた、その教科の研究授業が近い、など）。
 * その場で文章を作るにはブラウザから Gemini を呼ぶことになり、
 * それには API キーを画面に置くしかない。公開されるファイルに秘密情報は置けない（CLAUDE.md §2）。
 *
 * 反応の記録（feedback-payload.js）と返信の下書き（draft-reply.mjs）が
 * すでに同じ問題を Issue で解いている。ここも同じ道を通す。
 *   ランチャーが本文を載せた Issue 作成画面を開く
 *     → 本人が送信ボタンを押す
 *     → ワークフローが読んで作り、docs/orders/<注文ID>.json に置く
 *     → ランチャーがそれを拾って端末に貯める
 * 画面に書き込み権限のトークンを持たせずに往復が閉じる。費用も 0 円のまま。
 *
 * ── 結果を Pages に置く理由 ──────────────────────
 *
 * 返信の下書きは Issue のコメントに返して終わりでよかった（読んで自分の言葉に直すため）。
 * 宣伝ポストは違う。共有シートに渡して投稿するものなので、ランチャーに戻ってこないと意味がない。
 * api.github.com を画面から読む形にすると、外を読む先が1つ増えるうえに
 * 未認証だと 1時間60回で頭打ちになる。同一オリジンのファイルに置くのがいちばん静かである。
 */

/** Issue 本文に埋める機械向けブロックの目印。 */
export const SCHEMA_ID = 'promo-order-v1';
/** 結果ファイル（docs/orders/<注文ID>.json）の目印。 */
export const RESULT_SCHEMA_ID = 'promo-result-v1';

/** 注文の Issue に付けるラベル。ワークフローはこれが付いているものだけを見る。 */
export const ISSUE_LABEL = '宣伝ポスト';
/** 作り終えた Issue に足すラベル。二度作らないための印。 */
export const DONE_LABEL = '宣伝ポストずみ';

/** 1回の注文で作る本数。 */
export const MIN_COUNT = 2;
export const MAX_COUNT = 6;
export const DEFAULT_COUNT = 3;

/** 「こういう切り口で」の一言の長さ。長文の指示は投稿の型のほうを直す話になる。 */
export const MAX_NOTE_CHARS = 200;

/** 1回の注文で指定できる型の数。全部指定すると「おまかせ」と変わらない。 */
export const MAX_THEMES = 3;

/**
 * 注文ID。
 *
 * ⚠️ これがそのままファイル名（docs/orders/<注文ID>.json）になる。
 *    Issue は誰でも立てられる以上、外から来た文字列でパスを組むことになるので、
 *    形を厳しく決めて、受け取る側（generate-promo.mjs）で必ず照合する。
 *    ここを緩めると ../ を含む名前でリポジトリの任意の場所に書けてしまう。
 */
export const ORDER_ID_RE = /^ord-[0-9a-z]{8,24}$/;

/** 結果ファイルを置くディレクトリ（docs/ からの相対）。 */
export const ORDERS_DIR = 'orders';

/** 注文IDから結果ファイルの場所を決める。書く側と読む側で必ず同じ式を使う。 */
export function resultPathOf(orderId) {
  if (!ORDER_ID_RE.test(String(orderId ?? ''))) throw new Error(`注文IDの形が違います: ${orderId}`);
  return `${ORDERS_DIR}/${orderId}.json`;
}

/** 注文をひとつ発行する。 */
export function newOrderId(random = Math.random, now = Date.now()) {
  // 時刻を混ぜるのは、同じ端末で続けて頼んだときに並び順が分かるようにするため。
  // 乱数だけにすると、あとから notes を突き合わせるときに手がかりが無くなる。
  const stamp = Number(now).toString(36).slice(-7);
  const salt = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `ord-${stamp}${salt}`.toLowerCase();
}

/**
 * 注文ひとつぶんの形。
 *
 * themes を空にすると「おまかせ」。指定すると、その型のなかで書き分けさせる。
 */
export function buildOrder({ orderId, repo, count = DEFAULT_COUNT, themes = [], note = '', askedAtJst = '' }) {
  return {
    schema: SCHEMA_ID,
    orderId,
    repo,
    count: clampCount(count),
    themes: [...new Set((themes ?? []).filter(Boolean))].slice(0, MAX_THEMES),
    note: String(note ?? '').trim().slice(0, MAX_NOTE_CHARS),
    askedAtJst,
  };
}

export function clampCount(count) {
  const n = Math.round(Number(count));
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));
}

export function renderOrderTitle(order) {
  return `[宣伝ポスト] ${order.repo} の投稿を ${order.count} 本`;
}

/**
 * Issue の本文。人が読める要約と、機械が読むブロックの二層にする。
 *
 * 要約を先に置くのは、送信ボタンを押す前に「何を頼もうとしているか」が
 * 本人に見えるようにするためである。中身が見えないものを送らせるべきではない。
 */
export function renderOrderBody(order, { themeLabels = {} } = {}) {
  const lines = [
    `**${order.repo}** の宣伝ポストを **${order.count} 本** お願いします。`,
    '',
    `- 型: ${order.themes.length === 0 ? 'おまかせ' : order.themes.map((id) => themeLabels[id] ?? id).join(' / ')}`,
  ];
  if (order.note) lines.push(`- 切り口: ${order.note}`);
  lines.push(
    '',
    '緑の［Create］を押すと作りはじめます。1〜2分でランチャーの［つくる］に届きます。',
    '',
    '<sub>下のブロックは機械が読みます。編集しないでください。</sub>',
    '',
    '```json ' + SCHEMA_ID,
    JSON.stringify(order),
    '```'
  );
  return lines.join('\n');
}

/** Issue 作成画面の URL。window.open でそのまま開く。 */
export function buildOrderIssueUrl(repoUrl, order, { themeLabels } = {}) {
  const base = String(repoUrl).replace(/\/+$/, '');
  const params = new URLSearchParams({
    title: renderOrderTitle(order),
    body: renderOrderBody(order, { themeLabels }),
    labels: ISSUE_LABEL,
  });
  return `${base}/issues/new?${params.toString()}`;
}

/** Issue 本文から機械向けブロックを取り出す。見つからなければ null。 */
export function extractOrder(body) {
  const fence = new RegExp('```json\\s+' + SCHEMA_ID + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = fence.exec(String(body ?? ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * 中身を厳しく見る。
 *
 * 公開リポジトリなので Issue は誰でも立てられる。投稿者の照合（isAllowedAuthor）とは別に、
 * 形そのものも確かめる。1つでもおかしければ注文ごと拒否する。
 * 一部だけ採って残りを黙って捨てるのがいちばん悪い（CLAUDE.md §6）。
 *
 * @param {object} order
 * @param {object} opts
 * @param {Set<string>|string[]} opts.repoNames data/profiles/ にあるアプリ
 * @param {Set<string>|string[]} opts.themeIds  config/themes.json にある型
 */
export function validateOrder(order, { repoNames, themeIds } = {}) {
  const errors = [];
  const repos = repoNames instanceof Set ? repoNames : new Set(repoNames ?? []);
  const themes = themeIds instanceof Set ? themeIds : new Set(themeIds ?? []);

  if (!order || typeof order !== 'object') return { ok: false, errors: ['本文に機械向けのブロックがありません'] };
  if (order.schema !== SCHEMA_ID) errors.push(`schema が ${SCHEMA_ID} ではありません: ${order.schema}`);

  // ⚠️ ここが最後の関所。注文IDはそのままファイル名になる。
  if (!ORDER_ID_RE.test(String(order.orderId ?? ''))) errors.push(`orderId の形が違います: ${order.orderId}`);

  if (typeof order.repo !== 'string' || order.repo === '') errors.push('repo がありません');
  else if (repos.size > 0 && !repos.has(order.repo)) errors.push(`repo が data/profiles/ にありません: ${order.repo}`);

  const count = Number(order.count);
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    errors.push(`count は ${MIN_COUNT}〜${MAX_COUNT} の整数です: ${order.count}`);
  }

  if (!Array.isArray(order.themes)) {
    errors.push('themes が配列ではありません');
  } else {
    if (order.themes.length > MAX_THEMES) errors.push(`themes が多すぎます（${order.themes.length} > ${MAX_THEMES}）`);
    for (const id of order.themes) {
      if (themes.size > 0 && !themes.has(id)) errors.push(`themes に config/themes.json に無い型があります: ${id}`);
    }
  }

  if (order.note != null) {
    if (typeof order.note !== 'string') errors.push('note が文字列ではありません');
    else if (order.note.length > MAX_NOTE_CHARS) errors.push(`note が長すぎます（${order.note.length} > ${MAX_NOTE_CHARS}）`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 結果ファイルの中身を確かめる。
 *
 * ランチャーは同一オリジンのファイルしか読まないので、ここは「壊れた JSON を
 * そのまま端末に貯めない」ための検査である。Pages の 404 ページが JSON として
 * 読めてしまう、といった取り違えもここで止まる。
 */
export function validateResult(result, { orderId } = {}) {
  if (!result || typeof result !== 'object') return { ok: false, errors: ['JSON として読めません'] };
  const errors = [];
  if (result.schema !== RESULT_SCHEMA_ID) errors.push(`schema が ${RESULT_SCHEMA_ID} ではありません: ${result.schema}`);
  if (orderId && result.orderId !== orderId) errors.push(`別の注文の結果です: ${result.orderId}`);
  if (!Array.isArray(result.posts)) errors.push('posts が配列ではありません');
  else {
    for (const [i, post] of result.posts.entries()) {
      if (!post || typeof post !== 'object') errors.push(`posts[${i}] がオブジェクトではありません`);
      else if (typeof post.id !== 'string' || !post.id) errors.push(`posts[${i}].id がありません`);
      else if (!Array.isArray(post.steps) || post.steps.length === 0) errors.push(`posts[${i}].steps がありません`);
    }
  }
  return { ok: errors.length === 0, errors };
}
