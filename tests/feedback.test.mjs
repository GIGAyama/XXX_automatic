/**
 * 反応の記録を Issue で往復させる部分の検証。
 *
 * ここは公開リポジトリに口を開ける唯一の場所なので、
 * 「誰でも書ける入力を、どこまで信じるか」を明示的に固定しておく。
 * あわせて、同じ Issue を二度読んでも数がずれないことを確かめる。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ISSUE_LABEL,
    MAX_URL_CHARS,
    buildIssueUrl,
    buildPayload,
    chunkEntries,
    extractPayload,
    mergeFeedback,
    newSubmissionId,
    renderIssueBody,
    renderIssueTitle,
    validatePayload,
} from '../docs/lib/feedback-payload.js';
import { isAllowedAuthor } from '../scripts/collect-feedback.mjs';

const REPO_URL = 'https://github.com/GIGAyama/XXX_automatic';
const THEMES = new Set(['intro', 'pain', 'tips']);
const REPOS = new Set(['KANJI_Town', 'Typa', 'Qalc']);

function entry(i, extra = {}) {
    const day = String(10 + (i % 7)).padStart(2, '0');
    return {
        id: `2026-08-${day}-${i % 2 === 0 ? 'morning' : 'evening'}`,
        weekId: '2026-W33',
        date: `2026-08-${day}`,
        repo: 'KANJI_Town',
        theme: 'intro',
        rating: 'good',
        ...extra,
    };
}

function payloadOf(entries, id = 'sub-11111111') {
    return buildPayload(entries, { submissionId: id, sentAtJst: '2026-08-14 21:03 JST' });
}

test('本文に埋めたものが、そのまま読み返せる', () => {
    const p = payloadOf([entry(0)]);
    assert.deepEqual(extractPayload(renderIssueBody(p)), p);
});

test('本文には人が読める要約も入る（中身が見えないものを送らせない）', () => {
    const body = renderIssueBody(payloadOf([entry(0)]), { themeLabels: { intro: 'アプリ紹介' }, slotLabels: { morning: '朝' } });
    assert.match(body, /8\/10 朝 KANJI_Town（アプリ紹介）… よかった/);
});

test('タイトルに週と件数が入る', () => {
    assert.match(renderIssueTitle(payloadOf([entry(0), entry(1)])), /2026-W33.*2件/);
    assert.match(renderIssueTitle(payloadOf([entry(0)]), { part: 2, parts: 3 }), /2\/3通目/);
});

test('Issue の URL にラベルと本文が載る', () => {
    const url = buildIssueUrl(REPO_URL, payloadOf([entry(0)]));
    assert.ok(url.startsWith(`${REPO_URL}/issues/new?`));
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(params.get('labels'), ISSUE_LABEL);
    assert.ok(params.get('body').includes('feedback-v1'));
});

test('リポジトリ URL の末尾スラッシュを二重にしない', () => {
    assert.ok(buildIssueUrl(`${REPO_URL}/`, payloadOf([entry(0)])).startsWith(`${REPO_URL}/issues/new?`));
});

test('週14件（1週間ぶん）は1通に収まる', () => {
    // ふつうの使い方で毎回2通に分かれるようだと、送るのが面倒になって続かない。
    const entries = Array.from({ length: 14 }, (_, i) => entry(i));
    const chunks = chunkEntries(entries, { repoUrl: REPO_URL, themeLabels: { intro: 'アプリ紹介' }, slotLabels: { morning: '朝', evening: '夜' } });
    assert.equal(chunks.length, 1);
});

test('件数が多いときは URL の上限で分割する（黙って捨てない）', () => {
    const entries = Array.from({ length: 120 }, (_, i) => entry(i));
    const chunks = chunkEntries(entries, { repoUrl: REPO_URL });
    assert.ok(chunks.length > 1);
    assert.equal(chunks.flat().length, 120); // 1件も落ちない
    for (const [i, chunk] of chunks.entries()) {
        const url = buildIssueUrl(REPO_URL, payloadOf(chunk), { part: i + 1, parts: chunks.length });
        assert.ok(url.length <= MAX_URL_CHARS, `${i} 通目が長すぎます: ${url.length}`);
    }
});

test('1件も無ければ通を作らない', () => {
    assert.deepEqual(chunkEntries([], { repoUrl: REPO_URL }), []);
});

test('正しいペイロードは通る', () => {
    const { ok, errors } = validatePayload(payloadOf([entry(0)]), { themeIds: THEMES, repoNames: REPOS });
    assert.equal(ok, true, errors.join('\n'));
});

test('知らない型・知らないアプリは拒否する', () => {
    const bad = payloadOf([entry(0, { theme: 'まだ無い型' })]);
    assert.equal(validatePayload(bad, { themeIds: THEMES, repoNames: REPOS }).ok, false);

    const bad2 = payloadOf([entry(0, { repo: '../../etc/passwd' })]);
    assert.equal(validatePayload(bad2, { themeIds: THEMES, repoNames: REPOS }).ok, false);
});

test('rating は good か bad だけ', () => {
    const bad = payloadOf([entry(0, { rating: 'best' })]);
    assert.equal(validatePayload(bad, { themeIds: THEMES, repoNames: REPOS }).ok, false);
});

test('ID の形が違うものは拒否する', () => {
    const bad = payloadOf([entry(0, { id: '../secret' })]);
    assert.equal(validatePayload(bad, { themeIds: THEMES, repoNames: REPOS }).ok, false);
});

test('同じ ID を2回入れたものは拒否する', () => {
    const bad = payloadOf([entry(0), entry(0)]);
    assert.equal(validatePayload(bad, { themeIds: THEMES, repoNames: REPOS }).ok, false);
});

test('件数が多すぎるものは拒否する（壊れた入力で無限に読まされない）', () => {
    const bad = payloadOf(Array.from({ length: 300 }, (_, i) => entry(i, { id: `2026-08-10-s${i}` })));
    assert.equal(validatePayload(bad, { themeIds: THEMES, repoNames: REPOS }).ok, false);
});

test('スキーマ名が違うものは拒否する', () => {
    const bad = { ...payloadOf([entry(0)]), schema: 'feedback-v99' };
    assert.equal(validatePayload(bad, { themeIds: THEMES, repoNames: REPOS }).ok, false);
});

test('機械向けブロックが無い本文からは何も取れない', () => {
    assert.equal(extractPayload('ふつうのコメントです'), null);
    assert.equal(extractPayload('```json feedback-v1\nこれは JSON ではない\n```'), null);
    assert.equal(extractPayload(null), null);
});

test('取り込むと themes と repos が集計される', () => {
    const { merged, applied } = mergeFeedback(null, [
        { payload: payloadOf([entry(0), entry(1, { rating: 'bad' })]), issueNumber: 1 },
    ]);
    assert.equal(applied, 1);
    assert.deepEqual(merged.themes.intro, { good: 1, bad: 1 });
    assert.deepEqual(merged.repos.KANJI_Town, { good: 1, bad: 1 });
});

test('同じ Issue を二度読んでも数がずれない', () => {
    // 集計値を足しこむ形にすると、ここが必ずずれる。posts から作り直しているので変わらない。
    const first = mergeFeedback(null, [{ payload: payloadOf([entry(0)]), issueNumber: 7 }]);
    const second = mergeFeedback(first.merged, [{ payload: payloadOf([entry(0)]), issueNumber: 7 }]);
    assert.equal(second.applied, 0);
    assert.equal(second.skipped, 1);
    assert.deepEqual(second.merged.themes.intro, { good: 1, bad: 0 });
});

test('submissionId が同じなら、別の Issue 番号でも二重に数えない', () => {
    const first = mergeFeedback(null, [{ payload: payloadOf([entry(0)], 'same-id-1234'), issueNumber: 1 }]);
    const second = mergeFeedback(first.merged, [{ payload: payloadOf([entry(0)], 'same-id-1234'), issueNumber: 2 }]);
    assert.equal(second.applied, 0);
});

test('押し直したら、あとから来たものが勝つ', () => {
    const first = mergeFeedback(null, [{ payload: payloadOf([entry(0)], 'a-1111111'), issueNumber: 1 }]);
    const second = mergeFeedback(first.merged, [
        { payload: payloadOf([entry(0, { rating: 'bad' })], 'b-2222222'), issueNumber: 2 },
    ]);
    assert.deepEqual(second.merged.themes.intro, { good: 0, bad: 1 });
    assert.equal(Object.keys(second.merged.posts).length, 1);
});

test('覚えておく submissionId は際限なく伸ばさない', () => {
    // 閉じた Issue を二度読むことはないので、古い目印を持ちつづける意味がない。
    let current = null;
    for (let i = 0; i < 260; i += 1) {
        current = mergeFeedback(current, [
            { payload: payloadOf([entry(0, { id: `2026-08-10-s${i}` })], `sub-${i}0000000`), issueNumber: i },
        ]).merged;
    }
    assert.equal(current.seen.submissionIds.length, 200);
    assert.equal(current.seen.issueNumbers.length, 200);
    // 記録そのものは落とさない
    assert.equal(Object.keys(current.posts).length, 260);
});

test('取り込むのはリポジトリの持ち主が立てた Issue だけ', () => {
    // 公開リポジトリなので誰でも Issue を立てられる。
    // 確かめずに取り込むと、第三者が翌週の生成の重み付けを動かせてしまう。
    const accounts = { githubOwner: 'GIGAyama' };
    assert.equal(isAllowedAuthor('GIGAyama', accounts), true);
    assert.equal(isAllowedAuthor('someone-else', accounts), false);
    assert.equal(isAllowedAuthor(undefined, accounts), false);
    assert.equal(isAllowedAuthor('helper', { ...accounts, feedbackAuthors: ['helper'] }), true);
});

test('submissionId は毎回ちがう', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSubmissionId()));
    assert.equal(ids.size, 50);
});

/* ── フックと「出したかどうか」──────────────────────
 *
 * 型（theme）とアプリ（repo）だけを記録していたあいだ、
 * いちばん効く軸——最初の1行の型——のデータを毎週捨てていた。
 * また「投稿した」は端末のなかにしか無く、出し忘れが誰にも見えなかった。
 *
 * ⚠️ SCHEMA_ID は上げていない。上げると送信ずみで開いたままの Issue が
 *    まとめて拒否される。古い形（hook も posted も無い）が
 *    引きつづき通ることを、ここで固定しておく。 */

