#!/usr/bin/env node
/**
 * ④ 生成 — 翌週1週間分の X 投稿文を作る。
 *
 *   node scripts/generate-week.mjs
 *   node scripts/generate-week.mjs --dry-run      … 書き出さず画面に出すだけ
 *   node scripts/generate-week.mjs --this-week    … 翌週ではなく今週分（初回の動作確認用）
 *   node scripts/generate-week.mjs --week 2026-W34
 *
 * 流れ:
 *   1. 「どの日にどのアプリをどの型で」を機械で割り当てる（lib/plan-week.mjs）
 *   2. 割り当てをまとめて1回の Gemini 呼び出しで本文にする
 *   3. ガードレール検査（lib/lint.mjs）に落ちたものだけ、指摘つきで書きなおさせる
 *   4. data/queue/<週ID>.json に書く
 *
 * まとめて1回で投げているのは、無料枠のリクエスト数を節約するためと、
 * 1週間を通した重複（同じ言い回しが何度も出る）を AI 自身に避けさせるためである。
 */
import fs from 'node:fs';
import { generateJson, requireApiKey } from './lib/gemini.mjs';
import { fail, failWith, info, loadConfig, loadPolicy, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, nextWeekDates, weekDatesOf } from './lib/jst.mjs';
import { lintPost } from './lib/lint.mjs';
import { planWeek } from './lib/plan-week.mjs';
import { composePost } from './lib/x-text.mjs';

const DRAFT_SCHEMA = {
    type: 'object',
    properties: {
        posts: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '与えられた枠の id をそのまま返す' },
                    body: {
                        type: 'string',
                        description:
                            '投稿の本文。URL とハッシュタグは含めない（あとで機械が付ける）。日本語で100〜120字程度',
                    },
                    hashtags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'ハッシュタグ。#は付けない。2〜3個',
                    },
                },
                required: ['id', 'body', 'hashtags'],
            },
        },
    },
    required: ['posts'],
};

