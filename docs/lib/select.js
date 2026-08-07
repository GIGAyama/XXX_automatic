/**
 * 「どのタブに何を出すか」と「上のひとことに何を書くか」を決める。
 *
 * ここを1ファイルに切り出した理由:
 *   もとは一覧が `date <= today`、上のサマリが `date === today` を見ていて、
 *   前日の出し忘れが1件あると「一覧に2件並んでいるのに『今日はあと1件』」という
 *   食い違いが出ていた。数の定義が2か所にあると必ずずれる。定義をここ1つにする。
 *
 * DOM に触らない純粋関数だけを置く。tests/docs-select.test.mjs が
 * ブラウザを立てずにそのまま import して検証できるようにするためである。
 */

import { addDays, daysBetween, formatMd, weekdayLabelOf } from './jst-client.js';

/** 「今週ぶん」として扱う週。ここに無い週は過去（アーカイブ）扱いにする。 */
export function activeWeekIds(data) {
  return new Set(data.weekIds ?? []);
}

function isDone(state, id) {
  return Boolean(state[id]?.done);
}

/**
 * タブに出す投稿を選ぶ。
 *
 * @param {object} input
 * @param {object[]} input.posts    launcher.json の posts
 * @param {object} input.state      localStorage の中身
 * @param {string} input.view       'today' | 'week' | 'done' | 'past'
 * @param {string} input.today      JST の 'YYYY-MM-DD'
 * @param {Set<string>} [input.activeWeeks] 今週ぶんとして扱う weekId
 */
export function selectPosts({ posts, state, view, today, activeWeeks = null }) {
  const active = (p) => !activeWeeks || activeWeeks.size === 0 || activeWeeks.has(p.weekId);

  if (view === 'done') {
    // 投稿ずみは過去週のものも残す。「先週なにを出したか」を見返せないと、
    // 反応の記録が翌週の生成に届く前に消えてしまう。
    return posts.filter((p) => isDone(state, p.id)).sort(byDateDesc);
  }
  if (view === 'past') {
    // 過去週はぜんぶ出す（投稿ずみかどうかを問わない）。出し忘れの拾い直しにも使う。
    return posts.filter((p) => !active(p)).sort(byDateDesc);
  }

  const undone = posts.filter((p) => active(p) && !isDone(state, p.id));
  if (view === 'today') return undone.filter((p) => p.date <= today).sort(byDateAsc);
  return undone.sort(byDateAsc);
}

/** 「今日タブに出るはずの母数」（投稿ずみを含む）。サマリと空メッセージがこれを共有する。 */
export function todaysPool({ posts, today, activeWeeks = null }) {
  const active = (p) => !activeWeeks || activeWeeks.size === 0 || activeWeeks.has(p.weekId);
  return posts.filter((p) => active(p) && p.date <= today);
}

/** ヘッダーのひとこと。一覧と同じ定義から数える。 */
export function summaryOf({ posts, state, today, activeWeeks = null }) {
  if (posts.length === 0) return '下書きがまだありません';

  const pool = todaysPool({ posts, today, activeWeeks });
  const left = pool.filter((p) => !isDone(state, p.id)).length;
  const total = posts.filter((p) => !activeWeeks || activeWeeks.size === 0 || activeWeeks.has(p.weekId)).length;

  if (pool.length === 0) {
    const next = nextScheduled({ posts, today, activeWeeks });
    return next ? `次は ${formatMd(next.date)}（${weekdayLabelOf(next.date)}）${next.slotLabel}（用意ぜんぶで ${total} 件）` : `用意ぜんぶで ${total} 件`;
  }
  if (left === 0) return `今日のぶんは終わりました（用意ぜんぶで ${total} 件）`;
  return `今日はあと ${left} 件（用意ぜんぶで ${total} 件）`;
}

/** まだ来ていない最初の投稿枠。「次はいつか」を出すのに使う。 */
export function nextScheduled({ posts, today, activeWeeks = null }) {
  const active = (p) => !activeWeeks || activeWeeks.size === 0 || activeWeeks.has(p.weekId);
  return posts.filter((p) => active(p) && p.date > today).sort(byDateAsc)[0] ?? null;
}

/**
 * 一覧が空のときに出す文。
 *
 * 「今日出すぶんは終わりました」を無条件に出すと、まだ一度も投稿していない人にも
 * それが出る（日曜の生成直後がまさにこれで、翌週ぶんしか無い状態になる）。
 * ねぎらうべき場面と、単に予定が無い場面を分ける。
 */
export function emptyMessageFor({ view, posts, state, today, activeWeeks = null }) {
  if (posts.length === 0) {
    return '投稿の下書きがまだありません。\n日曜の夜に翌週ぶんが自動で用意されます。';
  }
  if (view === 'done') return 'まだ投稿ずみのものはありません。';
  if (view === 'past') return '過去週のぶんはまだありません。';

  if (view === 'today') {
    const pool = todaysPool({ posts, today, activeWeeks });
    if (pool.length === 0) {
      const next = nextScheduled({ posts, today, activeWeeks });
      if (!next) return '出す予定がありません。\n日曜の夜に翌週ぶんが自動で用意されます。';
      const days = daysBetween(today, next.date);
      const when = days === 1 ? 'あす' : `${formatMd(next.date)}（${weekdayLabelOf(next.date)}）`;
      return `今日ぶんの下書きはありません。\n次は${when}の${next.slotLabel}です。`;
    }
    return '今日出すぶんは終わりました。おつかれさまでした。';
  }

  return '今週ぶんはぜんぶ出し終わりました。おつかれさまでした。';
}

/** 未送信の評価（反応の記録）を集める。まとめて Issue にするために使う。 */
export function unsentRatings({ posts, state }) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const out = [];
  for (const [id, saved] of Object.entries(state)) {
    if (!saved || !saved.rating || saved.sent) continue;
    const post = byId.get(id);
    // launcher.json から消えた古い投稿でも、保存時に repo/theme を控えてあるので送れる。
    const repo = post?.repo ?? saved.repo;
    const theme = post?.theme ?? saved.theme;
    const date = post?.date ?? saved.date;
    const weekId = post?.weekId ?? saved.weekId;
    if (!repo || !theme || !date) continue;
    out.push({ id, weekId: weekId ?? '', date, repo, theme, rating: saved.rating });
  }
  return out.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
}

/** 「あすの日付」。空メッセージの言い回しに使う。 */
export function tomorrowOf(today) {
  return addDays(today, 1);
}

function byDateAsc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return (a.hour ?? 0) - (b.hour ?? 0);
}

function byDateDesc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (b.hour ?? 0) - (a.hour ?? 0);
}
