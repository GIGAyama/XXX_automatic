#!/usr/bin/env node
/**
 * ③ 素材 — 各アプリの画面を撮って、投稿に添える紹介カード画像を作る。
 *
 *   node scripts/capture-media.mjs
 *   node scripts/capture-media.mjs --repo Typa     … 1件だけ
 *   node scripts/capture-media.mjs --force         … 既にある画像も撮りなおす
 *
 * 出力（どれも docs/media/ に置いてコミットする）:
 *   <repo>-shot.png     … アプリの画面そのもの
 *   <repo>-card.png     … 投稿に添える紹介カード 1200×675
 *   <repo>-card-2.png…  … 複数コマを有効にしたときの2枚目以降
 *   manifest.json       … 何をいつ撮れて／撮れなかったかの記録
 *
 * なぜ docs/ に置いてコミットするのか:
 *   投稿ランチャーは Web Share API に「ファイル」を渡す必要がある。
 *   ファイルは fetch で取ってくるので、GitHub Pages から配信されていないと
 *   取得できず、画像つき投稿が成立しない。生成物だがリポジトリに入れる。
 *
 * 撮れなかったアプリについて:
 *   ログイン必須・Google アカウント連携が要る・そもそも Pages が無い、
 *   といったものは撮れない。その場合も文字だけのカードは作る。
 *   どれが撮れていないかは manifest.json を見れば分かる（以前は分からなかった）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { assertJapaneseFont, dismissEntryScreen, launchChromium, settle } from './lib/browser.mjs';
import { CARD_SIZE, buildCardHtml } from './lib/card-template.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { jstStamp } from './lib/jst.mjs';
import { inspectCard } from './lib/png.mjs';

const SHOT_SIZE = { width: 1000, height: 1000 };
const MANIFEST_VERSION = 1;

async function main() {
    const args = parseArgs();
    loadConfig();
    const media = readJson(paths.config('media.json'), {});
    const carousel = media.carousel ?? { enabled: false, frames: 1, intervalMs: 1800 };
    const stabilize = media.stabilize ?? { maxTries: 6, intervalMs: 300, minWaitMs: 400 };
    const frames = carousel.enabled ? Math.min(4, Math.max(2, carousel.frames ?? 3)) : 1;

    const collected = readJson(paths.data('repos.json'), null);
    if (!collected) fail('data/repos.json がありません。先に `npm run collect` を実行してください。');

    let targets = collected.repos;
    if (args.repo) targets = targets.filter((r) => r.name === args.repo);
    if (args.limit) targets = targets.slice(0, Number(args.limit));
    if (targets.length === 0) fail(`対象が見つかりません（--repo ${args.repo ?? ''}）`);

    fs.mkdirSync(paths.media(), { recursive: true });
    const manifest = loadManifest();
    // カードの雛形を直したら全件撮りなおす。テンプレートを直したのに絵が古いままだと、
    // 直したつもりで直っていないことに何週間も気づけない。
    const templateSha = sha(fs.readFileSync(new URL('./lib/card-template.mjs', import.meta.url)));
    const templateChanged = manifest.cardTemplateSha !== templateSha;
    if (templateChanged && manifest.cardTemplateSha) {
        info('   カードの雛形が変わっているので、全件を作りなおします');
    }

    info(`③ 素材づくりを開始します — ${targets.length} 件が対象${carousel.enabled ? `（1件あたり ${frames} コマ）` : ''}`);

    const browser = await launchChromium();
    let shots = 0;
    let cards = 0;
    let failures = 0;
    let skipped = 0;
    let blanks = 0;

    try {
        await assertJapaneseFont(browser);

        for (const [index, repo] of targets.entries()) {
            const label = `[${index + 1}/${targets.length}] ${repo.name}`;
            const profile = readJson(paths.data('profiles', `${repo.name}.json`), null);
            if (!profile) {
                info(`   − ${label} プロフィールが無いので飛ばします（先に npm run profiles）`);
                continue;
            }

            const entry = (manifest.apps[repo.name] ??= { shot: {}, card: {} });
            const shotPrint = fingerprint([repo.pushedAt, repo.pagesUrl, String(frames)]);
            const cardPrint = fingerprint([shotPrint, templateSha, JSON.stringify(profileFields(profile))]);

            // ⚠️ 差分の判定にファイルの mtime を使わない。
            //    git は mtime を保存しないので、actions/checkout はすべてのファイルの mtime を
            //    「チェックアウトした時刻」にする。つまり CI では常に「ファイルのほうが新しい」となり、
            //    --force を渡さない限り二度と撮りなおされなかった。
            //    中身から決まる指紋なら、CI でも手元でも同じ判断になる。
            const cardFiles = cardPathsFor(repo.name, frames);
            const upToDate =
                !args.force &&
                entry.card?.fingerprint === cardPrint &&
                cardFiles.every((p) => fs.existsSync(p));
            if (upToDate) {
                skipped += 1;
                continue;
            }

            let shotUris = [];
            let dismissed = null;
            if (repo.pagesUrl) {
                try {
                    const result = await captureApp(browser, repo.pagesUrl, repo.name, { frames, stabilize, carousel });
                    shotUris = result.dataUris;
                    dismissed = result.dismissed;
                    shots += 1;
                    entry.shot = {
                        ok: true,
                        fingerprint: shotPrint,
                        atJst: jstStamp(),
                        frames: shotUris.length,
                        stabilized: result.stabilized,
                        dismissed,
                        reason: null,
                    };
                } catch (error) {
                    // 撮れなくても止まらない。文字だけのカードを作って先へ進む。
                    const reason = error.message.split('\n')[0];
                    console.warn(`   ⚠ ${label} 画面を撮れませんでした（${reason}）`);
                    failures += 1;
                    entry.shot = { ok: false, fingerprint: shotPrint, atJst: jstStamp(), reason };
                }
            } else {
                entry.shot = { ok: false, fingerprint: shotPrint, atJst: jstStamp(), reason: 'GitHub Pages がありません' };
            }

            const written = await renderCards(browser, profile, repo, shotUris, frames);
            cards += 1;

            // 撮ったものが真っ白でないかを見る。
            // MANUAL に既知の症状として書いてあるのに、確かめる手段が無かった。
            const blank = media.blankCheck === false ? [] : written.filter((p) => isBlank(p));
            if (blank.length > 0) {
                blanks += 1;
                console.warn(`   ⚠ ${label} 作ったカードがほぼ単色です: ${blank.map((p) => rel(p)).join(', ')}`);
            }

            entry.card = {
                ok: blank.length === 0,
                fingerprint: cardPrint,
                atJst: jstStamp(),
                frames: written.length,
                blank: blank.length > 0,
            };
            info(`   ✓ ${label} ${shotUris.length > 0 ? `スクショ${shotUris.length}枚+カード${written.length}枚` : 'カードのみ'}`);
        }
    } finally {
        await browser.close();
    }

    manifest.cardTemplateSha = templateSha;
    manifest.updatedAtJst = jstStamp();
    writeJson(paths.media('manifest.json'), manifest);

    info('');
    info(`③ 完了 — カード ${cards} 枚、うち画面つき ${shots} 枚、変更なしで飛ばした ${skipped} 件、撮影失敗 ${failures} 件`);
    if (blanks > 0) {
        // ここは失敗にしない（文字だけのカードでも投稿はできる）が、黙ってもいない。
        info(`   ⚠ ${blanks} 件のカードがほぼ単色でした。日本語フォントか描画待ちを疑ってください`);
    }
    const notShot = Object.entries(manifest.apps).filter(([, v]) => v.shot?.ok === false);
    if (notShot.length > 0) {
        info(`   画面を撮れていないアプリ ${notShot.length} 件（${rel(paths.media('manifest.json'))} に一覧があります）`);
    }
    info(`   出力先: ${rel(paths.media())}/`);
}

/* ────────────────────────────────────────────
 *  差分の判定
 * ──────────────────────────────────────────── */

