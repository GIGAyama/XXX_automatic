#!/usr/bin/env node
/**
 * ③' 記事に入れる画面を撮る。
 *
 *   node scripts/capture-shots.mjs --repo Typa
 *   node scripts/capture-shots.mjs                … その週の note の主題アプリ
 *   node scripts/capture-shots.mjs --repo Typa --force
 *   node scripts/capture-shots.mjs --repo Typa --url http://127.0.0.1:8000/
 *
 * --url は、公開する前のアプリを手元で確かめるときに使う。
 *
 * 紹介カード（capture-media.mjs）とは別のものを作る。
 * カードは X の投稿に添える1枚で、アプリの顔として作ってある。
 * こちらは記事の本文に差しこむ「操作している最中の画面」で、1本の記事に15〜25点入る。
 *
 * ── どうやって撮るか ────────────────────────────
 *
 * 撮影用のシナリオがあれば、それを使う。
 *
 *   config/shots/<repo>.mjs
 *
 * 無ければ、画面のボタンを順に押しながら自動で撮る。
 * 52 件ぶんのシナリオを手で書くのは続かないので、既定は自動にしてある。
 * 自動でも「ホーム、押したあとの画面、戻ったところ」くらいは撮れる。
 * ここぞというアプリだけシナリオを置けば、そちらが優先される。
 *
 * ⚠️ 加工も合成もしない。実際に操作して撮ったものだけを使う。
 *    そうでないと、記事を読んで来た先生が見る画面と食い違う。
 *
 * ⚠️ 撮れた画面には「何を押したか」「画面に何が見えていたか」を添えて manifest.json に残す。
 *    記事を書かせるときにそれを渡すと、どの画面をどこに置くかを自分で選べる。
 *    ファイル名だけ渡しても、中身が分からないので選びようがない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertJapaneseFont, dismissEntryScreen, launchChromium, settle } from './lib/browser.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, nextWeekDates } from './lib/jst.mjs';
import { shotsDir } from './lib/note-shots.mjs';
import { inspectCard, readHeader } from './lib/png.mjs';

/** スマートフォンで見たときの形。note の読者はほとんどスマホで読む。 */
const VIEWPORT = { width: 390, height: 844 };

/** 1本の記事に入れる上限。実例は21点だった。 */
const MAX_SHOTS = 22;

