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

/*
 * ここから下は、これまで一度も実際には動いていなかった経路のテストである。
 * history も feedback も読む側はあったが書く側が無く、入力はいつも空だった。
 * archive-history.mjs と collect-feedback.mjs が書くようになったので、
 * 「渡したときに本当に効くのか」を固定しておく。
 */

test('前の週に出したアプリが、間を空けずに翌週へ戻ってこない', () => {
    // 履歴が空のあいだ、rotation は週の中でしか効いていなかった。
    // 先週の日曜に出したアプリが今週の月曜にまた出る、という重複を誰も止めていなかった。
    const profiles = makeProfiles(30); // 候補が足りていれば規則は必ず守られるはず
    const previous = planWeek({ dates: weekDatesOf('2026-08-03'), slots, themesConfig, profiles, weekId: '2026-W32' });
    const history = previous.map((p) => ({ date: p.date, repo: p.repo, theme: p.theme }));

    const plan = planWeek({ dates, slots, themesConfig, profiles, history, weekId: '2026-W33' });

    const noSameRepo = themesConfig.rotation.noSameRepoWithinDays;
    for (const post of plan) {
        for (const used of history) {
            if (used.repo !== post.repo) continue;
            const gap = Math.abs(daysBetween(used.date, post.date));
            assert.ok(
                gap >= noSameRepo,
                `${post.repo} を ${used.date} に出したあと ${post.date}（${gap}日後）にまた出しています`
            );
        }
    }

    // 履歴を渡さなければ、この規則は週をまたいで効かない（＝いま直した部分が本当に効いている）
    const without = planWeek({ dates, slots, themesConfig, profiles, weekId: '2026-W33' });
    assert.notDeepEqual(plan.map((p) => p.repo), without.map((p) => p.repo));
});

function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

test('前の週に使った型も、週をまたいで連続しない', () => {
    const profiles = makeProfiles(20);
    // 8/9（日）の夜に intro を使った、という履歴
    const history = [{ date: '2026-08-09', repo: 'App1', theme: 'intro' }];
    const plan = planWeek({ dates, slots, themesConfig, profiles, history, weekId: '2026-W33' });
    // noSameThemeWithinDays = 2 なので 8/10 には intro が来ない
    assert.ok(plan.filter((p) => p.date === '2026-08-10').every((p) => p.theme !== 'intro'));
});

test('履歴を渡しても14枠は必ず埋まる', () => {
    // 条件を厳しくしすぎて枠が空くと、その日は投稿が無いことになる。
    const profiles = makeProfiles(6);
    const history = profiles.map((p, i) => ({ date: '2026-08-09', repo: p.name, theme: themesConfig.themes[i % 7].id }));
    const plan = planWeek({ dates, slots, themesConfig, profiles, history, weekId: '2026-W33' });
    assert.equal(plan.length, 14);
    assert.ok(plan.every((p) => p.repo && p.theme));
});

test('「反応よかった」が多いアプリは選ばれやすくなる', () => {
    const profiles = makeProfiles(40);
    const boosted = planWeek({
        dates,
        slots,
        themesConfig,
        profiles,
        repoFeedback: Object.fromEntries(
            ['App1', 'App2', 'App3'].map((name) => [name, { good: 30, bad: 0 }])
        ),
        weekId: '2026-W33',
    });
    const base = planWeek({ dates, slots, themesConfig, profiles, weekId: '2026-W33' });

    const favored = (plan) => plan.filter((p) => ['App1', 'App2', 'App3'].includes(p.repo)).length;
    assert.ok(favored(boosted) >= favored(base), `評価を上げたのに増えていません（${favored(base)} → ${favored(boosted)}）`);
});

test('アプリの評価は型の評価より効きが弱い', () => {
    // アプリは52件ある。1件の「よかった」で順番が大きく動くと、
    // 反応を1つ押しただけで同じアプリばかり出るようになってしまう。
    const profiles = makeProfiles(40);
    const plan = planWeek({
        dates,
        slots,
        themesConfig,
        profiles,
        repoFeedback: { App1: { good: 5, bad: 0 } },
        weekId: '2026-W33',
    });
    assert.equal(plan.filter((p) => p.repo === 'App1').length <= 1, true);
});

test('「いまいち」が積み重なっても、重みが0や負にならない', () => {
    // 負の重みが混ざると pickWeighted の合計がおかしくなり、選択そのものが壊れる。
    const profiles = makeProfiles(10);
    const plan = planWeek({
        dates,
        slots,
        themesConfig,
        profiles,
        feedback: Object.fromEntries(themesConfig.themes.map((t) => [t.id, { good: 0, bad: 100 }])),
        repoFeedback: Object.fromEntries(profiles.map((p) => [p.name, { good: 0, bad: 100 }])),
        weekId: '2026-W33',
    });
    assert.equal(plan.length, 14);
    assert.ok(plan.every((p) => p.repo && p.theme));
});
