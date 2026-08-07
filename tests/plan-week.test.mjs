/**
 * 週の割り当てのテスト。
 *
 * ここが偏ると「同じアプリばかり出てくる」「毎日同じ調子の投稿になる」という、
 * 読む人にいちばん飽きられる壊れ方をする。
 * しかも動いてはいるので、気づくまでに時間がかかる。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { planWeek } from '../scripts/lib/plan-week.mjs';
import { weekDatesOf } from '../scripts/lib/jst.mjs';

const themesConfig = JSON.parse(readFileSync(new URL('../config/themes.json', import.meta.url), 'utf8'));

const slots = [
    { id: 'morning', label: '朝', hour: 7 },
    { id: 'evening', label: '夜', hour: 21 },
];

const dates = weekDatesOf('2026-08-10'); // 2026-08-10(月) 〜 08-16(日)

function makeProfiles(n) {
    return Array.from({ length: n }, (_, i) => ({
        name: `App${i + 1}`,
        pagesUrl: `https://gigayama.github.io/App${i + 1}/`,
        postability: 3,
        pushedAt: '2026-08-01T00:00:00Z',
    }));
}

test('7日 × 2枠 = 14件が割り当たる', () => {
    const plan = planWeek({ dates, slots, themesConfig, profiles: makeProfiles(20), weekId: '2026-W33' });
    assert.equal(plan.length, 14);
    assert.equal(plan[0].date, '2026-08-10');
    assert.equal(plan[13].date, '2026-08-16');
    assert.equal(plan[0].weekday, '月');
});

test('同じ週IDなら何度作っても同じ割り当てになる', () => {
    // 生成をやり直したときに構成がまるごと変わると、
    // 「昨日見た並び」と食い違って混乱する。
    const profiles = makeProfiles(20);
    const a = planWeek({ dates, slots, themesConfig, profiles, weekId: '2026-W33' });
    const b = planWeek({ dates, slots, themesConfig, profiles, weekId: '2026-W33' });
    assert.deepEqual(a, b);
});

test('週が変われば割り当ても変わる', () => {
    const profiles = makeProfiles(20);
    const a = planWeek({ dates, slots, themesConfig, profiles, weekId: '2026-W33' });
    const b = planWeek({ dates, slots, themesConfig, profiles, weekId: '2026-W34' });
    assert.notDeepEqual(
        a.map((p) => `${p.repo}/${p.theme}`),
        b.map((p) => `${p.repo}/${p.theme}`)
    );
});

test('アプリが十分あれば同じアプリが週に2回出ない', () => {
    const plan = planWeek({ dates, slots, themesConfig, profiles: makeProfiles(30), weekId: '2026-W33' });
    const counts = new Map();
    for (const p of plan) counts.set(p.repo, (counts.get(p.repo) ?? 0) + 1);
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    assert.deepEqual(repeated, [], `同じアプリが複数回出ています: ${JSON.stringify(repeated)}`);
});

test('型が2日以上続けて同じにならない', () => {
    const plan = planWeek({ dates, slots, themesConfig, profiles: makeProfiles(30), weekId: '2026-W33' });
    // rotation.noSameThemeWithinDays = 2。同じ日の朝と夜も別の型になるはず。
    for (let i = 1; i < plan.length; i += 1) {
        assert.notEqual(plan[i].theme, plan[i - 1].theme, `${plan[i].id} で型が連続しています（${plan[i].theme}）`);
    }
});

test('アプリが少なくても止まらず埋まる', () => {
    // 使えるアプリが2件しかない場合。ローテーション規則は満たせないが、
    // 「割り当てられませんでした」で止まるより、重複してでも埋めるほうがよい。
    const plan = planWeek({ dates, slots, themesConfig, profiles: makeProfiles(2), weekId: '2026-W33' });
    assert.equal(plan.length, 14);
    assert.ok(plan.every((p) => p.repo && p.theme));
});

test('プロフィールが空なら分かる形で止まる', () => {
    assert.throws(
        () => planWeek({ dates, slots, themesConfig, profiles: [], weekId: '2026-W33' }),
        /プロフィールが1件もありません/
    );
});

test('直近で使ったアプリは選ばれにくくなる', () => {
    // 履歴で App1 を直前に使っていたら、週のはじめには来ないはず。
    const profiles = makeProfiles(10);
    const history = [
        { date: '2026-08-09', repo: 'App1', theme: 'intro' },
        { date: '2026-08-08', repo: 'App2', theme: 'pain' },
    ];
    const plan = planWeek({ dates, slots, themesConfig, profiles, history, weekId: '2026-W33' });
    const firstDay = plan.filter((p) => p.date === '2026-08-10').map((p) => p.repo);
    assert.ok(!firstDay.includes('App1'), 'noSameRepoWithinDays=4 に反して App1 が翌日に出ています');
});

test('更新の無いアプリしか無いとき「アップデート報告」は選ばれない', () => {
    // 事実でない報告を書かせないための切り替え。
    const stale = makeProfiles(10).map((p) => ({ ...p, pushedAt: '2025-01-01T00:00:00Z' }));
    const plan = planWeek({ dates, slots, themesConfig, profiles: stale, weekId: '2026-W33' });
    assert.ok(
        plan.every((p) => p.theme !== 'update'),
        '古いリポジトリしか無いのにアップデート報告が割り当てられています'
    );
});

test('「反応よかった」が多い型は選ばれやすくなる', () => {
    const profiles = makeProfiles(30);
    const base = planWeek({ dates, slots, themesConfig, profiles, weekId: '2026-W33' });
    const boosted = planWeek({
        dates,
        slots,
        themesConfig,
        profiles,
        feedback: { tips: { good: 20, bad: 0 } },
        weekId: '2026-W33',
    });

    const countTips = (plan) => plan.filter((p) => p.theme === 'tips').length;
    assert.ok(
        countTips(boosted) >= countTips(base),
        `評価を上げたのに増えていません（${countTips(base)} → ${countTips(boosted)}）`
    );
});
