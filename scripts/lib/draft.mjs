/**
 * 「決まった題材で X の投稿文を書かせる」ところ。
 *
 * もとは scripts/generate-week.mjs のなかにあった。
 * 週次のほかに「いまこのアプリの投稿を作ってほしい」（scripts/generate-promo.mjs）が
 * 増えたので、ここに出してある。
 *
 * ⚠️ 書き方の約束を二重に持たない。
 *    本文の書き方（読者像・フックの型・URL を本文に入れない・具体を1つ入れる）は
 *    投稿の質そのものであり、しかも CLAUDE.md §3 とつながっている。
 *    週次と注文で別々のプロンプトを持つと、片方だけ直したときに
 *    「同じアカウントなのに、経路によって文体が違う」という気づきにくい壊れ方をする。
 *    lib/lint.mjs が検査の規則を1か所に寄せているのとまったく同じ理由である。
 */
import fs from 'node:fs';
import { generateJson } from './gemini.mjs';
import { info, paths, readJson } from './io.mjs';
import { composeSteps, hookOf, seedFrom } from './x-text.mjs';
import { pagesUrlFor } from './urls.mjs';

/** 1枠あたり何案書かせるか。多いほど良いものが混ざるが、無料枠のトークンを使う。 */
export const VARIANTS_PER_SLOT = 3;

export const DRAFT_SCHEMA = {
    type: 'object',
    properties: {
        posts: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '与えられた枠の id をそのまま返す' },
                    variant: { type: 'integer', description: '同じ枠の中での案の番号（1から）' },
                    hook: { type: 'string', description: '使ったフックの型の id（config/audience.json の hooks）' },
                    body: {
                        type: 'string',
                        description:
                            '投稿の本文。URL とハッシュタグは含めない（あとで機械が付ける）。日本語で100〜120字程度。最初の1行がタイムラインで最初に見える部分になる',
                    },
                    thread: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            '本文だけでは入り切らないときの、つづきの投稿。要らなければ空配列。1コマ100字程度、多くても2コマまで',
                    },
                    hashtags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'ハッシュタグ。#は付けない。2〜3個',
                    },
                },
                required: ['id', 'variant', 'hook', 'body', 'thread', 'hashtags'],
            },
        },
    },
    required: ['posts'],
};

/** 編集者が返す採点表。 */
export const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        picks: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '枠の id' },
                    variant: { type: 'integer', description: '選んだ案の番号' },
                    score: { type: 'integer', description: '選んだ案の総合点（0〜100）' },
                    reason: { type: 'string', description: 'なぜそれを選んだか。1文' },
                },
                required: ['id', 'variant', 'score', 'reason'],
            },
        },
    },
    required: ['picks'],
};

/** 読者像を、そのままプロンプトに入れられる形にする。 */
export function audienceBlock(audience) {
    if (!audience) return '';
    const p = audience.primary ?? {};
    return [
        '## 誰に向けて書くか',
        `読者: ${p.who ?? ''}`,
        `その人のいま: ${p.situation ?? ''}`,
        `求めているもの: ${(p.wants ?? []).join(' / ')}`,
        `読むのをやめる理由: ${(p.hates ?? []).join(' / ')}`,
        `使う言葉: ${p.vocabulary ?? ''}`,
        '',
        '「同じ学年を持っている、隣のクラスの先生ひとり」に話しかけるつもりで書いてください。',
        '大勢に向けた呼びかけにすると、誰の関心も引きません。',
    ].join('\n');
}

/**
 * フックの型を、選べる引き出しとして渡す。
 *
 * 反応の記録（data/feedback.json の hooks）が溜まっていれば、
 * どの型が実際に読まれたかも添える。
 * 重み付けにはしない。フックを選ぶのは生成側の仕事で、機械が指定すると
 * 「効いた型ばかりが並ぶ」ことになり、案どうしの切り口を変える指示と食い違う。
 * 材料として渡し、選ぶのは向こうに任せる。
 */