function loadManifest() {
    const current = readJson(paths.media('manifest.json'), null);
    if (current && current.version === MANIFEST_VERSION && current.apps) return current;
    return { version: MANIFEST_VERSION, cardTemplateSha: null, updatedAtJst: null, apps: {} };
}

function sha(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function fingerprint(parts) {
    return sha(parts.map((p) => String(p ?? '')).join(' '));
}

/** カードの見た目に効くプロフィールの項目だけ。ここが変われば作りなおす。 */
function profileFields(profile) {
    return {
        catchCopy: profile.catchCopy,
        oneLine: profile.oneLine,
        targetGrade: profile.targetGrade,
        subject: profile.subject,
    };
}

function cardPathsFor(name, frames) {
    return Array.from({ length: frames }, (_, i) => paths.media(i === 0 ? `${name}-card.png` : `${name}-card-${i + 1}.png`));
}

function isBlank(filePath) {
    try {
        return inspectCard(fs.readFileSync(filePath), { expect: CARD_SIZE }).blank;
    } catch {
        return false;
    }
}

/* ────────────────────────────────────────────
 *  撮る
 * ──────────────────────────────────────────── */

/**
 * Chromium を起動する。
 *
 * playwright は「自分のバージョンに対応する Chromium」しか使わない。
 * すでに別の版が入っている環境（開発コンテナや、Chromium を apt で入れた PC）では
 * `npx playwright install` を強要されて詰まる。
 * CHROMIUM_PATH を渡せばそれを使うようにして、逃げ道を作っておく。
 */
/**
 * 日本語フォントが入っているかを、撮りはじめる前に1回だけ確かめる。
 *
 * 入っていないと文字がぜんぶ □□□（豆腐）になる。
 * 撮ったあとの色の統計では豆腐を見分けられない（豆腐も「何かが描かれている」ので色は散る）。
 * 撮る前に止めるのが唯一の手である。
 *
 * ⚠️ 送り幅の比較では判定できない。
 *    最初そう書いたが、日本語フォントがある環境でも「漢」と U+E000 の幅は違うし、
 *    無い環境でも違う。つまり、いつでも「フォントあり」と答える検査になっていた。
 *    落ちない検査は、合格しているのではなく何も見ていない（CLAUDE.md §6）。
 *
 * 実際に描いて、絵として同じかどうかを見る。
 * 私用領域 U+E000 はどのフォントにも字形が無いので、必ず .notdef（□）が描かれる。
 * 「漢」がそれと1ピクセルも違わないなら、漢字にも字形が無い＝日本語フォントが1つも無い。
 */
/** アプリを開いて画面を撮る。data URI で返してカードに埋め込めるようにする。 */
async function captureApp(browser, url, name, { frames, stabilize, carousel }) {
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

        // 描画が落ち着くのを待つ。以前は 2500ms の決め打ちだったが、
        // 遅い CI では描画途中を撮ってしまい、しかもそれを知る手段が無かった。
        const first = await settle(page, stabilize);
        const buffers = [first.buffer];

        // 「はじめる」のような入口ボタンがあると、押さない限り
        // タイトル画面しか撮れず、どのアプリも同じ絵になってしまう。
        const dismissed = await dismissEntryScreen(page);
        if (dismissed.clicked) {
            const after = await settle(page, stabilize);
            // 1コマだけのときは、入口を抜けたあとの絵のほうを使う。
            if (frames === 1) buffers[0] = after.buffer;
            else buffers.push(after.buffer);
        }

        // 複数コマのときは、少し間を空けて動いている様子を拾う。
        while (buffers.length < frames) {
            await page.waitForTimeout(carousel.intervalMs ?? 1800);
            buffers.push(await page.screenshot({ type: 'png' }));
        }

        for (const [i, buffer] of buffers.entries()) {
            fs.writeFileSync(paths.media(i === 0 ? `${name}-shot.png` : `${name}-shot-${i + 1}.png`), buffer);
        }

        return {
            dataUris: buffers.map((b) => `data:image/png;base64,${b.toString('base64')}`),
            stabilized: first.stabilized,
            dismissed: dismissed.label,
        };
    } finally {
        await context.close();
    }
}

