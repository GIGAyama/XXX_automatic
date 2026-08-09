#!/usr/bin/env node
/**
 * 注文された宣伝ポストを作る。
 *
 *   node scripts/generate-promo.mjs                    … 開いている注文をぜんぶ
 *   node scripts/generate-promo.mjs --issue 123        … その Issue だけ
 *   node scripts/generate-promo.mjs --repo Qalc --count 3 --dry-run
 *                                                      … Issue を使わずに手元で試す
 *
 * ランチャーの［つくる］が、アプリ名・本数・型を載せた Issue を立てる。
 * このスクリプトがそれを読んで投稿を作り、docs/orders/<注文ID>.json に置く。
 * ランチャーはそのファイルを拾って端末に貯める（docs/lib/mine.js）。
 *
 * ── なぜこの経路なのか ──────────────────────────────
 *
 * 週次の生成は日曜の夜にしか動かない。ところが「このアプリの話を、いま出したい」は
 * 予定と関係なくやってくる。その場で作るにはブラウザから Gemini を呼ぶことになり、
 * それには API キーを画面に置くしかない（CLAUDE.md §2 で禁じている）。
 * 反応の記録と返信の下書きが、すでに同じ問題を Issue で解いている。ここも同じ道を通す。
 *
 * ── 結果を docs/ に置く理由 ────────────────────────
 *
 * 返信の下書きは Issue のコメントで終わってよかった（読んで自分の言葉に直すため）。
 * 宣伝ポストは共有シートに渡して投稿するものなので、ランチャーに戻らないと意味がない。
 * 同一オリジンのファイルに置けば、外を読む先を増やさずに往復が閉じる。
 *
 * ⚠️ GITHUB_TOKEN による push は他のワークフローを起動しない。
 *    docs/ を push しただけでは Pages に配信されないので、
 *    .github/workflows/deploy-pages.yml の workflow_run にこのワークフローの名前が要る。
 *    入れ忘れると「作ったのに永久に届かない」という、いちばん分かりにくい壊れ方をする。
 *    `npm run check` が両者のずれを検出する。
 *
 * ⚠️ 外から来る入力である。Issue は誰でも立てられる。
 *    投稿者を確かめ、注文の形（とくに注文ID＝ファイル名になる文字列）を照合してから使う。
 */
import fs from 'node:fs';
import {
    DONE_LABEL,
    ISSUE_LABEL,
    RESULT_SCHEMA_ID,
    buildOrder,
    extractOrder,
    newOrderId,
    resultPathOf,
    validateOrder,
} from '../docs/lib/order.js';
import { isAllowedAuthor } from './collect-feedback.mjs';
import { addIssueComment, listIssues, updateIssue } from './lib/github.mjs';
import { askForDrafts, assemble, loadProfiles, pickBest } from './lib/draft.mjs';
import { requireApiKey } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { failWith, info, loadConfig, loadPolicy, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, weekDatesOf, weekdayLabelOf } from './lib/jst.mjs';
import { galleryFor, reposByName, toLauncherPost } from './lib/launcher-post.mjs';
import { lintAlternative, lintPost, pruneAlternatives } from './lib/lint.mjs';
import { seasonBriefOf } from './lib/season.mjs';
import { hookOf, seedFrom } from './lib/x-text.mjs';

/**
 * 結果ファイルを何件まで残すか。
 *
 * 毎回コミットするので、放っておくとリポジトリが太る。
 * ランチャーは一度受け取ったら端末に写す（docs/lib/mine.js）ので、
 * 古い結果ファイルが消えても、すでに手元にある投稿は消えない。
 */
export const KEEP_RESULTS = 40;

/**
 * 「おまかせ」のときに使わない型。
 *
 * update … 最近更新されたアプリにしか書けない。該当しないのに書かせると、
 *          直していないものを「直しました」と書くことになる。
 * insight … アプリそのものを主題にしない型（config/themes.json の intent）。
 *          宣伝を頼まれている場に既定で混ぜるのは筋が違う。名指しで頼まれたときだけ使う。
 */
const NOT_IN_AUTO_POOL = new Set(['update', 'insight']);