async function main() {
    const args = parseArgs();
    const config = loadConfig();
    const { accounts, slots: slotConfig, themes, guardrails, monetization } = config;

    // 材料を読み込む前に確かめる。キーが無いのに割り当てまで進むと、
    // 本当の原因が「生成に失敗した」という別の顔で出てくる。
    requireApiKey();

    // ── 対象の週を決める ──────────────────────────────
    let dates;
    if (args.week) {
        // 週IDを指定されたら、その週の月曜からの7日分を作る
        const match = /^(\d{4})-W(\d{2})$/.exec(args.week);
        if (!match) fail("--week は 'YYYY-Www' 形式で渡してください（例: 2026-W34）");
        dates = weekDatesOfIsoWeek(Number(match[1]), Number(match[2]));
    } else if (args['this-week']) {
        dates = weekDatesOf(jstDateString());
    } else {
        dates = nextWeekDates();
    }
    const weekId = isoWeekId(dates[0]);

    // ── 材料を読む ────────────────────────────────
    const profiles = loadProfiles();
    if (profiles.length === 0) fail('data/profiles/ が空です。先に `npm run profiles` を実行してください。');

    // 履歴は archive-history.mjs が、反応は collect-feedback.mjs が書く。
    // どちらも無くても生成はできる（初回がそう）。無いことと壊れていることは区別する。
    const history = readJson(paths.data('history.json'), { posts: [] }).posts ?? [];
    const feedbackFile = readJson(paths.data('feedback.json'), { themes: {}, repos: {} });
    const feedback = feedbackFile.themes ?? {};
    const repoFeedback = feedbackFile.repos ?? {};

    info(`④ 生成を開始します（${jstStamp()}）`);
    info(`   対象週: ${weekId}（${dates[0]} 〜 ${dates[6]}）`);
    info(`   使えるアプリ: ${profiles.length} 件 / 1日 ${slotConfig.slots.length} 枠`);

    // ── 1. 割り当て ────────────────────────────────
    const plan = planWeek({
        dates,
        slots: slotConfig.slots,
        themesConfig: themes,
        profiles,
        history,
        feedback,
        repoFeedback,
        weekId,
    });
    info(`   ${plan.length} 枠を割り当てました`);
    info(
        `   履歴 ${history.length} 件 / 反応の記録 ${Object.keys(feedback).length} 型` +
            (history.length === 0 ? '（履歴が空です。週をまたいだ重複回避はまだ効きません）' : '') +
            '\n'
    );

    // ── 2. 本文を作らせる ──────────────────────────────
    const profileByName = new Map(profiles.map((p) => [p.name, p]));
    const policy = loadPolicy();

    let drafts = await askForDrafts({
        model: accounts.geminiModel,
        policy,
        plan,
        profileByName,
        monetization,
        note: null,
    });

    // ── 3. 検査して、落ちたものだけ書きなおさせる ──────────────
    let posts = assemble(plan, drafts, profileByName, accounts);
    let issues = posts.flatMap((post) => lintPost(post, guardrails, monetization).map((m) => ({ id: post.id, m })));

    for (let attempt = 1; attempt <= 2 && issues.length > 0; attempt += 1) {
        info(`   ⚠ ${issues.length} 件が検査に引っかかりました。書きなおさせます（${attempt}/2）`);
        for (const { id, m } of issues) info(`     - ${id}: ${m}`);

        const badIds = new Set(issues.map((i) => i.id));
        const retryPlan = plan.filter((p) => badIds.has(p.id));
        const notes = issues.reduce((acc, { id, m }) => {
            acc[id] = [...(acc[id] ?? []), m];
            return acc;
        }, {});

        const retried = await askForDrafts({
            model: accounts.geminiModel,
            policy,
            plan: retryPlan,
            profileByName,
            monetization,
            note: notes,
        });

        drafts = [...drafts.filter((d) => !badIds.has(d.id)), ...retried];
        posts = assemble(plan, drafts, profileByName, accounts);
        issues = posts.flatMap((post) => lintPost(post, guardrails, monetization).map((m) => ({ id: post.id, m })));
    }

    if (issues.length > 0) {
        // 直しきれなかったものは投稿候補から外す。危ないものを出すより、その枠を空けるほうがよい。
        const badIds = new Set(issues.map((i) => i.id));
        info(`   ✖ ${badIds.size} 枠は検査を通らなかったので除外します`);
        posts = posts.filter((p) => !badIds.has(p.id));
    }

    // ── 4. 書き出す ────────────────────────────────
    if (args['dry-run']) {
        info('\n──── 生成結果（--dry-run なので保存しません）────\n');
        for (const post of posts) {
            info(`■ ${post.date}(${post.weekday}) ${post.slotLabel} / ${post.themeLabel} / ${post.repo}`);
            info(post.text.split('\n').map((l) => `  ${l}`).join('\n'));
            info(`  [${post.weightedLength}/280]\n`);
        }
        return;
    }

    const outPath = paths.data('queue', `${weekId}.json`);
    writeJson(outPath, {
        weekId,
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        dates,
        posts,
    });

    info(`\n④ 完了 — ${rel(outPath)} に ${posts.length} 件`);
    info('   次は `npm run build:index` でランチャー用のデータを作ります');
}