const HOOKS = new Set(['scene', 'confess', 'number']);

test('古い形の記録（hook も posted も無い）はこれまでどおり通る', () => {
    const old = {
        schema: 'feedback-v1',
        submissionId: 'old-11111111',
        sentAtJst: '2026-08-14 21:03 JST',
        entries: [{ id: '2026-08-10-morning', weekId: '2026-W33', date: '2026-08-10', repo: 'Typa', theme: 'intro', rating: 'good' }],
    };
    const { ok, errors } = validatePayload(old, { themeIds: THEMES, repoNames: REPOS, hookIds: HOOKS });
    assert.ok(ok, JSON.stringify(errors));

    // 評価が付いている＝出したということなので、posted は真とみなす
    const { merged } = mergeFeedback(null, [{ payload: old, issueNumber: 1 }]);
    assert.equal(merged.posts['2026-08-10-morning'].posted, true);
    assert.equal(merged.posts['2026-08-10-morning'].hook, null);
    assert.deepEqual(merged.hooks, {});
});

test('hook を載せると型ごとに集計される', () => {
    const { merged } = mergeFeedback(null, [
        {
            payload: payloadOf([
                entry(0, { hook: 'scene' }),
                entry(1, { hook: 'scene' }),
                entry(2, { hook: 'confess', rating: 'bad' }),
            ]),
            issueNumber: 1,
        },
    ]);
    assert.deepEqual(merged.hooks.scene, { good: 2, bad: 0 });
    assert.deepEqual(merged.hooks.confess, { good: 0, bad: 1 });
});