/** 押してはいけないボタン。押すと戻ってこられない、または画面が壊れる。 */
const AVOID = [
    /ログイン|サインイン|ログアウト/,
    /削除|消去|リセット|初期化|クリア/,
    /購入|課金|支払/,
    /共有|シェア|ダウンロード|印刷|保存/,
    /設定を?保存|送信/,
];

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();

    const repo = args.repo ?? mainRepoOfWeek(args.week);
    if (!repo) {
        fail(
            '撮る対象が決まりません。\n' +
                '  --repo <アプリ名> を渡すか、先に `npm run generate` でその週の下書きを作ってください。'
        );
    }

    const profile = readJson(paths.data('profiles', `${repo}.json`), null);
    if (!profile) fail(`data/profiles/${repo}.json がありません。先に \`npm run profiles\` を実行してください。`);

    // --url は、公開する前のアプリを手元で確かめるときのためのもの。
    const url = typeof args.url === 'string' ? args.url : (profile.pagesUrl ?? `${accounts.pagesBase}${repo}/`);
    if (!profile.pagesUrl && typeof args.url !== 'string') {
        fail(`${repo} は GitHub Pages を持っていないので、画面を撮れません（記事は文字だけになります）。`);
    }

    const dir = shotsDir(repo);
    const scenarioPath = paths.config(path.join('shots', `${repo}.mjs`));
    const scenario = fs.existsSync(scenarioPath) ? await import(`file://${scenarioPath}`) : null;

    info(`③' 記事に入れる画面を撮ります（${jstStamp()}）`);
    info(`   対象: ${repo}（${url}）`);
    info(`   撮り方: ${scenario ? `シナリオ ${rel(scenarioPath)}` : '自動（ボタンを順に押します）'}`);

    if (!args.force && fs.existsSync(`${dir}/manifest.json`)) {
        const previous = readJson(`${dir}/manifest.json`, null);
        if (previous?.sourceSha && previous.sourceSha === profile.sourceSha) {
            info(`   アプリが更新されていないので、前に撮ったもの（${(previous.shots ?? []).length} 点）をそのまま使います`);
            info('   撮りなおすときは --force を付けてください');
            return;
        }
    }

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const browser = await launchChromium();
    let shots = [];

    try {
        await assertJapaneseFont(browser);
        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: 2, // note に上げると縮まる。等倍だと文字が潰れる
            locale: 'ja-JP',
            timezoneId: 'Asia/Tokyo',
            colorScheme: 'light',
            // プロキシが自前の証明書で中継していることがある（lib/browser.mjs と同じ理由）。
            ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        const shooter = makeShooter(page, dir);
        shots = scenario
            ? await runScenario(scenario, page, shooter)
            : await explore(page, shooter);

        await context.close();
    } catch (error) {
        // 撮れなくても記事は書ける（文字だけになる）。ここで週次を止めない。
        console.error(`⚠ 画面を撮れませんでした: ${String(error.message).replace(/\s+/g, ' ').trim()}`);
    } finally {
        await browser.close();
    }

    // ほぼ単色の画面（描画前を撮ったもの）は外す。
    // MANUAL に既知の症状として書いてあるのに、確かめる手段が無かった。
    const kept = shots.filter((shot) => {
        const file = `${dir}/${shot.file}`;
        if (!fs.existsSync(file)) return false;
        const buffer = fs.readFileSync(file);
        const header = readHeader(buffer);
        if (!header) return false;
        if (!inspectCard(buffer, { expect: { width: header.width, height: header.height } }).blank) return true;
        fs.rmSync(file);
        return false;
    });

    if (kept.length < shots.length) {
        info(`   ${shots.length - kept.length} 点はほぼ単色だったので外しました（描画の途中を撮っています）`);
    }

    writeJson(`${dir}/manifest.json`, {
        version: 1,
        repo,
        url,
        sourceSha: profile.sourceSha ?? null,
        capturedAtJst: jstStamp(),
        by: scenario ? 'scenario' : 'auto',
        shots: kept,
    });

    info(`\n③' 完了 — ${rel(dir)} に ${kept.length} 点`);
    if (kept.length === 0) {
        console.error('⚠ 1点も撮れていません。記事は文字だけになります。');
    } else if (kept.length < 8 && !scenario) {
        info(`   ※ ${kept.length} 点しか撮れていません。押せるボタンが少ないアプリのようです。`);
        info(`   　 ${rel(scenarioPath)} に撮影の手順を置くと、狙った画面を撮れます`);
    }
}

/* ────────────────────────────────────────────
 *  撮る
 * ──────────────────────────────────────────── */

function makeShooter(page, dir) {
    let n = 0;
    return async function shoot(label, what) {
        if (n >= MAX_SHOTS) return null;
        const { buffer } = await settle(page, { maxTries: 6, intervalMs: 300, minWaitMs: 500 });
        n += 1;
        const file = `${String(n).padStart(2, '0')}-${slug(label)}.png`;
        fs.writeFileSync(`${dir}/${file}`, buffer);

        // 画面に見えていた文字を控える。記事を書かせるときに
        // 「どの画面か」を判断する手がかりになる。
        const seen = await page
            .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200))
            .catch(() => '');

        info(`   ✓ ${file}${what ? ` — ${what}` : ''}`);
        return { file, label, what: what ?? '', seen };
    };
}

/**
 * 撮影のシナリオを実行する。
 *
 * シナリオは Playwright の page をそのまま受け取る。
 * 撮りたいところで shot() を呼ぶ。
 *
 *   export default async ({ page, shot }) => {
 *     await page.getByRole('button', { name: 'スコアアタック' }).click();
 *     await shot('score-attack', 'スコアアタックを選んだところ');
 *   };
 */
