/**
 * ブラウザ側の JST 日付ユーティリティ。
 *
 * ⚠️ ランチャーで日付を扱うときは、必ずここを通すこと。
 *
 * なぜ scripts/lib/jst.mjs をそのまま読まないのか:
 *   docs/ は GitHub Pages から素の JS として配信される。scripts/ は配信対象ではないし、
 *   配信対象にすると「スクリプト置き場が公開物に混ざる」という別の分かりにくさが生まれる。
 *   そこで最小限だけをここに写している。
 *
 * 写しである以上、いつかずれる。ずれを人の注意力で防ぐのは無理なので、
 * tests/docs-jst.test.mjs が scripts/lib/jst.mjs と両方を import して、
 * UTC 15:00（＝JST 0:00）をまたぐ数千の瞬間で結果が一致することを確かめている。
 * ここを直したら、あちらのテストが落ちる。
 *
 * JST は夏時間を持たず UTC+9 で固定なので、オフセットを足すだけで正確に扱える。
 * getUTC* を使うのは、端末のタイムゾーン設定に結果を左右させないためである。
 */

export const JST_OFFSET_MINUTES = 9 * 60;

/** 日本語の曜日ラベル。index は getUTCDay() と同じく 0=日曜。 */
export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** ある瞬間を JST で見たときの年月日時分と曜日。 */
export function toJstParts(date = new Date()) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** JST での「今日」を 'YYYY-MM-DD' で返す。 */
export function jstDateString(date = new Date()) {
  const { year, month, day } = toJstParts(date);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** JST での現在時刻を 'YYYY-MM-DD HH:mm JST' で返す。記録用。 */
export function jstStamp(date = new Date()) {
  const { hour, minute } = toJstParts(date);
  return `${jstDateString(date)} ${pad(hour)}:${pad(minute)} JST`;
}

/** 'YYYY-MM-DD' に n 日足した 'YYYY-MM-DD'（n は負でもよい）。 */
export function addDays(dateString, n) {
  const [year, month, day] = splitDateString(dateString);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' の曜日番号（0=日曜）。 */
export function weekdayOf(dateString) {
  const [year, month, day] = splitDateString(dateString);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 'YYYY-MM-DD' の日本語曜日ラベル。 */
export function weekdayLabelOf(dateString) {
  return WEEKDAY_JA[weekdayOf(dateString)];
}

/** 2つの 'YYYY-MM-DD' の日数差（b - a）。 */
export function daysBetween(a, b) {
  const [ay, am, ad] = splitDateString(a);
  const [by, bm, bd] = splitDateString(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** '2026-08-10' → '8/10'。画面に出す短い形。 */
export function formatMd(dateString) {
  const [, month, day] = splitDateString(dateString);
  return `${month}/${day}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function splitDateString(dateString) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString));
  if (!m) throw new Error(`日付は 'YYYY-MM-DD' 形式で渡してください: ${dateString}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
