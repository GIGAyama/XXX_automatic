/**
 * 「いまが学校のどの時期か」の判定。
 *
 * 教員に届く発信は、内容の良し悪しより『いま困っていることか』でほとんど決まる。
 * 所見に追われている12月に運動会の話をしても読まれない。
 * ここがずれると、題材選びが1年じゅう少しずつ的を外しつづける。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { periodOf, seasonBriefOf, weekdayNoteOf } from '../scripts/lib/season.mjs';
import { weekDatesOf } from '../scripts/lib/jst.mjs';

const calendar = JSON.parse(fs.readFileSync(new URL('../config/calendar.json', import.meta.url), 'utf8'));

test('その日の時期が分かる', () => {
    assert.equal(periodOf('2026-04-10', calendar).id, 'start-of-year');
    assert.equal(periodOf('2026-05-20', calendar).id, 'spring');
    assert.equal(periodOf('2026-07-18', calendar).id, 'term-end-1');
    assert.equal(periodOf('2026-08-07', calendar).id, 'summer');
    assert.equal(periodOf('2026-10-01', calendar).id, 'autumn');
    assert.equal(periodOf('2026-12-10', calendar).id, 'term-end-2');
    assert.equal(periodOf('2026-02-01', calendar).id, 'winter');
    assert.equal(periodOf('2026-03-15', calendar).id, 'end-of-year');
});

test('年をまたぐ時期（冬休み）も判定できる', () => {
    // from > to で書いてある期間。ここを素直に比較すると必ず外れる。
    assert.equal(periodOf('2026-12-28', calendar).id, 'winter-break');
    assert.equal(periodOf('2027-01-03', calendar).id, 'winter-break');
    assert.equal(periodOf('2027-01-10', calendar).id, 'winter');
});

test('1年365日、どの日でも時期が決まる（すき間が無い）', () => {
    // すき間があると、その週だけ時期の情報なしで生成されることになる。
    let date = '2026-01-01';
    for (let i = 0; i < 365; i += 1) {
        assert.ok(periodOf(date, calendar), `${date} の時期が決まりません`);
        const [y, m, d] = date.split('-').map(Number);
        const at = new Date(Date.UTC(y, m - 1, d + 1));
        const pad = (v) => String(v).padStart(2, '0');
        date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
    }
});

test('期間が重なったら、狭いほうを採る', () => {
    // 「1学期」と「1学期末」が重なる日は、狭い「1学期末」であってほしい。
    const at = periodOf('2026-07-15', calendar);
    assert.equal(at.id, 'term-end-1');
    assert.ok(at.pains.includes('所見'));
});

test('週ぜんぶをまとめた説明が作れる', () => {
    const brief = seasonBriefOf(weekDatesOf('2026-12-07'), calendar);
    assert.match(brief, /2学期末/);
    assert.match(brief, /所見/);
});

test('週が時期をまたぐと、両方が出る', () => {
    // 12/22〜12/28 は「2学期末」と「冬休み」にまたがる
    const brief = seasonBriefOf(weekDatesOf('2026-12-24'), calendar);
    assert.match(brief, /2学期末/);
    assert.match(brief, /冬休み/);
});

test('行事暦が空でも落ちない', () => {
    assert.equal(periodOf('2026-08-07', { periods: [] }), null);
    assert.equal(seasonBriefOf(['2026-08-07'], null), '');
});

test('曜日ごとの温度が取れる', () => {
    assert.match(weekdayNoteOf('2026-08-10', calendar), /週のはじめ/); // 月曜
    assert.match(weekdayNoteOf('2026-08-15', calendar), /休み/); // 土曜
    assert.equal(weekdayNoteOf('2026-08-10', {}), '');
});

test('日付を持たない枠でも落ちない（予備の引き出しがこれで作れなくなっていた）', () => {
    // 予備の投稿（data/stock.json）は日付を持たない。
    // ここが throw していたせいで buildStock が毎回まるごと失敗し、
    // ［いま出す］タブは一度も中身を持ったことがなかった。
    // 曜日の温度は「引けなければ無し」でよい規則である。日付の妥当性は jst.mjs の責務。
    for (const bad of ['', null, undefined, '2026-8-1', 'stock']) {
        assert.equal(weekdayNoteOf(bad, calendar), '', `${JSON.stringify(bad)} で落ちています`);
    }
});

test('行事暦に書いてある時期は、すべて実際に当たる日がある', () => {
    // 書いたのに一度も選ばれない時期があると、書いた本人が気づけない。
    const seen = new Set();
    let date = '2026-01-01';
    for (let i = 0; i < 365; i += 1) {
        seen.add(periodOf(date, calendar).id);
        const [y, m, d] = date.split('-').map(Number);
        const at = new Date(Date.UTC(y, m - 1, d + 1));
        const pad = (v) => String(v).padStart(2, '0');
        date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
    }
    for (const period of calendar.periods) {
        assert.ok(seen.has(period.id), `${period.id}（${period.label}）が1日も選ばれません`);
    }
});
