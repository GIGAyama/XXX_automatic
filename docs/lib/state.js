/**
 * 端末に残す記録（localStorage）の形と、その手入れ。
 *
 * 記録するもの:
 *   { done, rating, sent, sentAtJst, edited, repo, theme, date, weekId, atJst }
 *
 * repo / theme / date / weekId を控えているのは、launcher.json から
 * 古い週が落ちたあとでも「反応の記録」を送れるようにするためである。
 * 評価を押したのに送る前に週が入れかわって送れなくなる、という取りこぼしを防ぐ。
 *
 * DOM にも localStorage にも触らない純粋関数だけを置く（tests/docs-state.test.mjs 用）。
 */

import { daysBetween, jstStamp } from './jst-client.js';

export const STORAGE_KEY = 'launcher:state:v1';

/** 1件ぶんの記録を更新した新しい state を返す。 */
export function applyPatch(state, id, patch, now = new Date()) {
  const next = { ...state };
  next[id] = { ...(next[id] ?? {}), ...patch, atJst: jstStamp(now) };
  // null を入れた項目は「消した」とみなして落とす。押し直しで rating を外せるようにするため。
  for (const [key, value] of Object.entries(next[id])) {
    if (value === null) delete next[id][key];
  }
  return next;
}

/**
 * 古い記録を捨てる。
 *
 * 捨てないと localStorage が無限に伸びる（1年で数百件）。
 * ただし次の2つは絶対に捨てない。
 *   - いま launcher.json に載っている投稿（画面に出ているものの状態が消えると混乱する）
 *   - まだ送っていない評価（送る前に消すと、記録した意味がなくなる）
 *
 * @param {object} state
 * @param {object} opts
 * @param {Set<string>|string[]} opts.keepIds  launcher.json に載っている ID
 * @param {string} opts.today                  JST の 'YYYY-MM-DD'
 * @param {number} [opts.maxAgeDays]
 */
export function pruneState(state, { keepIds, today, maxAgeDays = 60 }) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds ?? []);
  const next = {};
  let removed = 0;

  for (const [id, saved] of Object.entries(state)) {
    if (!saved || typeof saved !== 'object') {
      removed += 1;
      continue;
    }
    if (keep.has(id)) {
      next[id] = saved;
      continue;
    }
    if (saved.rating && !saved.sent) {
      next[id] = saved;
      continue;
    }
    const age = ageInDays(saved, id, today);
    if (age === null || age <= maxAgeDays) {
      next[id] = saved;
      continue;
    }
    removed += 1;
  }

  return { state: next, removed };
}

/**
 * その記録が何日前のものかを返す。分からなければ null（＝捨てない）。
 * 日付の手がかりは3つある。信用できる順に見る。
 */
function ageInDays(saved, id, today) {
  const candidates = [saved.date, idToDate(id), saved.atJst?.slice(0, 10)];
  for (const value of candidates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) continue;
    try {
      return daysBetween(value, today);
    } catch {
      // 形が合わないものは手がかりにしない
    }
  }
  return null;
}

/** '2026-08-10-morning' → '2026-08-10'。note-2026-W33 のような ID には効かない。 */
function idToDate(id) {
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(String(id));
  return m ? m[1] : null;
}

/** 保存しておくべき項目だけを投稿から抜き出す。評価を送るときの材料になる。 */
export function traceOf(post) {
  return { repo: post.repo, theme: post.theme, date: post.date, weekId: post.weekId };
}
