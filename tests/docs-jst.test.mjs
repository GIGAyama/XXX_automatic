/**
 * ブラウザ側の日付処理（docs/lib/jst-client.js）が、
 * 生成側（scripts/lib/jst.mjs）とずれていないことを確かめる。
 *
 * 同じ規則を2か所に書いている以上、いつかずれる。
 * 人の注意力で防ぐのは無理なので、両方を import して突き合わせる。
 * ずれたらここが落ちる。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as server from '../scripts/lib/jst.mjs';
import * as client from '../docs/lib/jst-client.js';

test('jstDateString が生成側と一致する（UTC 15:00 の境目を含む）', () => {
    // 2026-08-06T15:00:00Z ＝ JST では 2026-08-07 00:00。ここが最大の落とし穴。
    const base = Date.UTC(2026, 7, 6, 14, 55, 0);
    for (let i = 0; i < 1500; i += 1) {
        const at = new Date(base + i * 60_000); // 1分きざみで25時間ぶん
        assert.equal(client.jstDateString(at), server.jstDateString(at), at.toISOString());
    }
});

test('jstDateString が年月日をまたいでも一致する', () => {
    // 大晦日・元日・うるう日・月末を含む1年ぶんを1時間きざみで見る
    const base = Date.UTC(2027, 11, 30, 0, 0, 0);
    for (let i = 0; i < 96; i += 1) {
        const at = new Date(base + i * 3_600_000);
        assert.equal(client.jstDateString(at), server.jstDateString(at), at.toISOString());
    }
    const leap = Date.UTC(2028, 1, 28, 12, 0, 0);
    for (let i = 0; i < 48; i += 1) {
        const at = new Date(leap + i * 3_600_000);
        assert.equal(client.jstDateString(at), server.jstDateString(at), at.toISOString());
    }
});

test('jstStamp が生成側と一致する', () => {
    const base = Date.UTC(2026, 7, 6, 14, 0, 0);
    for (let i = 0; i < 300; i += 1) {
        const at = new Date(base + i * 137_000);
        assert.equal(client.jstStamp(at), server.jstStamp(at), at.toISOString());
    }
});

test('addDays / weekdayLabelOf が生成側と一致する', () => {
    let date = '2026-01-01';
    for (let i = 0; i < 400; i += 1) {
        assert.equal(client.weekdayLabelOf(date), server.weekdayLabelOf(date), date);
        const a = client.addDays(date, 1);
        const b = server.addDays(date, 1);
        assert.equal(a, b, date);
        date = a;
    }
});

test('addDays は負の数でも一致する', () => {
    for (const n of [-1, -7, -30, -90, -365]) {
        assert.equal(client.addDays('2026-03-01', n), server.addDays('2026-03-01', n), String(n));
    }
});

test('固定オフセットの結果が Intl の Asia/Tokyo と一致する', () => {
    // 固定 UTC+9 で正しいことの裏取り。JST は夏時間を持たないので一致するはず。
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const base = Date.UTC(2026, 7, 6, 0, 0, 0);
    for (let i = 0; i < 200; i += 1) {
        const at = new Date(base + i * 900_000);
        assert.equal(client.jstDateString(at), fmt.format(at), at.toISOString());
    }
});

test('daysBetween は日数の差を返す', () => {
    assert.equal(client.daysBetween('2026-08-07', '2026-08-10'), 3);
    assert.equal(client.daysBetween('2026-08-10', '2026-08-07'), -3);
    assert.equal(client.daysBetween('2026-02-28', '2026-03-01'), 1);
    assert.equal(client.daysBetween('2028-02-28', '2028-03-01'), 2); // うるう年
});

test('formatMd は先頭のゼロを落とす', () => {
    assert.equal(client.formatMd('2026-08-07'), '8/7');
    assert.equal(client.formatMd('2026-12-25'), '12/25');
});

test('形の違う日付は受け付けない', () => {
    assert.throws(() => client.addDays('2026/08/07', 1));
    assert.throws(() => client.weekdayLabelOf('20260807'));
    assert.throws(() => client.formatMd(''));
});