test('知らないフックの型は拒否する（外から来る入力なので確かめる）', () => {
    const bad = payloadOf([entry(0, { hook: '../../etc/passwd' })]);
    const { ok, errors } = validatePayload(bad, { themeIds: THEMES, repoNames: REPOS, hookIds: HOOKS });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('hook')), JSON.stringify(errors));
});

test('評価が無くても「出した」だけなら送れる', () => {
    const payload = payloadOf([{ ...entry(0), rating: null, posted: true }]);
    assert.equal(payload.entries[0].rating, undefined, 'rating は載せない');
    assert.equal(payload.entries[0].posted, true);

    const { ok, errors } = validatePayload(payload, { themeIds: THEMES, repoNames: REPOS });
    assert.ok(ok, JSON.stringify(errors));

    const { merged } = mergeFeedback(null, [{ payload, issueNumber: 1 }]);
    assert.equal(merged.posted.total, 1);
    assert.deepEqual(merged.themes, {}, '評価が無いものは good/bad に数えない');
});

test('rating も posted も無い記録は拒否する（何も言っていない）', () => {
    const bad = payloadOf([{ ...entry(0), rating: null }]);
    const { ok, errors } = validatePayload(bad, { themeIds: THEMES, repoNames: REPOS });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('posted')), JSON.stringify(errors));
});

