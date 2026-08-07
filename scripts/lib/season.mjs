/**
 * 「いまが学校のどの時期か」を返す。
 *
 * 教員に届く発信は、内容の良し悪しより『いま困っていることか』でほとんど決まる。
 * 所見に追われている12月に運動会の話をしても読まれないし、
 * 逆に所見の話ならその週だけは刺さる。時期は毎年ほぼ同じなので機械で持てる。
 *
 * 判定は config/calendar.json の periods を使う。日付は月日（MM-DD）だけを見る。
 */
import { weekdayOf } from './jst.mjs';

/** 'YYYY-MM-DD' → 'MM-DD' */
function monthDay(dateString) {
    return String(dateString).slice(5, 10);
}

/** その期間が何日ぶんあるか。狭い期間を優先するために使う。 */
function spanDays(period) {
    const [fm, fd] = period.from.split('-').map(Number);
    const [tm, td] = period.to.split('-').map(Number);
    const from = fm * 31 + fd;
    const to = tm * 31 + td;
    return to >= from ? to - from : 372 - from + to; // 年をまたぐ場合
}

function covers(period, md) {
    const { from, to } = period;
    // 年をまたぐ期間（冬休みなど）は from > to で書いてある
    return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/**
 * その日が属する時期を返す。当てはまるものが複数あれば、範囲の狭いほうを採る。
 * @returns {object|null} calendar.json の periods の1つ
 */
export function periodOf(dateString, calendar) {
    const md = monthDay(dateString);
    const hits = (calendar?.periods ?? []).filter((p) => covers(p, md));
    if (hits.length === 0) return null;
    return hits.sort((a, b) => spanDays(a) - spanDays(b))[0];
}

/**
 * その日の曜日の温度（calendar.json の weekdays）。
 *
 * ⚠️ 日付が読めないときは throw せず '' を返す。
 *    予備の投稿（data/stock.json）は日付を持たない枠として作られる。
 *    ここが throw していたせいで、予備を作る処理がまるごと例外で落ち、
 *    ［いま出す］タブは一度も中身を持ったことがなかった。
 *    曜日の温度は「引けなければ無し」でよい情報である。
 *    日付そのものが正しいかを見るのは jst.mjs の仕事なので、ここでは兼ねない。
 */
export function weekdayNoteOf(dateString, calendar) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString ?? ''))) return '';
    return calendar?.weekdays?.[String(weekdayOf(dateString))] ?? '';
}

/**
 * その週ぜんぶをまとめた「いまの時期」の説明。プロンプトに入れる。
 * 週の途中で時期が変わることがあるので、出てきたものを全部並べる。
 */
export function seasonBriefOf(dates, calendar) {
    const seen = new Map();
    for (const date of dates) {
        const period = periodOf(date, calendar);
        if (period && !seen.has(period.id)) seen.set(period.id, period);
    }
    if (seen.size === 0) return '';

    return [...seen.values()]
        .map((p) => `- ${p.label}（${p.from}〜${p.to}）: この時期の困りごとは「${p.pains.join('・')}」。${p.angle}`)
        .join('\n');
}