export function hookBlock(audience, hookFeedback = {}, recentHooks = []) {
    if (!audience?.hooks?.length) return '';

    const scored = Object.entries(hookFeedback)
        .map(([id, fb]) => ({ id, good: fb.good ?? 0, bad: fb.bad ?? 0 }))
        .filter((h) => h.good + h.bad > 0 && audience.hooks.some((x) => x.id === h.id));

    const lines = [
        '## 最初の1行（フック）の型',
        'タイムラインで最初に見えるのは1行目だけです。ここで止まらなければ本文は読まれません。',
        '次のどれかの型を選んで、その id を hook に書いてください。案ごとに違う型を使ってください。',
        ...audience.hooks.map((h) => `- ${h.id}: ${h.how}\n  例) ${h.example}`),
    ];

    if (scored.length > 0) {
        const worked = scored.filter((h) => h.good > h.bad).sort((a, b) => b.good - a.good);
        const missed = scored.filter((h) => h.bad > h.good).sort((a, b) => b.bad - a.bad);
        lines.push('', '### これまでの手応え（このアカウントの実績）');
        if (worked.length > 0) lines.push(`読まれた型: ${worked.map((h) => `${h.id}（${h.good}件）`).join(' / ')}`);
        if (missed.length > 0) lines.push(`手応えが無かった型: ${missed.map((h) => `${h.id}（${h.bad}件）`).join(' / ')}`);
        lines.push('参考にしてかまいませんが、同じ型ばかりにはしないでください。飽きられるほうが早く効きます。');
    }

    lines.push(
        '',
        '次の書き出しは使わないでください（どれも読み飛ばされます）:',
        ...(audience.avoid ?? []).map((a) => `- ${a}`)
    );

    if (recentHooks.length > 0) {
        // 検査で弾いて書きなおさせるより、はじめから避けさせるほうが早い。
        lines.push(
            '',
            '### 最近つかった書き出し（これらと似た1行目にしないでください）',
            ...recentHooks.map((h) => `- ${h.date}: ${h.line}`)
        );
    }

    return lines.join('\n');
}

/** いまの時期と話題。 */
export function nowBlock({ season, trends }) {
    const lines = [];
    if (season) {
        lines.push('## いまの学校', season, '');
        lines.push('この時期に現場が抱えている困りごとに寄せてください。時期の外れた話は読まれません。', '');
    }
    if (trends?.topics?.length) {
        lines.push('## いま話題になっていること');
        if (trends.summary) lines.push(trends.summary, '');
        for (const t of trends.topics) lines.push(`- ${t.title}: ${t.why}（切り口: ${t.angle}）`);
        lines.push(
            '',
            '⚠ これは題材を選ぶための材料です。ニュースの解説を書く場所ではありません。',
            '   話題そのものを主題にせず、「その話題で気になっている人が、自分の教室で使えること」を書いてください。',
            '   公的機関の見解であるかのような書き方はしないでください。'
        );
    }
    return lines.join('\n');
}