/**
 * 絵が動かなくなるまで待つ。
 * 同じ絵が2回続いたら安定とみなす。決め打ちの待ち時間より、遅い環境に強い。
 */
/**
 * 入口ボタンがあれば1つだけ押して中身の画面に入る。
 * 押せなくても失敗にはしない（タイトル画面でも絵にはなる）。
 *
 * 以前は catch を空にしていたので、どのアプリで入口を抜けられなかったのかが
 * どこにも残らなかった。結果を返して manifest.json に書く。
 */
/** 紹介カードを HTML から起こして撮る。撮れたファイルのパスを返す。 */
async function renderCards(browser, profile, repo, screenshotDataUris, frames) {
    const context = await browser.newContext({ viewport: CARD_SIZE, deviceScaleFactor: 1, locale: 'ja-JP' });
    const page = await context.newPage();
    const written = [];
    try {
        for (let i = 0; i < frames; i += 1) {
            const html = buildCardHtml({
                name: repo.name,
                catchCopy: profile.catchCopy,
                oneLine: profile.oneLine,
                targetGrade: profile.targetGrade,
                subject: profile.subject,
                screenshotDataUri: screenshotDataUris[i] ?? screenshotDataUris[0] ?? null,
            });
            await page.setContent(html, { waitUntil: 'load' });
            await page.evaluate(() => document.fonts?.ready); // 日本語フォントの適用を待つ
            await page.waitForTimeout(300);

            const target = paths.media(i === 0 ? `${repo.name}-card.png` : `${repo.name}-card-${i + 1}.png`);
            fs.writeFileSync(target, await page.screenshot({ type: 'png' }));
            written.push(target);

            // 材料が1枚しか無いなら、同じ絵を並べても意味がない。
            if (screenshotDataUris.length <= 1 && i === 0 && frames > 1) break;
        }
    } finally {
        await context.close();
    }

    // 使わなかった古いコマを消す。有効から無効に戻したときに、
    // 前回の2枚目が残っていると launcher.json がそれを拾ってしまう。
    for (let i = written.length; i < 4; i += 1) {
        const stale = paths.media(`${repo.name}-card-${i + 1}.png`);
        if (fs.existsSync(stale)) fs.rmSync(stale);
    }

    return written;
}

main().catch(failWith);
