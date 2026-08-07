/**
 * 日本時間（JST）に固定した日付ユーティリティ。
 *
 * ⚠️ このリポジトリで日付を扱うときは、必ずここを通すこと。
 *
 * GitHub Actions の cron は UTC で動く。素の `new Date().getDate()` を使うと、
 * 日本時間の 0:00〜9:00 のあいだ「前日」の日付が返る。
 * 参考にした記事の著者も、まさにここで
 * 「日本時間の朝7時に投稿されるはずが、システム内部では前日扱いで弾かれていた」
 * という事故を起こしている。原因が分かるまでに時間がかかる種類のバグである。
 *
 * JST は夏時間を持たず、UTC+9 で固定なので、オフセットを足すだけで正確に扱える。
 * （Intl.DateTimeFormat を使う手もあるが、パースし直す分だけ壊れどころが増える。
 *   固定オフセットで正しいことは tests/jst.test.mjs で Intl と突き合わせて確認している。）
 */

export const JST_OFFSET_MINUTES = 9 * 60;
const MS_PER_DAY = 86_400_000;

/** 日本語の曜日ラベル。index は getUTCDay() と同じく 0=日曜。 */
export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * ある瞬間を JST で見たときの年月日時分と曜日を返す。
 * @param {Date} [date] 省略時は現在時刻
 */
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

/** JST での現在時刻を 'YYYY-MM-DD HH:mm' で返す。ログ用。 */
export function jstStamp(date = new Date()) {
    const { hour, minute } = toJstParts(date);
    return `${jstDateString(date)} ${pad(hour)}:${pad(minute)} JST`;
}

/**
 * 'YYYY-MM-DD' と JST の時刻から、対応する瞬間（Date）を作る。
 * 例: jstDateAt('2026-08-10', 7, 0) は 2026-08-09T22:00:00Z を返す。
 */
export function jstDateAt(dateString, hour = 0, minute = 0) {
    const [year, month, day] = splitDateString(dateString);
    return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0));
}

/** 'YYYY-MM-DD' に n 日足した 'YYYY-MM-DD' を返す（n は負でもよい）。 */
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

/**
 * ISO 8601 の週番号を 'YYYY-Www' で返す。
 *
 * 週の識別子を年またぎでもぶつからないようにするために ISO 週を使う。
 * ISO 週は「その週の木曜日が属する年」を年とする決まりなので、
 * 12月末や1月初めは暦の年と食い違うことがある（それが正しい挙動）。
 */
export function isoWeekId(dateOrString = new Date()) {
    const dateString = typeof dateOrString === 'string' ? dateOrString : jstDateString(dateOrString);
    const [year, month, day] = splitDateString(dateString);

    const d = new Date(Date.UTC(year, month - 1, day));
    const dayNum = d.getUTCDay() || 7; // 月=1 … 日=7 に直す
    d.setUTCDate(d.getUTCDate() + 4 - dayNum); // その週の木曜へ動かす

    const isoYear = d.getUTCFullYear();
    const jan1 = Date.UTC(isoYear, 0, 1);
    const week = Math.ceil(((d.getTime() - jan1) / MS_PER_DAY + 1) / 7);
    return `${isoYear}-W${pad(week)}`;
}

/** 'YYYY-MM-DD' を含む週の月曜日を返す。 */
export function startOfIsoWeek(dateString) {
    const dayNum = weekdayOf(dateString) || 7; // 日曜を7として扱う
    return addDays(dateString, 1 - dayNum);
}

/**
 * 「次の週（月曜はじまり）の7日分」の 'YYYY-MM-DD' を返す。
 * 日曜の夜に翌週分をまとめて作るための入口。
 */
export function nextWeekDates(from = new Date()) {
    const today = typeof from === 'string' ? from : jstDateString(from);
    const nextMonday = addDays(startOfIsoWeek(today), 7);
    return Array.from({ length: 7 }, (_, i) => addDays(nextMonday, i));
}

/** 'YYYY-MM-DD' を含む週の7日分。 */
export function weekDatesOf(dateString) {
    const monday = startOfIsoWeek(dateString);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * ISO 週番号から、その週の月曜〜日曜を出す。
 *
 * ISO 週の第1週は「1月4日を含む週」と決まっている。
 * ここを起点にすると、年またぎ（12月末が翌年の第1週になるなど）でもずれない。
 */
export function weekDatesOfIsoWeek(year, week) {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Dow = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * MS_PER_DAY);
    const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * MS_PER_DAY);
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday.getTime() + i * MS_PER_DAY);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    });
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function splitDateString(dateString) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString));
    if (!m) throw new Error(`日付は 'YYYY-MM-DD' 形式で渡してください: ${dateString}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