/** Gemini に本文を書かせる。variants を増やすと、1枠につき複数の案を書く。 */
export async function askForDrafts({
    model,
    policy,
    plan,
    profileByName,
    monetization,
    guardrails,
    context,
    note,
    variants = 1,
}) {
    if (plan.length === 0) return [];

    const placement = guardrails?.urlPlacement ?? 'reply';
    const hookMax = guardrails?.hookMaxChars ?? 42;

    const system = `あなたは日本の小学校教員です。自分が作った学習アプリについて X（旧Twitter）に投稿する文章を書きます。

${policy}

${audienceBlock(context.audience)}

${hookBlock(context.audience, context.hookFeedback, context.recentHooks)}

【この作業での約束】
- 本文だけを書いてください。ハッシュタグは本文に含めないでください（機械が後で付けます）。
${
    placement === 'reply'
        ? `- 本文に URL を絶対に入れないでください。X は本文に外部リンクがある投稿をほとんど表示しません。
  リンクは機械が「自分への最初の返信」として別に付けます。本文はリンク無しで完結させてください。
  「詳しくはリンクから」のような、リンクの存在を前提にした書き方もしないでください。`
        : '- URL は本文に含めないでください（機械が後で付けます）。'
}
- 本文は日本語で100〜120字程度。X の上限は日本語140字で、ハッシュタグの分を空けておく必要があります。
- 最初の1行は${hookMax}字以内にしてください。ここだけがタイムラインで最初に見えます。
- 具体を1つ必ず入れてください。「使いやすい」ではなく「配って説明するまで2分」のように、時間・回数・場面で書いてください。
- 与えられた「アプリのプロフィール」に書かれていることだけを根拠にしてください。書かれていない機能や効果を創作しないでください。
- 本文だけで言い切れないときだけ thread につづきを書いてください。要らなければ空配列にしてください。数を増やすためのぶつ切りは禁止です。
- 同じ言い回し・同じ書き出しを繰り返さないでください。
${monetization?.enabled ? '' : '- 収益化の導線（有料記事・アフィリエイト・支援のお願いなど）は一切書かないでください。'}`;

    const blocks = plan.map((slot) => {
        const profile = profileByName.get(slot.repo);
        const lines = [
            `### 枠 id: ${slot.id}`,
            slot.date ? `日付: ${slot.date}（${slot.weekday}曜）${slot.slotLabel}` : `枠: ${slot.slotLabel}（日付は決めずに作る）`,
            // 予備の引き出し（date が空）にはこの行を出さない。
            // 曜日の読まれ方は、出す日が決まっていてはじめて意味を持つ情報である。
            slot.date && context.weekdayNote ? `この曜日の読まれ方: ${context.weekdayNote(slot.date)}` : null,
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
            slot.angle ? `\n▼ この枠について、書き手からの注文:\n　${slot.angle}` : null,
            note?.[slot.id] ? `\n⚠ 前回の文章は次の理由で使えませんでした。直してください:\n　- ${note[slot.id].join('\n　- ')}` : null,
        ];
        return lines.filter((l) => l !== null).join('\n');
    });

    const prompt = [
        nowBlock(context),
        '',
        context.lead ?? '',
        variants > 1
            ? `次の ${plan.length} 件の枠それぞれについて、**${variants} 通りの案**を書いてください（合計 ${plan.length * variants} 件）。
案どうしは、切り口・フックの型・書き出しをはっきり変えてください。同じ話を言い換えただけの案は要りません。
variant には 1 から ${variants} までの番号を入れてください。`
            : `次の ${plan.length} 件の枠それぞれについて、投稿の本文を書いてください。variant は 1 にしてください。`,
        '',
        blocks.join('\n\n'),
    ].join('\n');

    const result = await generateJson({ model, system, prompt, schema: DRAFT_SCHEMA, temperature: 1.0 });
    return result.posts ?? [];
}

/**
 * 複数の案から、枠ごとに1つ選ぶ。
 *
 * 書いた本人に選ばせない。同じ指示で書いた文章を同じ指示で見ると、
 * 「指示に従っているか」しか見えなくなり、読まれるかどうかを見なくなる。
 * 読者側に立った別の指示で、はっきり点を付けさせる。
 *
 * 選べなかった枠は、案の1つ目をそのまま使う（ここで止めない）。
 */
