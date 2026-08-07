/**
 * 1週間分の「どの日・どの枠で・どのアプリを・どの型で書くか」を決める。
 *
 * ここを AI にやらせない理由:
 *   同じアプリばかり出る、同じ型が続く、といった偏りは AI に任せると必ず起きる。
 *   何を書くかの選択は規則で決められるので、機械で決めてしまうほうが確実である。
 *   AI には「決まった題材で文章を書く」ことだけをさせる。
 *
 * 同じ週を作りなおしても同じ割り当てになるようにしてある（週IDを乱数の種にしている）。
 * 生成をやり直したときに構成がまるごと変わると、承認したはずの並びが崩れて混乱するためである。
 */
import { addDays, weekdayLabelOf } from './jst.mjs';

/** mulberry32。週IDから決まる乱数。外部依存を持たずに再現性を出すため。 */
function seededRandom(seedText) {
    let h = 1779033703 ^ seedText.length;
    for (let i = 0; i < seedText.length; i += 1) {
        h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pickWeighted(items, weightOf, random) {
    const total = items.reduce((sum, item) => sum + Math.max(0.0001, weightOf(item)), 0);
    let r = random() * total;
    for (const item of items) {
        r -= Math.max(0.0001, weightOf(item));
        if (r <= 0) return item;
    }
    return items[items.length - 1];
}

/** 日付の差（日数）。使いまわし間隔の判定に使う。 */
function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * @param {object} input
 * @param {string[]} input.dates          対象の7日分 'YYYY-MM-DD'
 * @param {object[]} input.slots          config/slots.json の slots
 * @param {object} input.themesConfig     config/themes.json
 * @param {object[]} input.profiles       data/profiles/*.json を読んだもの
 * @param {object[]} input.history        data/history.json の posts
 * @param {object} input.feedback         data/feedback.json の themes（型ごとの評価）
 * @param {object} input.repoFeedback     data/feedback.json の repos（アプリごとの評価）
 * @param {object} input.postFeedback     data/feedback.json の posts（投稿ごとの評価）
 * @param {string} input.weekId           'YYYY-Www'
 * @returns {object[]} 割り当て済みの投稿枠
 */
export function planWeek({
    dates,
    slots,
    themesConfig,
    profiles,
    history = [],
    feedback = {},
    repoFeedback = {},
    postFeedback = {},
    weekId,
}) {
    const random = seededRandom(weekId);
    const rotation = themesConfig.rotation ?? {};
    const noSameTheme = rotation.noSameThemeWithinDays ?? 2;
    const noSameRepo = rotation.noSameRepoWithinDays ?? 4;

    if (profiles.length === 0) {
        throw new Error('プロフィールが1件もありません。先に `npm run profiles` を実行してください。');
    }

    // 直近の使用履歴。過去の投稿と、いま組み立て中の週の両方を見る。
    const used = history.map((p) => ({ date: p.date, repo: p.repo, theme: p.theme }));

    const lastUsedRepo = (repo, onDate) => {
        const dates2 = used.filter((u) => u.repo === repo).map((u) => u.date);
        if (dates2.length === 0) return Infinity;
        return Math.min(...dates2.map((d) => Math.abs(daysBetween(d, onDate))));
    };
    const lastUsedTheme = (theme, onDate) => {
        const dates2 = used.filter((u) => u.theme === theme).map((u) => u.date);
        if (dates2.length === 0) return Infinity;
        return Math.min(...dates2.map((d) => Math.abs(daysBetween(d, onDate))));
    };

    // 「反応がよかった」が多い型を選ばれやすくする。
    // feedback は { themeId: { good: n, bad: n } } の形。
    const themeWeight = (theme) => {
        const fb = feedback[theme.id] ?? {};
        const good = fb.good ?? 0;
        const bad = fb.bad ?? 0;
        return Math.max(0.2, (theme.weight ?? 1) + good * 0.5 - bad * 0.3);
    };

    // アプリごとの反応も見る。ただし型より効きを弱くする。
    // アプリは52件あるので、1件の「よかった」で順番が大きく動くと、
    // 反応を1つ押しただけで同じアプリばかり出るようになってしまう。
    const repoBonus = (name) => {
        const fb = repoFeedback[name] ?? {};
        return (fb.good ?? 0) * 0.3 - (fb.bad ?? 0) * 0.2;
    };

    const plan = [];

    // ── 再放送する1本を先に決める ────────────────────
    // 反応がよかった投稿を、日を置いてもう一度出す。
    // 落選案（そのとき選ばれなかったほうの案）を本文にするので、同じ文章にはならない。
    // 先に決めるのは、そのアプリを週の他の枠で使わないようにするためである。
    const reprise = pickReprise({ history, postFeedback, dates, rotation, random });

    // その週にもう使ったアプリ。
    // noSameRepoWithinDays（既定4日）だけだと、月曜に出したアプリが金曜に戻ってこられる。
    // 1週間に同じアプリが2回出ると、それだけでネタが尽きたように見える。
    // 使えるアプリが足りているあいだは、週内での重複そのものを避ける。
    const usedThisWeek = new Set();
    if (reprise) usedThisWeek.add(reprise.repo);

    // 再放送を入れる枠。週の真ん中あたりに置く（月曜は新しいものから始めたい）。
    const repriseAt = reprise ? Math.floor(random() * dates.length * slots.length) : -1;
    let cursor = -1;

    for (const date of dates) {
        for (const slot of slots) {
            cursor += 1;

            if (cursor === repriseAt && reprise) {
                plan.push({
                    id: `${date}-${slot.id}`,
                    date,
                    weekday: weekdayLabelOf(date),
                    slot: slot.id,
                    slotLabel: slot.label,
                    hour: slot.hour,
                    minute: slot.minute ?? 0,
                    theme: reprise.theme,
                    themeLabel: themesConfig.themes.find((t) => t.id === reprise.theme)?.label ?? reprise.theme,
                    themeIntent: '',
                    themeStructure: '',
                    repo: reprise.repo,
                    // この枠は生成しない。過去の落選案をそのまま本文にする。
                    reprise,
                });
                used.push({ date, repo: reprise.repo, theme: reprise.theme });
                continue;
            }

            // ── 型を選ぶ ────────────────────────────────
            let themeCandidates = themesConfig.themes.filter((t) => lastUsedTheme(t.id, date) >= noSameTheme);
            if (themeCandidates.length === 0) themeCandidates = themesConfig.themes;

            let theme = pickWeighted(themeCandidates, themeWeight, random);

            // ── アプリを選ぶ ──────────────────────────────
            // 条件を段階的にゆるめる。厳しいほうから試して、候補が尽きたら次へ。
            // 「割り当てられませんでした」で枠を空けるより、条件を落としてでも埋めるほうがよい。
            let repoCandidates = profiles.filter(
                (p) => !usedThisWeek.has(p.name) && lastUsedRepo(p.name, date) >= noSameRepo
            );
            if (repoCandidates.length === 0) {
                repoCandidates = profiles.filter((p) => lastUsedRepo(p.name, date) >= noSameRepo);
            }
            if (repoCandidates.length === 0) repoCandidates = profiles.slice();

            // 「アップデート報告」は最近更新されたものにしか書けない。
            // 該当が無ければ型のほうを差し替える（無いものを報告させると事実でない文章になる）。
            if (theme.id === 'update') {
                const fresh = repoCandidates.filter((p) => isRecentlyUpdated(p, date, 21));
                if (fresh.length > 0) {
                    repoCandidates = fresh;
                } else {
                    const alt = themeCandidates.filter((t) => t.id !== 'update');
                    theme = alt.length > 0 ? pickWeighted(alt, themeWeight, random) : themesConfig.themes[0];
                }
            }

            // 公開URLがあるアプリを優先する。URLが無いと「見に行けない投稿」になる。
            const withPages = repoCandidates.filter((p) => p.pagesUrl);
            if (withPages.length > 0) repoCandidates = withPages;

            const repo = pickWeighted(
                repoCandidates,
                (p) => {
                    const postability = p.postability ?? 3;
                    // しばらく出していないアプリを少し優先する。全アプリに順番が回るようにするため。
                    const rest = Math.min(lastUsedRepo(p.name, date), 60);
                    return Math.max(0.2, postability + rest / 30 + repoBonus(p.name));
                },
                random
            );

            plan.push({
                id: `${date}-${slot.id}`,
                date,
                weekday: weekdayLabelOf(date),
                slot: slot.id,
                slotLabel: slot.label,
                hour: slot.hour,
                minute: slot.minute ?? 0,
                theme: theme.id,
                themeLabel: theme.label,
                themeIntent: theme.intent,
                themeStructure: theme.structure,
                repo: repo.name,
            });

            used.push({ date, repo: repo.name, theme: theme.id });
            usedThisWeek.add(repo.name);
        }
    }

    return plan;
}

/**
 * 再放送する1本を選ぶ。
 *
 * なぜ再放送するのか:
 *   タイムラインは流れる。1回出しただけでは、フォロワーの大半は見ていない。
 *   反応がよかったものをもう一度出すのは、いちばん確実に効く1本である。
 *   しかも材料はすでに手元にある——そのとき選ばれなかった案（alternatives）を
 *   本文にすれば、生成を1回も呼ばずに1枠が埋まる。
 *
 * 選ぶ条件:
 *   ・「反応よかった」が付いている（本人がそう判断したものだけ）
 *   ・repriseAfterDays（既定30日）以上前に出した
 *   ・落選案が残っている（同じ文章をそのまま出さないため）
 *
 * 該当が無ければ null。無い週は、いままでどおり全枠を生成する。
 */
export function pickReprise({ history, postFeedback, dates, rotation = {}, random = Math.random }) {
    const afterDays = rotation.repriseAfterDays ?? 30;
    if (afterDays <= 0) return null;

    const candidates = (history ?? []).filter((post) => {
        if (postFeedback?.[post.id]?.rating !== 'good') return false;
        if (!post.body || !post.repo) return false;
        // 同じ文章をそのまま出さない。別の案を持っているものだけを対象にする。
        if (!(post.alternatives ?? []).some((a) => a?.body)) return false;
        return daysBetween(post.date, dates[0]) >= afterDays;
    });

    if (candidates.length === 0) return null;

    // 古いものほど選ばれやすくする。同じ1本が毎週戻ってくるのを避けるため。
    const picked = pickWeighted(candidates, (p) => Math.min(daysBetween(p.date, dates[0]), 180), random);
    const alt = (picked.alternatives ?? []).find((a) => a?.body);

    return {
        ofId: picked.id,
        ofDate: picked.date,
        repo: picked.repo,
        theme: picked.theme,
        hook: picked.hook ?? null,
        body: alt.body,
        thread: alt.thread ?? [],
        hashtags: picked.hashtags ?? [],
    };
}

function isRecentlyUpdated(profile, onDate, withinDays) {
    if (!profile.pushedAt) return false;
    const pushed = profile.pushedAt.slice(0, 10);
    return daysBetween(pushed, onDate) <= withinDays;
}

export { addDays };
