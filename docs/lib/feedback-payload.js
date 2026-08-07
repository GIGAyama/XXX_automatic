/**
 * 「反応よかった／いまいち」を GitHub Issue に載せて往復させるための、形の定義。
 *
 * ⚠️ このファイルはブラウザ（docs/app.js）と Node（scripts/collect-feedback.mjs）の
 *    両方から import される。書く側と読む側でスキーマが二重定義されると、
 *    片方だけ直したときに黙って取りこぼす。定義はここ1つにする。
 *    そのため DOM にも node: モジュールにも依存してはいけない。
 *
 * なぜ Issue 経由なのか:
 *   X API も GitHub の書き込み API も、画面から直接叩くにはトークンが要る。
 *   スマホのブラウザに書き込み権限のトークンを置くのは、この用途に対して重すぎる。
 *   Issue の作成画面は URL に本文を載せて開けるので、
 *   「ランチャーが URL を開く → 本人が送信ボタンを押す」だけで往復が閉じる。
 *   費用も 0 円のまま。
 */

export const SCHEMA_ID = 'feedback-v1';
export const ISSUE_LABEL = 'feedback';
export const MERGED_LABEL = 'feedback-merged';

/**
 * URL 全体（エンコード後）の上限。
 *
 * GitHub は 8KB を超えるあたりの URL に 414 を返す。そこに寄せると危ないので 6000 にしてある。
 *
 * 日本語は percent-encode で1文字9文字ぶんに膨らむ。人が読む要約を本文に入れている以上、
 * ここが効いてくる。実測で1週間ぶん（14件）が約 5,100 文字なので、
 * ふつうの使い方なら1通で収まる。しばらく送っていない場合だけ複数通に分かれる。
 */
export const MAX_URL_CHARS = 6000;
/** 1つの Issue に載せてよい件数の上限。壊れた入力で無限に読まされないための蓋。 */
export const MAX_ENTRIES = 200;

const RATINGS = new Set(['good', 'bad']);
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9_-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;

/** 送信のたびに1つ発行する。同じ Issue を二度数えないための目印。 */
export function newSubmissionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // randomUUID が無い環境（古い WebView）向けの控え。衝突しなければ用は足りる。
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildPayload(entries, { submissionId, sentAtJst }) {
  return {
    schema: SCHEMA_ID,
    submissionId,
    sentAtJst,
    entries: entries.map((e) => ({
      id: e.id,
      weekId: e.weekId ?? '',
      date: e.date,
      repo: e.repo,
      theme: e.theme,
      rating: e.rating,
    })),
  };
}

export function renderIssueTitle(payload, { part = 1, parts = 1 } = {}) {
  const weeks = [...new Set(payload.entries.map((e) => e.weekId).filter(Boolean))].sort();
  const scope = weeks.length === 0 ? '' : weeks.length === 1 ? `${weeks[0]} ` : `${weeks[0]}〜${weeks[weeks.length - 1]} `;
  const suffix = parts > 1 ? `（${part}/${parts}通目）` : '';
  return `[feedback] ${scope}の反応 ${payload.entries.length}件${suffix}`;
}

/**
 * Issue の本文。人が読める要約と、機械が読むブロックの二層にする。
 *
 * 人向けの要約を先に置くのは、送る本人が「何を送ろうとしているか」を
 * 送信ボタンを押す前に確かめられるようにするためである。
 * 中身が見えないものを送らせるべきではない。
 */
export function renderIssueBody(payload, { themeLabels = {}, slotLabels = {} } = {}) {
  const lines = ['反応の記録です。送信ボタンを押すと、次の週次生成に反映されます。', ''];

  for (const e of payload.entries) {
    const slot = slotLabels[slotIdOf(e.id)] ?? slotIdOf(e.id);
    const theme = themeLabels[e.theme] ?? e.theme;
    const rating = e.rating === 'good' ? 'よかった' : 'いまいち';
    lines.push(`- ${shortDate(e.date)} ${slot} ${e.repo}（${theme}）… ${rating}`);
  }

  lines.push(
    '',
    '<sub>下のブロックは機械が読みます。編集しないでください。</sub>',
    '',
    '```json ' + SCHEMA_ID,
    JSON.stringify(payload),
    '```'
  );
  return lines.join('\n');
}

/** Issue 作成画面の URL。window.open でそのまま開く。 */
export function buildIssueUrl(repoUrl, payload, { themeLabels, slotLabels, part, parts } = {}) {
  const base = String(repoUrl).replace(/\/+$/, '');
  const params = new URLSearchParams({
    title: renderIssueTitle(payload, { part, parts }),
    body: renderIssueBody(payload, { themeLabels, slotLabels }),
    labels: ISSUE_LABEL,
  });
  return `${base}/issues/new?${params.toString()}`;
}

/**
 * URL が長くなりすぎないように分割する。
 *
 * 1件あたり素の JSON でおよそ 110 バイト、percent-encode で 2 倍強に膨らむ。
 * 週14件なら1通で収まるが、しばらく送っていないと溜まる。
 * 収まらないぶんを黙って捨てるのがいちばん悪いので、通を分ける。
 */
