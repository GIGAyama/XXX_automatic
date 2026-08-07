/**
 * Chromium を立てて、画面が落ち着くのを待って撮るための道具。
 *
 * 紹介カード（capture-media.mjs）と、記事に入れる画面（capture-shots.mjs）の
 * 両方から使う。同じことを2か所に書くと、片方だけ直したときに
 * 「カードは直ったのに記事の画像は古いまま」という気づきにくいずれ方をする。
 *
 * ここに置いてあるのは、どちらにも要る4つだけである。
 *   launchChromium      … 起動と、失敗したときの直し方の案内
 *   assertJapaneseFont  … 日本語が □□□ にならないことの確認
 *   settle              … 「前と同じ絵になったら安定」で待つ
 *   dismissEntryScreen  … 「はじめる」を押してタイトル画面を抜ける
 */
import { chromium } from 'playwright';
import { info } from './io.mjs';

export async function launchChromium() {
    const executablePath = process.env.CHROMIUM_PATH || undefined;
    if (executablePath) info(`   （CHROMIUM_PATH の Chromium を使います: ${executablePath}）`);

    // プロキシ越しでしか外に出られない環境がある（社内・校内のネットワーク、
    // 一部の CI）。Chromium は環境変数を自分では見てくれないので、渡してやる。
    // 渡さないと ERR_TUNNEL_CONNECTION_FAILED で落ちるだけで、
    // 「プロキシの話だ」と気づく手がかりが何も出ない。
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    // ⚠️ NO_PROXY も一緒に渡す。渡さないと、手元に立てたサーバー（127.0.0.1）まで
    //    プロキシに送られ、返ってくるのはプロキシのエラーページである。
    //    しかもそれは「文字のあるふつうのページ」なので、真っ白かどうかの検査にも
    //    引っかからない。撮れているのに中身が違う、といういちばん気づきにくい形になる
    //    （実際にそうなった。撮れた画像を開いて初めて分かった）。
    const bypass = (process.env.NO_PROXY || process.env.no_proxy || '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
        .join(',');
    const proxy = proxyUrl ? { server: proxyUrl, ...(bypass ? { bypass } : {}) } : undefined;
    if (proxy) info(`   （プロキシ経由で見にいきます: ${proxyUrl}）`);

    try {
        return await chromium.launch({
            executablePath,
            proxy,
            // プロキシが自前の証明書で中継していることがある。
            // 撮るのは自分が公開しているページなので、ここは通す。
            ignoreHTTPSErrors: true,
        });
    } catch (error) {
        throw new Error(
            `${error.message}\n\n` +
                '対処:\n' +
                '  npx playwright install chromium        … playwright に合う版を入れる\n' +
                '  CHROMIUM_PATH=/path/to/chrome npm run media  … すでにある Chromium を使う（記事の画面は npm run shots）'
        );
    }
}

export async function assertJapaneseFont(browser) {
    const context = await browser.newContext({ viewport: { width: 200, height: 200 } });
    const page = await context.newPage();
    try {
        await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
        const tofu = await page.evaluate(() => {
            const FONT =
                '48px "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Hiragino Kaku Gothic ProN", ' +
                '"Yu Gothic", Meiryo, IPAexGothic, IPAGothic, sans-serif';

            function draw(ch) {
                const canvas = document.createElement('canvas');
                canvas.width = 64;
                canvas.height = 64;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, 64, 64);
                ctx.fillStyle = '#000';
                ctx.textBaseline = 'top';
                ctx.font = FONT;
                ctx.fillText(ch, 2, 2);
                return ctx.getImageData(0, 0, 64, 64).data;
            }

            const kanji = draw('漢');
            const pua = draw('');

            let identical = true;
            let ink = 0;
            for (let i = 0; i < kanji.length; i += 4) {
                if (kanji[i] !== pua[i]) identical = false;
                if (kanji[i] < 200) ink += 1;
            }
            // 同じ絵になった＝どちらも豆腐。
            // 念のため「そもそもほとんど何も描かれていない」も拾う。
            return identical || ink < 40;
        });
        if (tofu) {
            throw Object.assign(
                new Error(
                    'この環境には日本語フォントが入っていません。\n' +
                        'このまま撮ると、撮った画面の文字がぜんぶ □□□ になります。\n\n' +
                        '対処:\n' +
                        '  sudo apt-get install -y fonts-noto-cjk    … Ubuntu / Debian\n' +
                        '  brew install --cask font-noto-sans-cjk-jp … macOS\n\n' +
                        '週次ワークフローは撮る前に fonts-noto-cjk を入れています。'
                ),
                { userFacing: true }
            );
        }
    } finally {
        await context.close();
    }
}

export async function settle(page, { maxTries = 6, intervalMs = 300, minWaitMs = 400 } = {}) {
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(minWaitMs);

    let previous = await page.screenshot({ type: 'png' });
    for (let i = 0; i < maxTries; i += 1) {
        await page.waitForTimeout(intervalMs);
        const current = await page.screenshot({ type: 'png' });
        if (current.equals(previous)) return { buffer: current, stabilized: true };
        previous = current;
    }
    // 動きつづけるアプリ（アニメーションが止まらないもの）もある。これは失敗ではない。
    return { buffer: previous, stabilized: false };
}

export async function dismissEntryScreen(page) {
    const labels = ['はじめる', 'はじめよう', 'スタート', 'ゲームスタート', 'スタート！', '開始', 'つづきから', '通常モード'];
    let sawButton = false;

    for (const label of labels) {
        try {
            const button = page.getByRole('button', { name: label, exact: false }).first();
            if (await button.isVisible({ timeout: 400 })) {
                sawButton = true;
                await button.click({ timeout: 1500 });
                return { clicked: true, label };
            }
        } catch {
            // 見つからない・押せないのは想定内。次の候補へ。
        }
    }
    return { clicked: false, label: sawButton ? '押せませんでした' : null };
}
