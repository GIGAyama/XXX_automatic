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
 *   2. 1枠につき複数の案をまとめて書かせる
 *   3. 別の指示で立てた「編集者」に採点させて、枠ごとに1つ選ぶ
 *   4. ガードレール検査（lib/lint.mjs）に落ちたものだけ、指摘つきで書きなおさせる
 *   5. data/queue/<週ID>.json に書く
 *
 * まとめて投げているのは、無料枠のリクエスト数を節約するためと、
 * 1週間を通した重複（同じ言い回しが何度も出る）を AI 自身に避けさせるためである。
 *
 * なぜ複数案を書かせて選ぶのか:
 *   1回で書いたものをそのまま出すと、当たりさわりのない平均的な文章になる。
 *   書く人と選ぶ人を分けるのは、人がやっている編集作業と同じことである。
 *   選ぶ観点（最初の1行で止まるか、具体があるか、宣伝に見えないか）は
 *   config/audience.json に書いてある。
 *
 * ⚠️ 本文に URL を入れない。
 *   X は本文に外部リンクがある投稿のリーチを大きく下げる。
 *   リンクは「自分への最初の返信」に置く（config/guardrails.json の urlPlacement）。
 */
import { requireApiKey } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { VARIANTS_PER_SLOT, askForDrafts, assemble, loadProfiles, pickBest } from './lib/draft.mjs';
import { fail, failWith, info, loadConfig, loadPolicy, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { addDays, isoWeekId, jstDateString, jstStamp, nextWeekDates, weekDatesOf, weekDatesOfIsoWeek } from './lib/jst.mjs';
import { lintPost, pruneAlternatives } from './lib/lint.mjs';
import { planWeek } from './lib/plan-week.mjs';
import { hookOf, seedFrom } from './lib/x-text.mjs';
import { seasonBriefOf, weekdayNoteOf } from './lib/season.mjs';
import { mostSimilar } from './lib/similar.mjs';

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
    // 最初の1行の型ごとの手応え。生成のプロンプトに材料として渡す。
    const hookFeedback = feedbackFile.hooks ?? {};

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
        postFeedback: feedbackFile.posts ?? {},
        weekId,
    });
    const repriseSlot = plan.find((p) => p.reprise);
    info(`   ${plan.length} 枠を割り当てました`);
    if (repriseSlot) {
        info(
            `   うち1枠は再放送です（${repriseSlot.reprise.ofDate} の ${repriseSlot.repo} / ` +
                'そのとき選ばれなかった案を本文にします)'
        );
    }
    info(
        `   履歴 ${history.length} 件 / 反応の記録 ${Object.keys(feedback).length} 型` +
            (history.length === 0 ? '（履歴が空です。週をまたいだ重複回避はまだ効きません）' : '') +
            '\n'
    );

    // ── 2. 本文を作らせる ──────────────────────────────
    const profileByName = new Map(profiles.map((p) => [p.name, p]));
    const policy = loadPolicy();
    const { model, source } = await resolveGeminiModel(accounts);
    info(`   モデル: ${model}（${source}）`);

    // 「いまの時期」と「いまの話題」。どちらも無くても生成はできる。
    const audience = readJson(paths.config('audience.json'), null);
    const calendar = readJson(paths.config('calendar.json'), { periods: [] });
    const trends = readJson(paths.data('trends', `${weekId}.json`), null);
    const season = seasonBriefOf(dates, calendar);
    info(`   時期: ${season ? season.split('\n')[0].replace(/^- /, '') : '（行事暦なし）'}`);
    info(`   いまの話題: ${trends ? `${trends.topics.length} 件` : 'なし（行事暦だけで書きます）'}\n`);

    // 直近で使った書き出し。検査で弾くより、そもそも被らせないほうが早い。
    const recentHooks = recentHistory(history, dates[0], guardrails.similarityWithinDays ?? 60)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, 10)
        .map((p) => ({ date: p.date, line: hookOf(p.body) }));

    // weekdayNote を関数で渡す。lib/draft.mjs に行事暦の読み方まで持たせると、
    // 「日付を持たない枠（予備・注文）」のために毎回 calendar の有無を分岐することになる。
    const context = {
        audience,
        season,
        trends,
        hookFeedback,
        recentHooks,
        weekdayNote: (date) => weekdayNoteOf(date, calendar),
        lead: '1週間分をまとめて書きます。',
    };

    // 再放送の枠は生成しない。過去の落選案がそのまま本文になる。
    const genPlan = plan.filter((p) => !p.reprise);

    let drafts = await askForDrafts({
        model,
        policy,
        plan: genPlan,
        profileByName,
        monetization,
        guardrails,
        context,
        note: null,
        variants: VARIANTS_PER_SLOT,
    });

    // ── 2'. 編集者に選ばせる ────────────────────────────
    // 書く人と選ぶ人を分ける。1回で書いたものをそのまま出すと、
    // 当たりさわりのない平均的な文章になる。
    drafts = await pickBest({ model, drafts, plan: genPlan, profileByName, context, policy });

    // 再放送ぶんを、生成したものと同じ形にして混ぜる。
    // ここから先は「どこから来た本文か」を気にしなくてよくなる。
    drafts = [...drafts, ...repriseDrafts(plan)];

    // ── 3. 検査して、落ちたものだけ書きなおさせる ──────────────
    //
    // 指摘は2種類ある。
    //   lint    … ガードレール。直らなければ枠を空ける（危ないものを出すよりよい）
    //   similar … 先月と同じ言い回し。直らなくても出す（枠を空けるほどの問題ではない）
    // 書きなおしの指示には両方を渡すが、最後に落とすのは lint だけである。
    const pastPosts = recentHistory(history, dates[0], guardrails.similarityWithinDays ?? 60);

    let posts = assemble(plan, drafts, profileByName, accounts, guardrails);
    let lintIssues = collectLint(posts, guardrails, monetization);
    let simIssues = collectSimilar(posts, pastPosts, guardrails);

    for (let attempt = 1; attempt <= 2 && lintIssues.length + simIssues.length > 0; attempt += 1) {
        const issues = [...lintIssues, ...simIssues];
        info(`   ⚠ ${issues.length} 件の指摘があります。書きなおさせます（${attempt}/2）`);
        for (const { id, m } of issues) info(`     - ${id}: ${m}`);

        const badIds = new Set(issues.map((i) => i.id));
        // 再放送は書きなおせない（生成を通していないため）。
        // 直らなければ、ふつうの枠と同じように最後に除外される。
        const retryPlan = plan.filter((p) => badIds.has(p.id) && !p.reprise);
        const notes = issues.reduce((acc, { id, m }) => {
            acc[id] = [...(acc[id] ?? []), m];
            return acc;
        }, {});

        // 書きなおしは1案だけにする。ここで多案を作っても、直す指示が具体的なので差が出ない。
        const retried = await askForDrafts({
            model,
            policy,
            plan: retryPlan,
            profileByName,
            monetization,
            guardrails,
            context,
            note: notes,
            variants: 1,
        });

        drafts = [...drafts.filter((d) => !badIds.has(d.id)), ...retried];
        posts = assemble(plan, drafts, profileByName, accounts, guardrails);
        lintIssues = collectLint(posts, guardrails, monetization);
        simIssues = collectSimilar(posts, pastPosts, guardrails);
    }

    if (lintIssues.length > 0) {
        // 直しきれなかったものは投稿候補から外す。危ないものを出すより、その枠を空けるほうがよい。
        const badIds = new Set(lintIssues.map((i) => i.id));
        info(`   ✖ ${badIds.size} 枠は検査を通らなかったので除外します`);
        posts = posts.filter((p) => !badIds.has(p.id));
    }
    if (simIssues.length > 0) {
        // 似ているだけでは落とさない。同じアプリの話は書き方を変えても文字が似るので、
        // ここで落とすと正しい投稿まで消えて枠が空く。出したうえで、そう言う。
        info(`   ※ ${simIssues.length} 件は過去と似たままです（そのまま出します。ランチャーで直せます）`);
    }

    // ── 3'. 落選案も検査する ────────────────────────
    // ランチャーの［別の案］はワンタップで本文になる。
    // 本文と同じ基準を通っていないものを、押せる場所に置かない。
    const droppedAlts = posts.flatMap((post) =>
        pruneAlternatives(post, guardrails, monetization).map((d) => ({ id: post.id, ...d }))
    );
    if (droppedAlts.length > 0) {
        info(`   ⚠ 落選案 ${droppedAlts.length} 件が検査に落ちたので、差し替え候補から外しました`);
        for (const { id, problems } of droppedAlts) info(`     - ${id}: ${problems[0]}`);
    }

    // ── 4. 書き出す ────────────────────────────────
    if (args['dry-run']) {
        info('\n──── 生成結果（--dry-run なので保存しません）────\n');
        for (const post of posts) {
            info(`■ ${post.date}(${post.weekday}) ${post.slotLabel} / ${post.themeLabel} / ${post.repo}`);
            if (post.pickReason) info(`   編集者: ${post.pickReason}`);
            for (const step of post.steps) {
                info(`  ── ${step.label} [${step.weightedLength ?? '?'}/280]`);
                info(step.text.split('\n').map((l) => `    ${l}`).join('\n'));
            }
            info('');
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

    // ── 5. 予備の引き出しを作る ──────────────────────────
    // 予定に無い投稿を「いま出したい」ことがある。
    // ブラウザから Gemini を呼ぶには API キーを画面に置くことになり、それはできない
    // （CLAUDE.md §2）。だから、この場で作り置きしておく。
    const stock = await buildStock({
        model,
        policy,
        plan,
        profiles,
        profileByName,
        accounts,
        guardrails,
        monetization,
        context,
        weekId,
    });
    if (stock.length > 0) {
        const stockPath = paths.data('stock.json');
        writeJson(stockPath, { generatedAt: new Date().toISOString(), generatedAtJst: jstStamp(), weekId, posts: stock });
        info(`   予備の引き出し: ${rel(stockPath)} に ${stock.length} 件`);
    } else {
        // 0件のまま黙って進まない。ここが例外で落ちつづけていたあいだ、
        // ［出す］→［予備］は空のままで、誰も気づけなかった。
        console.error(
            '⚠ 予備の引き出しが0件です。ランチャーの［出す］→［予備］は空のままになります。\n' +
                '   （下書きが尽きた日に出すものが無くなります。上のログに理由が出ています）'
        );
    }

    info('   次は `npm run build` でランチャー用のデータを作ります');
}

/**
 * 再放送の枠を、生成した下書きと同じ形にする。
 *
 * 本文は「そのとき選ばれなかった案」を使う。同じ文章をもう一度出すのではなく、
 * 同じ題材を別の言い方で出しなおす、という形にするためである。
 * 生成を1回も呼ばないので、費用も待ち時間も増えない。
 */
function repriseDrafts(plan) {
    return plan
        .filter((p) => p.reprise)
        .map((p) => ({
            id: p.id,
            variant: 1,
            hook: p.reprise.hook,
            body: p.reprise.body,
            thread: p.reprise.thread ?? [],
            hashtags: p.reprise.hashtags ?? [],
            // 差し替え候補は置かない。もともと落選案そのものを出しているので、
            // さらに別の案を並べると、どれが本命か分からなくなる。
            alternatives: [],
            pickedBy: 'reprise',
            pickReason: `${p.reprise.ofDate} に出して反応がよかった題材です。そのとき選ばれなかった案を本文にしています`,
        }));
}

/** ガードレールの指摘を集める。 */
function collectLint(posts, guardrails, monetization) {
    return posts.flatMap((post) => lintPost(post, guardrails, monetization).map((m) => ({ id: post.id, m })));
}

/**
 * 過去の投稿と似すぎていないかを見る。
 *
 * 1週間ぶんはまとめて生成しているので、週のなかの重複は AI 自身が避ける。
 * 避けられないのは週をまたいだほうで、同じアプリ・同じ型が数週間おきに回ってくる。
 * 履歴に本文が残っていなかったころは、比べる相手すらいなかった。
 */
function collectSimilar(posts, pastPosts, guardrails) {
    const limit = guardrails.maxSimilarityToPast ?? 0.5;
    if (pastPosts.length === 0 || limit <= 0) return [];

    const out = [];
    for (const post of posts) {
        const { score, hit } = mostSimilar(post.body ?? post.text, pastPosts);
        if (score < limit || !hit) continue;
        out.push({
            id: post.id,
            m:
                `${hit.date} に出した投稿とよく似ています（${Math.round(score * 100)}%）。` +
                `切り口を変えてください。そのときの本文: 「${String(hit.body).split('\n')[0].slice(0, 40)}…」`,
        });
    }
    return out;
}

/** 比べる相手にする過去の投稿。本文を持っているものだけ。 */
function recentHistory(history, onDate, withinDays) {
    const from = addDays(onDate, -withinDays);
    return history.filter((p) => p.body && p.date >= from);
}

/** 予備の引き出しに入れる本数。 */
const STOCK_SIZE = 10;

/**
 * 予定に無いときのための投稿を作り置きする。
 *
 * なぜ作り置きなのか:
 *   「いま1本出したい」をその場で作るには、ブラウザから Gemini を呼ぶことになる。
 *   そのためには API キーを画面に持たせるしかなく、それは docs/ に秘密情報を
 *   置かないという決まり（CLAUDE.md §2）に反する。
 *   週に1回まとめて作っておけば、押した瞬間に出せて、費用も増えない。
 *
 * その週の予定に出ていないアプリから選ぶ。予定と同じものが並んでも引き出しにならない。
 */
async function buildStock({ model, policy, plan, profiles, profileByName, accounts, guardrails, monetization, context, weekId }) {
    const usedThisWeek = new Set(plan.map((p) => p.repo));
    const themes = context.themesConfig ?? null;
    void themes;

    const candidates = profiles.filter((p) => !usedThisWeek.has(p.name) && p.pagesUrl);
    if (candidates.length === 0) return [];

    // 週IDを種にして毎回同じ並びにする。作りなおしても引き出しの顔ぶれが変わらない。
    const picked = [...candidates]
        .sort((a, b) => (seedFrom(weekId + a.name) >>> 0) - (seedFrom(weekId + b.name) >>> 0))
        .slice(0, STOCK_SIZE);

    // 再放送の枠は型の狙い（themeIntent）を持たない（生成を通さないため）。
    // ここから型を借りると、指示が空のまま投げることになる。
    const themeSource = plan.filter((p) => !p.reprise);
    if (themeSource.length === 0) return [];

    const stockPlan = picked.map((profile, i) => {
        const theme = themeSource[i % themeSource.length];
        return {
            id: `stock-${weekId}-${i + 1}`,
            date: '',
            weekday: '',
            slot: 'stock',
            slotLabel: '予備',
            hour: 0,
            minute: 0,
            theme: theme.theme,
            themeLabel: theme.themeLabel,
            themeIntent: theme.themeIntent,
            themeStructure: theme.themeStructure,
            repo: profile.name,
        };
    });

    let drafts;
    try {
        drafts = await askForDrafts({
            model,
            policy,
            plan: stockPlan,
            profileByName,
            monetization,
            guardrails,
            context,
            note: null,
            variants: 1, // 引き出しは数が要る。1案ずつでよい
        });
    } catch (error) {
        // 引き出しが作れなくても、その週の投稿は出せる。ここで止めない。
        // ⚠️ split('\n')[0] にしないこと。Google のエラーは整形済み JSON で返るので、
        //    1行目だけ取ると「Gemini API 400: {」になって理由が消える。
        //    ここは try/catch で握りつぶす場所なので、消えると原因が永久に分からなくなる
        //    （実際、日付を持たない枠で throw していたことに長らく気づけなかった）。
        console.error(`⚠ 予備の引き出しを作れませんでした: ${String(error.message).replace(/\s+/g, ' ').trim()}`);
        return [];
    }

    const built = assemble(stockPlan, drafts, profileByName, accounts, guardrails);
    // 引き出しにも同じ検査をかける。押した瞬間に出すものなので、あとから直す機会がない。
    const passed = built.filter((post) => lintPost(post, guardrails, monetization).length === 0);
    if (passed.length < built.length) {
        info(`   予備: ${built.length - passed.length} 件が検査に落ちたので外しました`);
    }
    return passed;
}

main().catch(failWith);