/** 注文で作る投稿の枠。日付は「作った日」で、出す日ではない。 */
function planFor(order, themesConfig, profile, today) {
    const byId = new Map(themesConfig.themes.map((t) => [t.id, t]));

    let pool;
    if (order.themes.length > 0) {
        pool = order.themes.map((id) => byId.get(id)).filter(Boolean);
    } else {
        pool = themesConfig.themes.filter((t) => !NOT_IN_AUTO_POOL.has(t.id));
        // 最近更新されたアプリなら「アップデート報告」も書ける。事実がある場合だけ足す。
        if (isRecentlyPushed(profile, today, 21)) pool.push(byId.get('update'));
    }
    pool = pool.filter(Boolean);
    if (pool.length === 0) pool = themesConfig.themes.slice();

    // 注文IDを種にして始まりをずらす。同じアプリを2回頼んだときに、
    // まったく同じ型の並びが返ってくると「同じものが来た」と感じる。
    const offset = Math.abs(seedFrom(order.orderId)) % pool.length;
    // 注文IDの後半を投稿IDに混ぜる。同じ日に2回頼んでも ID がぶつからない。
    const tag = String(order.orderId).replace(/^ord-/, '').slice(-5);

    return Array.from({ length: order.count }, (_, i) => {
        const theme = pool[(offset + i) % pool.length];
        return {
            // ⚠️ 反応の記録（docs/lib/feedback-payload.js）が読める形にする。
            //    '<YYYY-MM-DD>-<英数字>' でないと、あとで「反応よかった」を送れない。
            id: `${today}-promo-${tag}${i + 1}`,
            date: today,
            weekday: weekdayLabelOf(today),
            slot: 'promo',
            slotLabel: 'つくった投稿',
            hour: 0,
            minute: 0,
            theme: theme.id,
            themeLabel: theme.label,
            themeIntent: theme.intent,
            themeStructure: theme.structure,
            repo: order.repo,
            // 「こういう切り口で」の一言。プロンプトの枠ごとの注文になる。
            angle: order.note || '',
        };
    });
}

function isRecentlyPushed(profile, onDate, withinDays) {
    if (!profile?.pushedAt) return false;
    const pushed = String(profile.pushedAt).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pushed)) return false;
    return Math.round((Date.parse(`${onDate}T00:00:00Z`) - Date.parse(`${pushed}T00:00:00Z`)) / 86_400_000) <= withinDays;
}

/**
 * 1件の注文を作る。
 *
 * @returns {Promise<{posts: object[], dropped: number, message: string}>}
 */
async function fulfill(order, { model, policy, config, context, profiles, today }) {
    const { accounts, themes, guardrails, monetization } = config;
    const profileByName = new Map(profiles.map((p) => [p.name, p]));
    const profile = profileByName.get(order.repo);

    const plan = planFor(order, themes, profile, today);
    // 本数が少ないほど、案を多く書かせて選ぶ余地を作る。
    // 6本頼まれて3案ずつ書かせると18件になり、1回の応答としては長すぎる。
    const variants = order.count <= 3 ? 3 : 2;

    let drafts = await askForDrafts({
        model,
        policy,
        plan,
        profileByName,
        monetization,
        guardrails,
        context,
        note: null,
        variants,
    });
    drafts = await pickBest({ model, drafts, plan, profileByName, context, policy });

    let posts = assemble(plan, drafts, profileByName, accounts, guardrails);
    let problems = collect(posts, guardrails, monetization);

    // 落ちたものだけ、指摘つきで書きなおさせる。週次とまったく同じ考え方。
    if (problems.length > 0) {
        info(`   ⚠ ${problems.length} 件の指摘があります。書きなおさせます`);
        for (const { id, m } of problems) info(`     - ${id}: ${m}`);

        const badIds = new Set(problems.map((p) => p.id));
        const notes = problems.reduce((acc, { id, m }) => {
            acc[id] = [...(acc[id] ?? []), m];
            return acc;
        }, {});
        const retried = await askForDrafts({
            model,
            policy,
            plan: plan.filter((p) => badIds.has(p.id)),
            profileByName,
            monetization,
            guardrails,
            context,
            note: notes,
            variants: 1,
        });
        drafts = [...drafts.filter((d) => !badIds.has(d.id)), ...retried];
        posts = assemble(plan, drafts, profileByName, accounts, guardrails);
        problems = collect(posts, guardrails, monetization);
    }

    const badIds = new Set(problems.map((p) => p.id));
    const passed = posts.filter((p) => !badIds.has(p.id));

    // 落選案も本文と同じ基準を通す。ランチャーの［別の案］はワンタップで本文になる。
    for (const post of passed) pruneAlternatives(post, guardrails, monetization);

    const maxLength = guardrails.maxWeightedLength ?? 280;
    const placement = guardrails.urlPlacement ?? 'reply';
    const altGate = (alt, post) => lintAlternative(alt, post, guardrails, monetization).length === 0;

    return {
        posts: passed.map((post) => toLauncherPost(post, '', maxLength, placement, altGate)),
        dropped: badIds.size,
        message:
            badIds.size === 0
                ? ''
                : `${badIds.size} 本はガードレール検査に落ちたので外しました（${problems[0]?.m ?? ''}）`,
    };
}

function collect(posts, guardrails, monetization) {
    return posts.flatMap((post) => lintPost(post, guardrails, monetization).map((m) => ({ id: post.id, m })));
}