/** Gemini に本文だけを書かせる。 */
async function askForDrafts({ model, policy, plan, profileByName, monetization, note }) {
    if (plan.length === 0) return [];

    const system = `あなたは日本の小学校教員です。自分が作った学習アプリについて X（旧Twitter）に投稿する文章を書きます。

${policy}

【この作業での約束】
- 本文だけを書いてください。URL とハッシュタグは本文に含めないでください（機械が後で付けます）。
- 本文は日本語で100〜120字程度。X の上限は日本語140字で、URL とハッシュタグの分を空けておく必要があります。
- 与えられた「アプリのプロフィール」に書かれていることだけを根拠にしてください。書かれていない機能や効果を創作しないでください。
- 1週間分をまとめて書きます。同じ言い回し・同じ書き出しを繰り返さないでください。
${monetization?.enabled ? '' : '- 収益化の導線（有料記事・アフィリエイト・支援のお願いなど）は一切書かないでください。'}`;

    const blocks = plan.map((slot) => {
        const profile = profileByName.get(slot.repo);
        const lines = [
            `### 枠 id: ${slot.id}`,
            `日付: ${slot.date}（${slot.weekday}曜）${slot.slotLabel}`,
            `投稿の型: ${slot.themeLabel}`,
            `この型の狙い: ${slot.themeIntent}`,
            `構成の目安: ${slot.themeStructure}`,
            '',
            `対象アプリ: ${slot.repo}`,
            `　一言: ${profile?.oneLine ?? ''}`,
            `　対象: ${profile?.targetGrade ?? ''} / ${profile?.subject ?? ''}`,
            `　引き受ける困りごと: ${(profile?.painPoints ?? []).join(' / ')}`,
            `　使い方: ${(profile?.howToUse ?? []).join(' → ')}`,
            `　こだわり: ${(profile?.strengths ?? []).join(' / ')}`,
            `　使う場面: ${(profile?.classroomScenes ?? []).join(' / ')}`,
            profile?.designDecisions?.length ? `　設計判断: ${profile.designDecisions.join(' / ')}` : null,
            `　ハッシュタグ候補: ${(profile?.keywords ?? []).join(', ')}`,
            note?.[slot.id] ? `\n⚠ 前回の文章は次の理由で使えませんでした。直してください:\n　- ${note[slot.id].join('\n　- ')}` : null,
        ];
        return lines.filter((l) => l !== null).join('\n');
    });

    const prompt = `次の ${plan.length} 件の枠それぞれについて、投稿の本文とハッシュタグを書いてください。\n\n${blocks.join('\n\n')}`;

    const result = await generateJson({ model, system, prompt, schema: DRAFT_SCHEMA, temperature: 1.0 });
    return result.posts ?? [];
}

/** 割り当てと本文を合体させて、投稿として完成した形にする。 */
function assemble(plan, drafts, profileByName, accounts) {
    const byId = new Map(drafts.map((d) => [d.id, d]));

    return plan
        .map((slot) => {
            const draft = byId.get(slot.id);
            if (!draft) return null;

            const profile = profileByName.get(slot.repo);
            const url = profile?.pagesUrl ?? `${accounts.pagesBase}${slot.repo}/`;
            const hashtags = (draft.hashtags ?? []).slice(0, 3).map((t) => t.replace(/^#/, ''));
            const text = composePost({ body: draft.body, url, hashtags });

            return {
                id: slot.id,
                date: slot.date,
                weekday: slot.weekday,
                slot: slot.slot,
                slotLabel: slot.slotLabel,
                hour: slot.hour,
                minute: slot.minute,
                theme: slot.theme,
                themeLabel: slot.themeLabel,
                repo: slot.repo,
                body: draft.body,
                hashtags,
                url,
                text,
                media: mediaPathFor(slot.repo),
                weightedLength: 0, // lint 側で埋める
            };
        })
        .filter(Boolean);
}

/** カード画像がある場合だけパスを入れる。無ければ null（文字だけの投稿になる）。 */
function mediaPathFor(repo) {
    const file = `${repo}-card.png`;
    return fs.existsSync(paths.media(file)) ? `media/${file}` : null;
}

function loadProfiles() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(paths.data('profiles', f)));
}

/** ISO 週番号から、その週の月曜〜日曜を出す。 */
function weekDatesOfIsoWeek(year, week) {
    // ISO 週の第1週は「1月4日を含む週」。ここを起点にすると年またぎでもずれない。
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Dow = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * 86_400_000);
    const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday.getTime() + i * 86_400_000);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    });
}

main().catch(failWith);