export async function pickBest({ model, drafts, plan, profileByName, context, policy }) {
    const byId = new Map();
    for (const draft of drafts) {
        if (!byId.has(draft.id)) byId.set(draft.id, []);
        byId.get(draft.id).push(draft);
    }

    const multi = [...byId.values()].filter((list) => list.length > 1);
    if (multi.length === 0) {
        // 案が1つずつしか無い枠でも、形はそろえて返す（呼び出し側に分岐を持ち込まない）。
        return [...byId.values()].map((list) => ({ ...list[0], alternatives: [], pickedBy: 'first', pickReason: null }));
    }

    const system = [
        'あなたは、教員向けメディアの編集者です。',
        'X に出す投稿の案を読んで、どれがいちばん読まれるかを選びます。書いた本人ではありません。',
        '',
        audienceBlock(context.audience),
        '',
        '## 採点の観点（上から重い順）',
        '1. 最初の1行で、読者が自分の教室を思い浮かべて手を止めるか',
        '2. 具体があるか（時間・回数・場面・数字。「便利」「使いやすい」だけの案は落とす）',
        '3. 宣伝に見えないか（「作りました」から入る案、機能の羅列は落とす）',
        '4. その人がいま抱えている困りごとに当たっているか',
        '5. 教員としての品位（煽り、誇大、断定が無いか）',
        '',
        '⚠ 派手さでは選ばないでください。煽った案・大げさな案は、それだけで落としてください。',
        '   静かでも具体があって、読んだ人が明日そのまま真似できる案を上に置いてください。',
        '',
        '## 書き手が守っている方針（参考）',
        policy,
    ].join('\n');

    const blocks = multi.map((list) => {
        const slot = plan.find((p) => p.id === list[0].id);
        const profile = profileByName.get(slot?.repo);
        const cands = list
            .map(
                (d) =>
                    `- variant ${d.variant}（フック: ${d.hook ?? '?'}）\n  1行目: ${hookOf(d.body)}\n  本文: ${d.body}` +
                    (d.thread?.length ? `\n  つづき: ${d.thread.join(' / ')}` : '')
            )
            .join('\n');
        return [
            `### 枠 id: ${list[0].id}`,
            slot?.date ? `日付: ${slot.date}（${slot.weekday}曜）${slot.slotLabel} / 型: ${slot?.themeLabel}` : `型: ${slot?.themeLabel}`,
            `アプリ: ${slot?.repo} — ${profile?.oneLine ?? ''}`,
            '案:',
            cands,
        ].join('\n');
    });

    const prompt = [
        nowBlock(context),
        '',
        `次の ${multi.length} 件の枠それぞれについて、いちばん読まれる案を1つ選んでください。`,
        '選んだ理由は1文で書いてください。',
        '',
        blocks.join('\n\n'),
    ].join('\n');

    let picks = [];
    try {
        const result = await generateJson({ model, system, prompt, schema: JUDGE_SCHEMA, temperature: 0.2 });
        picks = result.picks ?? [];
    } catch (error) {
        // 選べなくても投稿は作れる。1案目を使って先へ進む。
        console.error(`⚠ 案の選抜に失敗しました。各枠の1案目を使います: ${String(error.message).split('\n')[0]}`);
    }

    const chosen = new Map(picks.map((p) => [p.id, p]));
    const out = [];
    let judged = 0;

    for (const [id, list] of byId) {
        const pick = chosen.get(id);
        const hit = pick ? list.find((d) => d.variant === pick.variant) : null;
        const winner = hit ?? list[0];
        if (hit) judged += 1;
        out.push({
            ...winner,
            // 落選案も残す。ランチャーから差し替えられるようにするため。
            alternatives: list.filter((d) => d !== winner).map((d) => ({ body: d.body, thread: d.thread ?? [], hook: d.hook })),
            pickedBy: hit ? 'editor' : 'first',
            pickReason: hit ? pick.reason : null,
            pickScore: hit ? pick.score : null,
        });
    }

    info(`   ${judged}/${multi.length} 枠を編集者が選びました（残りは1案目）`);
    return out;
}

/** 割り当てと本文を合体させて、投稿として完成した形にする。 */
export function assemble(plan, drafts, profileByName, accounts, guardrails) {
    const byId = new Map(drafts.map((d) => [d.id, d]));
    const placement = guardrails?.urlPlacement ?? 'reply';
    const maxThread = guardrails?.threadMaxSteps ?? 3;

    return plan
        .map((slot) => {
            const draft = byId.get(slot.id);
            if (!draft) return null;

            const profile = profileByName.get(slot.repo);
            const url = profile?.pagesUrl ?? pagesUrlFor(slot.repo, accounts);
            const hashtags = (draft.hashtags ?? []).slice(0, 3).map((t) => t.replace(/^#/, ''));
            const thread = (draft.thread ?? []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, maxThread);

            const steps = composeSteps({
                body: draft.body,
                thread,
                url,
                hashtags,
                placement,
                seed: seedFrom(slot.id),
            });

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
                hook: draft.hook ?? null,
                hashtags,
                url,
                steps,
                // これまで text は「投稿する文そのもの」だった。連投になっても、
                // 本文（1コマ目）を指すという意味は変わらない。
                // 通知やランチャーの古い版がここだけを見ていても壊れないように残す。
                text: steps[0].text,
                media: mediaPathFor(slot.repo),
                weightedLength: 0, // lint 側で埋める
                // 落選した案。ランチャーから差し替えられるようにする。
                alternatives: draft.alternatives ?? [],
                pickedBy: draft.pickedBy ?? null,
                pickReason: draft.pickReason ?? null,
                // 再放送なら、いつ出したものかを残す。
                // ランチャーで「これは出しなおしです」と分かるようにするため。
                reprise: slot.reprise ? { ofId: slot.reprise.ofId, ofDate: slot.reprise.ofDate } : null,
            };
        })
        .filter(Boolean);
}

/** カード画像がある場合だけパスを入れる。無ければ null（文字だけの投稿になる）。 */
export function mediaPathFor(repo) {
    const file = `${repo}-card.png`;
    return fs.existsSync(paths.media(file)) ? `media/${file}` : null;
}

/** data/profiles/*.json をぜんぶ読む。 */
export function loadProfiles() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(paths.data('profiles', f)));
}
