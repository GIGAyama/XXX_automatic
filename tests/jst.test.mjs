/**
 * JST ユーティリティのテスト。
 *
 * ここがずれると「日本時間の朝に出すはずの投稿が、前日扱いになって出てこない」
 * という、原因の分かりにくい事故になる。参考にした記事の著者も同じところでハマっている。
 *
 * 特に UTC 15:00（= JST 翌 0:00）の前後を必ず確かめる。
 * GitHub Actions は UTC で動くので、日本の深夜に走る処理はここをまたぐ。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    addDays,
    isoWeekId,
    jstDateAt,
    jstDateString,
    nextWeekDates,
    startOfIsoWeek,
    toJstParts,
    weekdayLabelOf,
    weekDatesOf,
} from '../scripts/lib/jst.mjs';

test('UTC 15:00 をまたぐと JST の日付が翌日になる', () => {
    // 2026-08-07T14:59:59Z は JST では 8/7 23:59:59 → まだ 8/7
    assert.equal(jstDateString(new Date('2026-08-07T14:59:59Z')), '2026-08-07');
    // 2026-08-07T15:00:00Z は JST では 8/8 00:00:00 → もう 8/8
    assert.equal(jstDateString(new Date('2026-08-07T15:00:00Z')), '2026-08-08');
});

test('UTC の日付が前日でも JST では今日として扱われる', () => {
    // これが本番で効く場面。UTC 22:00 は UTC ではまだ 8/7 だが、JST では 8/8 の朝7時。
    // 毎朝の通知ワークフローはこの時刻に走る。
    const at = new Date('2026-08-07T22:00:00Z');
    assert.equal(at.toISOString().slice(0, 10), '2026-08-07', '前提: UTC では 8/7');
    assert.equal(jstDateString(at), '2026-08-08', 'JST では 8/8 でなければならない');
    assert.equal(toJstParts(at).hour, 7, 'JST の 7時');
});

test('固定オフセットの結果が Intl の Asia/Tokyo と一致する', () => {
    // JST は夏時間を持たないので +9 固定で正しいはずだが、
    // 「正しいはず」で済ませずに突き合わせておく。
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });

    const samples = [
        '2026-01-01T00:00:00Z',
        '2026-03-08T10:00:00Z', // 米国の夏時間の切り替わり日
        '2026-06-30T15:00:00Z',
        '2026-11-01T05:00:00Z',
        '2026-12-31T15:00:00Z',
    ];

    for (const iso of samples) {
        const date = new Date(iso);
        assert.equal(jstDateString(date), formatter.format(date), `${iso} でずれています`);
    }
});

test('jstDateAt は JST の時刻から正しい瞬間を作る', () => {
    // JST 8/10 の朝7時 = UTC 8/9 の 22時
    assert.equal(jstDateAt('2026-08-10', 7, 0).toISOString(), '2026-08-09T22:00:00.000Z');
    // JST の 0時 = 前日 UTC 15時
    assert.equal(jstDateAt('2026-08-10', 0, 0).toISOString(), '2026-08-09T15:00:00.000Z');
});

test('addDays は月またぎ・年またぎ・うるう年で正しい', () => {
    assert.equal(addDays('2026-08-31', 1), '2026-09-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29', '2028年はうるう年');
    assert.equal(addDays('2026-02-28', 1), '2026-03-01', '2026年はうるう年ではない');
});

test('ISO 週番号は木曜日の属する年で決まる', () => {
    // 2026-01-01 は木曜。この週は 2026-W01。
    assert.equal(isoWeekId('2026-01-01'), '2026-W01');
    // 2025-12-29 は月曜で、その週の木曜は 2026-01-01。だから暦は2025年でも 2026-W01。
    assert.equal(isoWeekId('2025-12-29'), '2026-W01');
    assert.equal(isoWeekId('2026-08-07'), '2026-W32');
});

test('週は月曜はじまり、日曜終わり', () => {
    // 2026-08-07 は金曜
    assert.equal(weekdayLabelOf('2026-08-07'), '金');
    assert.equal(startOfIsoWeek('2026-08-07'), '2026-08-03', '週のはじめは月曜');
    // 日曜を「週の終わり」として扱えているか（0=日曜を7として計算している）
    assert.equal(weekdayLabelOf('2026-08-09'), '日');
    assert.equal(startOfIsoWeek('2026-08-09'), '2026-08-03', '日曜は前の月曜の週に属する');

    const week = weekDatesOf('2026-08-07');
    assert.equal(week.length, 7);
    assert.equal(week[0], '2026-08-03');
    assert.equal(week[6], '2026-08-09');
});

test('nextWeekDates は翌週の月曜から7日分', () => {
    // 日曜の夜に走る処理。日曜に呼んでも「翌週」であって「今日から」ではない。
    const fromSunday = nextWeekDates('2026-08-09');
    assert.equal(fromSunday[0], '2026-08-10', '日曜に呼んだら翌日の月曜から');
    assert.equal(fromSunday[6], '2026-08-16');

    const fromMonday = nextWeekDates('2026-08-03');
    assert.equal(fromMonday[0], '2026-08-10', '月曜に呼んでも翌週の月曜から');
});

test('不正な日付は黙って通さない', () => {
    assert.throws(() => addDays('2026-8-7', 1), /YYYY-MM-DD/);
    assert.throws(() => addDays('not-a-date', 1), /YYYY-MM-DD/);
});
