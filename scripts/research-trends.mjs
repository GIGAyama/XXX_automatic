#!/usr/bin/env node
/**
 * ①' いま何が話題かを調べる。
 *
 *   node scripts/research-trends.mjs [--week YYYY-Www] [--dry-run]
 *
 * Gemini に Google 検索をさせて、「この時期、教育の現場で何が話題になっているか」を
 * 数件にまとめて data/trends/<週ID>.json に置く。生成のときに材料として渡す。
 *
 * なぜ要るのか:
 *   投稿の良し悪しは、文章の巧さより「いま困っていることか」でほとんど決まる。
 *   学校の年間行事（config/calendar.json）は毎年同じなので機械で持てるが、
 *   その年その週にだけ起きていること（制度の変更、報道、現場で回っている話題）は持てない。
 *   そこだけを検索で補う。
 *
 * ⚠️ ここが失敗しても止まらない。
 *    話題が拾えなくても、行事暦と各アプリのプロフィールだけで投稿は作れる。
 *    週の投稿が作れなくなるほうが損失が大きい。ただし黙らず、何が起きたかは必ず出す。
 *
 * ⚠️ 拾ってきたものをそのまま投稿の主題にしない。
 *    このアカウントは「教室で実際に見ている人間」として書いている。
 *    ニュースの解説を書く場所ではないし、公的機関の見解のような書き方も禁じてある
 *    （CLAUDE.md §3）。話題は「どのアプリの、どの困りごとを取り上げるか」を
 *    選ぶための材料であって、書く内容そのものではない。
 */
import fs from 'node:fs';
import { generateJson, requireApiKey, supportsSearch } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { failWith, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { isoWeekId, jstStamp, nextWeekDates, weekDatesOfIsoWeek } from './lib/jst.mjs';
import { seasonBriefOf } from './lib/season.mjs';

const TRENDS_SCHEMA = {
    type: 'object',
    properties: {
        topics: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: '話題を一言で' },
                    why: { type: 'string', description: 'いまの時期に、現場の先生にとってなぜ関係があるか' },
                    angle: { type: 'string', description: 'この話題に寄せるなら、どの困りごとを取り上げるとよいか' },
                    keywords: { type: 'array', items: { type: 'string' } },
                },
                required: ['title', 'why', 'angle', 'keywords'],
            },
        },
        summary: { type: 'string', description: 'この時期の現場の空気を2〜3文で' },
    },
    required: ['topics', 'summary'],
};

const SYSTEM = [
    'あなたは日本の小学校の現場をよく知る編集者です。',
    'いま日本の小学校の先生たちのあいだで実際に話題になっていること、関心が高まっていることを調べてまとめます。',
    '',
    '守ること:',
    '- 検索して分かった事実だけを書く。推測で埋めない。',
    '- 政治的な対立や、特定の自治体・学校・個人の批判は取り上げない。',
    '- 商品やサービスの宣伝は取り上げない。',
    '- 「〜すべきだ」という主張ではなく、「こういうことが起きている / 話題になっている」という事実を書く。',
    '- 学習効果についての断定的な言説は、話題として紹介する場合でも断定の形で書かない。',
].join('\n');

function buildPrompt({ dates, season, apps }) {
    return [
        `いまは ${dates[0]} 〜 ${dates[6]} の週です。日本の小学校の話です。`,
        '',
        '## 学校のこの時期',
        season || '（行事暦の情報はありません）',
        '',
        '## こちらが持っている題材（学習アプリ）',
        apps.join('、'),
        '',
        '## 調べてほしいこと',
        'この時期、日本の小学校の先生たちのあいだで実際に話題になっていること・関心が高まっていることを、',
        '検索して3〜5件にまとめてください。',
        '',
        '次のようなものが役に立ちます:',
        '- GIGA スクール構想・1人1台端末の運用でいま起きていること（更新、持ち帰り、制限など）',
        '- 学習指導要領や評価まわりで、この時期に現場が動くこと',
        '- 教員の働き方・校務の負担について話題になっていること',
        '- 教育での生成 AI の扱いについて、いま議論されていること',
        '',
        '各件について、上の題材のうちどれかに結びつけられる切り口（angle）も書いてください。',
        '結びつかない話題は入れなくてかまいません。数より、実際に関係があることを優先してください。',
    ].join('\n');
}

async function main() {
    const args = parseArgs();
    requireApiKey();

    const { accounts, calendar } = loadConfigWithCalendar();

    let dates;
    if (args.week) {
        const m = /^(\d{4})-W(\d{2})$/.exec(args.week);
        if (!m) throw new Error("--week は 'YYYY-Www' 形式で渡してください");
        dates = weekDatesOfIsoWeek(Number(m[1]), Number(m[2]));
    } else {
        dates = nextWeekDates();
    }
    const weekId = isoWeekId(dates[0]);

    const { model } = await resolveGeminiModel(accounts);
    info(`①' いまの話題を調べます（${jstStamp()} / 対象週 ${weekId} / モデル ${model}）`);

    if (!supportsSearch(model)) {
        // 検索と構造化出力の併用は Gemini 3 系から。2系のときは黙って諦める（止めない）。
        info(`   ${model} は検索しながらの構造化出力に対応していないので、今回は調べません`);
        info('   （行事暦だけで生成します。config/accounts.json の geminiModelPrefer は変えなくて大丈夫です）');
        return;
    }

    const profiles = loadProfileNames();
    const season = seasonBriefOf(dates, calendar);

    let result;
    try {
        result = await generateJson({
            model,
            system: SYSTEM,
            prompt: buildPrompt({ dates, season, apps: profiles.slice(0, 30) }),
            schema: TRENDS_SCHEMA,
            temperature: 0.3, // 事実を集める工程なので振らさない
            search: true,
        });
    } catch (error) {
        // 話題が拾えなくても投稿は作れる。ここで週次を止めない。
        console.error(
            `⚠ いまの話題を調べられませんでした。行事暦だけで生成します。\n` +
                `   理由: ${String(error.message).split('\n')[0]}`
        );
        return;
    }

    const topics = (result.topics ?? []).slice(0, 5);
    info(`   ${topics.length} 件の話題を拾いました`);
    for (const t of topics) info(`     - ${t.title}`);

    if (args['dry-run']) {
        info('\n--dry-run なので保存しません。');
        info(JSON.stringify(result, null, 2));
        return;
    }

    const outPath = paths.data('trends', `${weekId}.json`);
    writeJson(outPath, {
        weekId,
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        model,
        summary: result.summary ?? '',
        topics,
    });
    info(`   ${rel(outPath)} に保存しました`);
}

function loadConfigWithCalendar() {
    const { accounts } = loadConfig();
    return { accounts, calendar: readJson(paths.config('calendar.json'), { periods: [] }) };
}

function loadProfileNames() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
}

main().catch(failWith);
