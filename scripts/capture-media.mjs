#!/usr/bin/env node
/**
 * ③ 素材 — 各アプリの画面を撮って、投稿に添える紹介カード画像を作る。
 *
 *   node scripts/capture-media.mjs
 *   node scripts/capture-media.mjs --repo Typa     … 1件だけ
 *   node scripts/capture-media.mjs --force         … 既にある画像も撮りなおす
 *
 * 出力（どちらも docs/media/ に置いてコミットする）:
 *   <repo>-shot.png   … アプリの画面そのもの
 *   <repo>-card.png   … 投稿に添える紹介カード 1200×675
 *
 * なぜ docs/ に置いてコミットするのか:
 *   投稿ランチャーは Web Share API に「ファイル」を渡す必要がある。
 *   ファイルは fetch で取ってくるので、GitHub Pages から配信されていないと
 *   取得できず、画像つき投稿が成立しない。生成物だがリポジトリに入れる。
 *
 * 撮れなかったアプリについて:
 *   ログイン必須・Google アカウント連携が要る・そもそも Pages が無い、
 *   といったものは撮れない。その場合も文字だけのカードは作る。
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { CARD_SIZE, buildCardHtml } from './lib/card-template.mjs';
import { fail, info, loadConfig, parseArgs, paths, readJson, rel } from './lib/io.mjs';

const SHOT_SIZE = { width: 1000, height: 1000 };

async function main() {
    const args = parseArgs();
    loadConfig();

    const collected = readJson(paths.data('repos.json'), null);
    if (!collected) fail('data/repos.json がありません。先に `npm run collect` を実行してください。');

    let targets = collected.repos;
    if (args.repo) targets = targets.filter((r) => r.name === args.repo);
    if (args.limit) targets = targets.slice(0, Number(args.limit));
    if (targets.length === 0) fail(`対象が見つかりません（--repo ${args.repo ?? ''}）`);

    fs.mkdirSync(paths.media(), { recursive: true });
    info(`③ 素材づくりを開始します — ${targets.length} 件が対象`);

    const browser = await launchChromium();
    let shots = 0;
    let cards = 0;
    let failures = 0;

    try {
        for (const [index, repo] of targets.entries()) {
            const label = `[${index + 1}/${targets.length}] ${repo.name}`;
            const shotPath = paths.media(`${repo.name}-shot.png`);
            const cardPath = paths.media(`${repo.name}-card.png`);

            if (!args.force && fs.existsSync(cardPath)) {
                // 中身が変わっていないなら撮りなおす意味がない。
                // README を直しただけで画面が変わらないことも多い。
                const stat = fs.statSync(cardPath);
                if (repo.pushedAt && new Date(repo.pushedAt) < stat.mtime) continue;
            }

            const profile = readJson(paths.data('profiles', `${repo.name}.json`), null);
            if (!profile) {
                info(`   − ${label} プロフィールが無いので飛ばします（先に npm run profiles）`);
                continue;
            }

            let screenshotDataUri = null;
            if (repo.pagesUrl) {
                try {
                    screenshotDataUri = await captureApp(browser, repo.pagesUrl, shotPath);
                    shots += 1;
                } catch (error) {
                    // 撮れなくても止まらない。文字だけのカードを作って先へ進む。
                    console.warn(`   ⚠ ${label} 画面を撮れませんでした（${error.message.split('\n')[0]}）`);
                    failures += 1;
                }
            }

            await renderCard(browser, profile, repo, screenshotDataUri, cardPath);
            cards += 1;
            info(`   ✓ ${label} ${screenshotDataUri ? 'スクショ+カード' : 'カードのみ'}`);
        }
    } finally {
        await browser.close();
    }

    info('');
    info(`③ 完了 — カード ${cards} 枚、うち画面つき ${shots} 枚、撮影失敗 ${failures} 件`);
    info(`   出力先: ${rel(paths.media())}/`);
}

/**
 * Chromium を起動する。
 *
 * playwright は「自分のバージョンに対応する Chromium」しか使わない。
 * すでに別の版が入っている環境（開発コンテナや、Chromium を apt で入れた PC）では
 * `npx playwright install` を強要されて詰まる。
 * CHROMIUM_PATH を渡せばそれを使うようにして、逃げ道を作っておく。
 */
async function launchChromium() {
    const executablePath = process.env.CHROMIUM_PATH || undefined;
    if (executablePath) info(`   （CHROMIUM_PATH の Chromium を使います: ${executablePath}）`);
    try {
        return await chromium.launch({ executablePath });
    } catch (error) {
        throw new Error(
            `${error.message}\n\n` +
                '対処:\n' +
                '  npx playwright install chromium        … playwright に合う版を入れる\n' +
                '  CHROMIUM_PATH=/path/to/chrome npm run media  … すでにある Chromium を使う'
        );
    }
}

/** アプリを開いて画面を撮る。data URI で返してカードに埋め込めるようにする。 */
async function captureApp(browser, url, shotPath) {
    const context = await browser.newContext({
        viewport: SHOT_SIZE,
        deviceScaleFactor: 2, // 縮小して使うので2倍で撮る。等倍だと文字が潰れる
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        colorScheme: 'light',
    });
    const page = await context.newPage();

    try {
        // networkidle まで待たない。Service Worker を持つ PWA は
        // 常時なにかしら通信していることがあり、待つと必ずタイムアウトする。
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // 起動アニメーション・フォント読み込み・初期描画が落ち着くのを待つ。
        await page.waitForTimeout(2500);

        // 「はじめる」のような入口ボタンがあると、押さない限り
        // タイトル画面しか撮れず、どのアプリも同じ絵になってしまう。
        await dismissEntryScreen(page);

        const buffer = await page.screenshot({ type: 'png' });
        fs.writeFileSync(shotPath, buffer);
        return `data:image/png;base64,${buffer.toString('base64')}`;
    } finally {
        await context.close();
    }
}

/**
 * 入口ボタンがあれば1つだけ押して中身の画面に入る。
 * 押せなくても失敗にはしない（タイトル画面でも絵にはなる）。
 */
async function dismissEntryScreen(page) {
    const labels = ['はじめる', 'はじめよう', 'スタート', 'ゲームスタート', 'スタート！', '開始', 'つづきから', '通常モード'];
    for (const label of labels) {
        try {
            const button = page.getByRole('button', { name: label, exact: false }).first();
            if (await button.isVisible({ timeout: 400 })) {
                await button.click({ timeout: 1500 });
                await page.waitForTimeout(1200);
                return;
            }
        } catch {
            // 見つからない・押せないのは想定内。次の候補へ。
        }
    }
}

/** 紹介カードを HTML から起こして撮る。 */
async function renderCard(browser, profile, repo, screenshotDataUri, cardPath) {
    const context = await browser.newContext({ viewport: CARD_SIZE, deviceScaleFactor: 1, locale: 'ja-JP' });
    const page = await context.newPage();
    try {
        const html = buildCardHtml({
            name: repo.name,
            catchCopy: profile.catchCopy,
            oneLine: profile.oneLine,
            targetGrade: profile.targetGrade,
            subject: profile.subject,
            screenshotDataUri,
        });
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts?.ready); // 日本語フォントの適用を待つ
        await page.waitForTimeout(300);
        fs.writeFileSync(cardPath, await page.screenshot({ type: 'png' }));
    } finally {
        await context.close();
    }
}

main().catch((error) => fail(error.stack ?? error.message));
