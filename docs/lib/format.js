/**
 * 画面に出す文字列の組み立て。
 *
 * DOM を作る処理と文字列を作る処理を混ぜると、文言だけを直したいときに
 * 描画のコードを読むはめになる。文字列はここに寄せる。
 */

import { formatMd, weekdayLabelOf } from './jst-client.js';

/** '8/10（月）朝' のような、カードの見出しに出す1行。 */
export function slotChipLabel(post) {
  return `${formatMd(post.date)}（${weekdayLabelOf(post.date)}）${post.slotLabel ?? ''}`.trim();
}

/** 長い文を「…」で切る。note のプレビューなどに使う。 */
export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** launcher.json の themes からラベルの対応表を作る。Issue の本文を人が読める形にするため。 */
export function themeLabelMap(data) {
  const out = {};
  for (const post of data.posts ?? []) {
    if (post.theme && post.themeLabel) out[post.theme] = post.themeLabel;
  }
  return out;
}

/** launcher.json の slots からラベルの対応表を作る。 */
export function slotLabelMap(data) {
  const out = {};
  for (const slot of data.slots ?? []) out[slot.id] = slot.label;
  for (const post of data.posts ?? []) {
    if (post.slot && post.slotLabel) out[post.slot] ??= post.slotLabel;
  }
  return out;
}

/** 何字オーバーしているかを添えた案内文。 */
export function overLimitMessage(length, max) {
  return `${max} 文字を超えています（${length - max} 字オーバー）。このままだと X で投稿できません。`;
}