/** 結果を docs/orders/<注文ID>.json に置く。ランチャーはここを見にくる。 */
function writeResult(order, { posts, dropped, message, model, issueNumber, owner }) {
    const outPath = paths.docs(resultPathOf(order.orderId));
    writeJson(outPath, {
        schema: RESULT_SCHEMA_ID,
        orderId: order.orderId,
        repo: order.repo,
        issue: issueNumber ?? null,
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        model,
        dropped,
        message,
        // 添付できる画像は結果と一緒に渡す。launcher.json の galleries には
        // その週に出てくるアプリぶんしか入っていないので、注文したアプリが載っているとは限らない。
        gallery: galleryFor(order.repo, owner, reposByName()),
        posts,
    });
    return outPath;
}

/**
 * 古い結果ファイルを消す。
 *
 * ⚠️ ファイルの更新時刻（mtime）で判定しない。git は mtime を保存しないので、
 *    actions/checkout のあとは全ファイルが「たったいま」になる（CLAUDE.md §6）。
 *    中身に書いてある generatedAt で並べる。
 */
export function pruneResults(dir, keep = KEEP_RESULTS) {
    if (!fs.existsSync(dir)) return [];
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((name) => {
            const json = readJson(`${dir}/${name}`, null);
            return { name, at: String(json?.generatedAt ?? '') };
        })
        .sort((a, b) => (a.at === b.at ? a.name.localeCompare(b.name) : a.at < b.at ? 1 : -1));

    const removed = files.slice(keep);
    for (const { name } of removed) fs.rmSync(`${dir}/${name}`);
    return removed.map((f) => f.name);
}

/** Issue に返すコメント。Pages への配信を待たずに中身を確かめられるようにする。 */
function renderComment({ posts, dropped, message, order, launcherUrl }) {
    const lines = [`### ${order.repo} の宣伝ポスト ${posts.length} 本`, ''];

    if (posts.length === 0) {
        lines.push(
            '作れませんでした。',
            '',
            `> ${message || '理由は書かれていません'}`,
            '',
            'ランチャーの［つくる］からもう一度頼んでください。切り口の一言を足すと通ることがあります。'
        );
    } else {
        lines.push(
            `ランチャーの［つくる］に届きます（配信まで1〜2分）。${launcherUrl ? `\n\n${launcherUrl}#make` : ''}`,
            ''
        );
        for (const post of posts) {
            lines.push(`#### ${post.themeLabel}`, '');
            for (const step of post.steps) {
                lines.push(`**${step.label}**（${step.weightedLength}/280）`, '', '```', step.text, '```', '');
            }
        }
        if (dropped > 0) lines.push('---', '', `⚠ ${message}`, '');
    }

    lines.push('---', '', `<sub>scripts/generate-promo.mjs — ${jstStamp()}</sub>`);
    return lines.join('\n');
}