async function runScenario(scenario, page, shoot) {
    const shots = [];
    const shot = async (label, what) => {
        const result = await shoot(label, what);
        if (result) shots.push(result);
        return result;
    };
    await scenario.default({ page, shot, info });
    return shots;
}

/**
 * 自動で探索して撮る。
 *
 * ボタンを順に押して、押すたびに撮る。押したら最初の画面に戻って次のボタンへ行く。
 * 戻らないと、押した先の画面のボタンを押しつづけて深いところへ迷いこみ、
 * どのアプリも同じような絵ばかりになる。
 */
async function explore(page, shoot) {
    const shots = [];
    const push = async (label, what) => {
        const result = await shoot(label, what);
        if (result) shots.push(result);
        return result;
    };

    await push('home', 'ひらいた直後の画面');

    // タイトル画面があるアプリは、抜けないと中身が撮れない。
    const entry = await dismissEntryScreen(page);
    if (entry.clicked) await push('start', `「${entry.label}」を押したあと`);

    const labels = await clickableLabels(page);
    info(`   押せるボタン: ${labels.length} 個`);

    const url = page.url();
    for (const label of labels) {
        if (shots.length >= MAX_SHOTS) break;
        if (AVOID.some((re) => re.test(label))) continue;

        try {
            const button = page.getByRole('button', { name: label, exact: true }).first();
            if (!(await button.isVisible({ timeout: 300 }))) continue;
            await button.click({ timeout: 1500 });
            await push(label, `「${label}」を押したところ`);
        } catch {
            // 押せない・消えたボタンは飛ばす。想定内なので黙って次へ。
            continue;
        }

        // 最初の画面に戻る。
        //
        // ⚠️ goBack は使わない。学習アプリの多くは1枚の HTML のなかで画面を切りかえていて、
        //    押しても URL が変わらない。そこで goBack を呼ぶと、アプリの前の画面ではなく
        //    「そのページを開く前」に戻ってしまう。以降のボタンはどれも見つからなくなり、
        //    3個あるボタンのうち1個しか撮れない（実際にそうなった）。
        //    URL が変わっていなければ読みこみ直すのが正しい。
        try {
            if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
            else await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        } catch {
            break; // 戻れなくなったら、そこで終わりにする
        }
    }

    // 下のほうにある画面（設定や説明）も1枚撮る。
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await push('bottom', 'ページのいちばん下');
    } catch {
        // 撮れなくても困らない
    }

    return shots;
}

/** いま押せるボタンの文字。 */
async function clickableLabels(page) {
    try {
        const names = await page
            .getByRole('button')
            .evaluateAll((nodes) =>
                nodes
                    .filter((n) => n.offsetParent !== null)
                    .map((n) => (n.innerText || n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
            );
        // ふりがな付きのボタンは innerText に読みが混ざる。空と重複だけ落とす。
        return [...new Set(names.filter((n) => n && n.length <= 20))];
    } catch {
        return [];
    }
}

/* ────────────────────────────────────────────
 *  小道具
 * ──────────────────────────────────────────── */

/** その週の note が主題にするアプリ。generate-note.mjs と同じ決め方をする。 */
function mainRepoOfWeek(week) {
    const weekId = week ?? isoWeekId(nextWeekDates()[0]);
    const queue =
        readJson(paths.data('queue', `${weekId}.json`), null) ??
        readJson(paths.data('queue', `${isoWeekId(jstDateString())}.json`), null);
    return queue?.posts?.[0]?.repo ?? null;
}

/** ファイル名に使える形にする。日本語のボタン名がそのままファイル名になると扱いにくい。 */
function slug(label) {
    const ascii = String(label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    if (ascii) return ascii.slice(0, 24);
    // 日本語だけのボタンは、文字コードから短い名前を作る（同じ名前なら同じになる）。
    let h = 0;
    for (const ch of String(label)) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0;
    return `s${(h >>> 0).toString(36).slice(0, 6)}`;
}

main().catch(failWith);