export function chunkEntries(entries, { repoUrl, maxUrlChars = MAX_URL_CHARS, themeLabels, slotLabels } = {}) {
  if (entries.length === 0) return [];

  const fits = (group) => {
    if (!repoUrl) return group.length <= 20;
    const payload = buildPayload(group, { submissionId: 'x'.repeat(36), sentAtJst: '0000-00-00 00:00 JST' });
    return buildIssueUrl(repoUrl, payload, { themeLabels, slotLabels }).length <= maxUrlChars;
  };

  const chunks = [];
  let current = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    if (current.length > 0 && !fits(candidate)) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Issue 本文から機械向けブロックを取り出す。見つからなければ null。 */
export function extractPayload(body) {
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
 * 公開リポジトリなので Issue は誰でも立てられる。何でも受け入れると、
 * 第三者が翌週の生成の重み付けを動かせてしまう。
 * 1つでもおかしければ Issue ごと拒否する（黙って一部だけ採用しない）。
 *
 * @param {object} payload
 * @param {object} opts
 * @param {Set<string>|string[]} opts.themeIds  config/themes.json にある型
 * @param {Set<string>|string[]} opts.repoNames data/profiles/ にあるアプリ
 */
export function validatePayload(payload, { themeIds, repoNames, maxEntries = MAX_ENTRIES } = {}) {
  const errors = [];
  const themes = themeIds instanceof Set ? themeIds : new Set(themeIds ?? []);
  const repos = repoNames instanceof Set ? repoNames : new Set(repoNames ?? []);

  if (!payload || typeof payload !== 'object') return { ok: false, errors: ['本文に機械向けのブロックがありません'] };
  if (payload.schema !== SCHEMA_ID) errors.push(`schema が ${SCHEMA_ID} ではありません: ${payload.schema}`);
  if (typeof payload.submissionId !== 'string' || payload.submissionId.length < 8) errors.push('submissionId がありません');
  if (!Array.isArray(payload.entries)) return { ok: false, errors: [...errors, 'entries が配列ではありません'] };
  if (payload.entries.length === 0) errors.push('entries が空です');
  if (payload.entries.length > maxEntries) errors.push(`entries が多すぎます（${payload.entries.length} > ${maxEntries}）`);

  const seen = new Set();
  for (const [i, e] of payload.entries.entries()) {
    const at = `entries[${i}]`;
    if (!e || typeof e !== 'object') {
      errors.push(`${at} がオブジェクトではありません`);
      continue;
    }
    if (!ID_RE.test(e.id ?? '')) errors.push(`${at}.id の形が違います: ${e.id}`);
    else if (seen.has(e.id)) errors.push(`${at}.id が重複しています: ${e.id}`);
    else seen.add(e.id);

    if (!DATE_RE.test(e.date ?? '')) errors.push(`${at}.date の形が違います: ${e.date}`);
    if (e.weekId && !WEEK_RE.test(e.weekId)) errors.push(`${at}.weekId の形が違います: ${e.weekId}`);
    if (!RATINGS.has(e.rating)) errors.push(`${at}.rating は good か bad です: ${e.rating}`);
    if (themes.size > 0 && !themes.has(e.theme)) errors.push(`${at}.theme が config/themes.json にありません: ${e.theme}`);
    if (repos.size > 0 && !repos.has(e.repo)) errors.push(`${at}.repo が data/profiles/ にありません: ${e.repo}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 受け取った記録を data/feedback.json にまとめる。
 *
 * ⚠️ 集計値を足しこまない。posts（投稿ID→評価）を真とし、
 *    themes / repos はそこから毎回作り直す。
 *    足しこむ形にすると、同じ Issue を二度読んだだけで数がずれ、
 *    しかもずれたことに誰も気づけない。作り直す形なら何度読んでも同じ値になる。
 */
export function mergeFeedback(current, payloads) {
  const base = current && typeof current === 'object' ? current : {};
  const posts = { ...(base.posts ?? {}) };
  const seenSubmissions = new Set(base.seen?.submissionIds ?? []);
  const seenIssues = new Set(base.seen?.issueNumbers ?? []);

  let applied = 0;
  let skipped = 0;

  for (const { payload, issueNumber } of payloads) {
    if (payload.submissionId && seenSubmissions.has(payload.submissionId)) {
      skipped += 1;
      continue;
    }
    if (issueNumber != null && seenIssues.has(issueNumber)) {
      skipped += 1;
      continue;
    }
    for (const e of payload.entries) {
      // 同じ投稿を押し直した場合は、あとから来たものが勝つ。
      posts[e.id] = {
        repo: e.repo,
        theme: e.theme,
        date: e.date,
        weekId: e.weekId ?? '',
        rating: e.rating,
        atJst: payload.sentAtJst ?? '',
      };
    }
    if (payload.submissionId) seenSubmissions.add(payload.submissionId);
    if (issueNumber != null) seenIssues.add(issueNumber);
    applied += 1;
  }

  return {
    merged: {
      version: 1,
      posts,
      themes: tally(posts, (p) => p.theme),
      repos: tally(posts, (p) => p.repo),
      seen: {
        // 際限なく伸ばさない。古い submissionId を覚えていても、
        // その Issue はとうに閉じていて二度と読まない。
        submissionIds: [...seenSubmissions].slice(-200),
        issueNumbers: [...seenIssues].slice(-200),
      },
    },
    applied,
    skipped,
  };
}

function tally(posts, keyOf) {
  const out = {};
  for (const post of Object.values(posts)) {
    const key = keyOf(post);
    if (!key) continue;
    out[key] ??= { good: 0, bad: 0 };
    if (post.rating === 'good') out[key].good += 1;
    else if (post.rating === 'bad') out[key].bad += 1;
  }
  return out;
}

function slotIdOf(id) {
  const m = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(String(id));
  return m ? m[1] : '';
}

function shortDate(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(date));
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(date);
}