test('出せた件数を枠ごと・曜日ごとに数える（slots を見なおす材料）', () => {
    // 2026-08-10 は月曜（1）、2026-08-11 は火曜（2）
    const { merged } = mergeFeedback(null, [
        {
            payload: payloadOf([
                { ...entry(0), posted: true }, // 08-10 morning
                { ...entry(1), posted: true }, // 08-11 evening
                { ...entry(8), posted: true }, // 08-11 morning
            ]),
            issueNumber: 1,
        },
    ]);
    assert.equal(merged.posted.total, 3);
    assert.equal(merged.posted.bySlot.morning, 2);
    assert.equal(merged.posted.bySlot.evening, 1);
    assert.equal(merged.posted.byWeekday[1], 1, '月曜に1件');
    assert.equal(merged.posted.byWeekday[2], 2, '火曜に2件');
});

test('人が読む要約に、評価なしの記録も言葉で出る', () => {
    // 中身が見えないものを送らせない、という約束は評価なしの記録でも同じ。
    const body = renderIssueBody(payloadOf([{ ...entry(0), rating: null, posted: true }]));
    assert.match(body, /出した（評価なし）/);
});

test('集計は何度取り込んでも同じ値になる（hooks と posted も）', () => {
    const payload = payloadOf([entry(0, { hook: 'scene' })], 'once-1234567');
    const first = mergeFeedback(null, [{ payload, issueNumber: 3 }]);
    const second = mergeFeedback(first.merged, [{ payload, issueNumber: 3 }]);
    assert.deepEqual(second.merged.hooks, first.merged.hooks);
    assert.deepEqual(second.merged.posted, first.merged.posted);
});

/* ── 枠（slot）──────────────────────────────
 *
 * ［つくる］で作らせた投稿は、IDが '2026-08-09-promo-ab12c1' のように
 * 毎回変わる。枠をIDの後半から読んでいたままだと、bySlot が一度きりのキーで埋まり、
 * 「どの枠なら実際に出せているか」が読めなくなる（config/slots.json を見なおす材料が濁る）。
 * 注文ぶんは slot='promo' でまとまる。 */

test('slot を持つ記録は、その枠として数える', () => {
    const payload = payloadOf([
        entry(0, { id: '2026-08-09-promo-ab12c1', slot: 'promo', posted: true }),
        entry(1, { id: '2026-08-09-promo-ab12c2', slot: 'promo', posted: true }),
    ]);
    const { merged } = mergeFeedback(null, [{ payload, issueNumber: 9 }]);
    assert.equal(merged.posted.bySlot.promo, 2);
    assert.deepEqual(Object.keys(merged.posted.bySlot), ['promo']);
});

test('slot を持たない古い記録は、これまでどおりIDから読む', () => {
    const payload = payloadOf([entry(0), entry(1)]); // morning / evening
    const { merged } = mergeFeedback(null, [{ payload, issueNumber: 10 }]);
    assert.equal(merged.posted.bySlot.morning, 1);
    assert.equal(merged.posted.bySlot.evening, 1);
});

test('slot の形がおかしければ Issue ごと拒否する', () => {
    for (const bad of ['../ほか', 'MORNING', 'a'.repeat(30), '朝']) {
        const payload = payloadOf([entry(0, { slot: bad })]);
        const { ok } = validatePayload(payload, { themeIds: THEMES, repoNames: REPOS });
        assert.equal(ok, false, `通ってはいけない: ${bad}`);
    }
});

test('人が読む要約は、slot があるときそちらを使う', () => {
    const body = renderIssueBody(payloadOf([entry(0, { id: '2026-08-09-promo-ab12c1', slot: 'promo' })]), {
        slotLabels: { promo: 'つくった投稿' },
    });
    assert.match(body, /つくった投稿/);
});