async function main() {
    const args = parseArgs();
    const config = loadConfig();
    const { accounts, themes } = config;
    requireApiKey();

    const profiles = loadProfiles();
    if (profiles.length === 0) {
        throw new Error('data/profiles/ が空です。先に `npm run profiles` を実行してください。');
    }

    const policy = loadPolicy();
    const { model } = await resolveGeminiModel(accounts);
    const today = jstDateString();

    // 「いまの時期」と「いまの話題」。どちらも無くても作れる。
    // 題材が合っているかどうかで読まれ方が決まる（CLAUDE.md §4）ので、あるなら渡す。
    const audience = readJson(paths.config('audience.json'), null);
    const calendar = readJson(paths.config('calendar.json'), { periods: [] });
    const trends = readJson(paths.data('trends', `${isoWeekId(today)}.json`), null);
    const feedbackFile = readJson(paths.data('feedback.json'), {});
    const history = readJson(paths.data('history.json'), { posts: [] }).posts ?? [];

    const context = {
        audience,
        season: seasonBriefOf(weekDatesOf(today), calendar),
        trends,
        hookFeedback: feedbackFile.hooks ?? {},
        // 直近で使った書き出し。被らせないほうが、検査で弾いて書きなおさせるより早い。
        recentHooks: history
            .filter((p) => p.body)
            .sort((a, b) => (a.date < b.date ? 1 : -1))
            .slice(0, 10)
            .map((p) => ({ date: p.date, line: hookOf(p.body) })),
        lead: '同じアプリについて、切り口の違う投稿をまとめて書きます。どれか1本だけを出すこともあります。',
    };

    // ── 手元で試すとき（Issue を使わない）──────────────
    if (args.repo) {
        const order = buildOrder({
            orderId: newOrderId(),
            repo: String(args.repo),
            count: Number(args.count ?? 3),
            themes: args.theme ? [String(args.theme)] : [],
            note: String(args.note ?? ''),
            askedAtJst: jstStamp(),
        });
        const { ok, errors } = validateOrder(order, {
            repoNames: profiles.map((p) => p.name),
            themeIds: themes.themes.map((t) => t.id),
        });
        if (!ok) throw new Error(`注文の形が違います:\n  - ${errors.join('\n  - ')}`);

        info(`宣伝ポストを作ります（${order.repo} / ${order.count} 本 / モデル ${model}）`);
        const result = await fulfill(order, { model, policy, config, context, profiles, today });
        if (args['dry-run']) {
            info(renderComment({ ...result, order, launcherUrl: accounts.launcherUrl }));
            return;
        }
        const outPath = writeResult(order, { ...result, model, issueNumber: null, owner: accounts.githubOwner });
        info(`✓ ${rel(outPath)} に ${result.posts.length} 本`);
        return;
    }

    // ── Issue から拾う ────────────────────────────
    const owner = accounts.githubOwner;
    const repoName = accounts.repoName;

    const issues = args.issue
        ? (await listIssues(owner, repoName, { labels: [ISSUE_LABEL], state: 'all' })).filter(
              (i) => String(i.number) === String(args.issue)
          )
        : await listIssues(owner, repoName, { labels: [ISSUE_LABEL], state: 'open' });

    if (issues.length === 0) {
        info('宣伝ポストを頼まれている Issue はありませんでした');
        return;
    }

    info(`宣伝ポストの注文を ${issues.length} 件みます（モデル ${model}）`);

    const repoNames = new Set(profiles.map((p) => p.name));
    const themeIds = new Set(themes.themes.map((t) => t.id));
    let made = 0;

    for (const issue of issues) {
        const at = `#${issue.number}`;

        // ⚠️ 誰でも Issue は立てられる。確かめずに作ると、
        //    第三者がこのリポジトリの Gemini 無料枠を好きなだけ使えることになる。
        if (!isAllowedAuthor(issue.user?.login, accounts)) {
            info(`   ${at} は ${issue.user?.login ?? '不明'} さんが立てたものなので作りません`);
            continue;
        }

        const order = extractOrder(issue.body);
        const { ok, errors } = validateOrder(order, { repoNames, themeIds });
        if (!ok) {
            // 一部だけ直して進めない。開いたまま残し、何が違うかを書く。
            info(`   ${at} は注文の形が違うので見送ります`);
            await addIssueComment(
                owner,
                repoName,
                issue.number,
                ['注文を読み取れませんでした。', '', ...errors.map((e) => `- ${e}`), '', 'ランチャーの［つくる］からもう一度頼んでください。'].join('\n')
            ).catch(() => {});
            continue;
        }

        info(`   ${at} ${order.repo} を ${order.count} 本（型: ${order.themes.join(', ') || 'おまかせ'}）`);

        let result;
        try {
            result = await fulfill(order, { model, policy, config, context, profiles, today });
        } catch (error) {
            // ⚠️ ここで黙って次へ行かない。ランチャーは結果ファイルが来るまで待ちつづける。
            //    作れなかったことも「結果」として置く。置かないと画面が永久に「作成中」になる。
            //    split('\n')[0] にしないのは、Google のエラーが整形済み JSON で返るためである。
            const reason = String(error.message).replace(/\s+/g, ' ').trim();
            console.error(`⚠ ${at} の宣伝ポストを作れませんでした: ${reason}`);
            result = { posts: [], dropped: 0, message: reason.slice(0, 300) };
        }

        const outPath = writeResult(order, {
            ...result,
            model,
            issueNumber: issue.number,
            owner,
        });
        made += result.posts.length;
        info(`     → ${rel(outPath)} に ${result.posts.length} 本`);

        if (args['dry-run']) continue;

        await addIssueComment(
            owner,
            repoName,
            issue.number,
            renderComment({ ...result, order, launcherUrl: accounts.launcherUrl })
        ).catch((error) => console.error(`⚠ ${at} にコメントできませんでした: ${error.message}`));

        // 閉じてラベルを足す。開いたままだと、次に別の注文が来たときに二度作ってしまう。
        await updateIssue(owner, repoName, issue.number, {
            state: 'closed',
            labels: [ISSUE_LABEL, DONE_LABEL],
        }).catch((error) => console.error(`⚠ ${at} を閉じられませんでした: ${error.message}`));
    }

    const removed = pruneResults(paths.docs('orders'));
    if (removed.length > 0) {
        info(`   古い結果 ${removed.length} 件を消しました（残す上限 ${KEEP_RESULTS} 件）`);
    }

    info(`\n完了 — 投稿 ${made} 本を用意しました`);
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(failWith);
}
