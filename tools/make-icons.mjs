#!/usr/bin/env node
/**
 * PWA のアイコンを作る。
 *
 *   node tools/make-icons.mjs
 *
 * 手で画像を用意しないのは、maskable のセーフゾーン（中央 80% の円に
 * 収まっていないと Android で端が切られる）を毎回守るのが難しいからである。
 * ここで作れば、作りなおしても同じものが出る。
 *
 * Playwright の Chromium で SVG を撮って PNG にしている。
 * 画像ライブラリを足さないのは、OS ごとのビルドで詰まるのを避けるためである。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'docs', 'icons');

const BG = '#1d3557';
const FG = '#ffffff';
const ACCENT = '#ffb703';

/**
 * @param {number} size
 * @param {boolean} maskable maskable は中央 80% に収める（外周は切られる前提）
 */
function svg(size, maskable) {
    // maskable は安全域が中央80%。図形をその内側に収める。
    //
    // ⚠️ 「余白 10%」では足りない。
    //    安全域は正方形ではなく直径80%の円なので、四隅は円の外に出る。
    //    実測すると紙の左上の角が中央から 0.43（円は 0.40）にあり、
    //    セーフゾーン外の中身が 0.29% あった（目標は 0.2% 以下）。
    //    14% まで引くと角が 0.387 に収まる。
    //    下地（いちばん外側の rect）は端まで伸ばしたままにすること。
    //    余白を付けて下地まで縮めると、欠けはしないが切り抜きの内側が
    //    余白色で埋まり、アイコンが小さく見える（§3-7 で多いほうの症状）。
    const inset = maskable ? size * 0.14 : size * 0.04;
    const inner = size - inset * 2;
    const s = (v) => inset + inner * v;
    const w = (v) => inner * v;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <!-- 紙（下書き） -->
  <rect x="${s(0.14)}" y="${s(0.1)}" width="${w(0.56)}" height="${w(0.72)}" rx="${w(0.06)}" fill="${FG}"/>
  <rect x="${s(0.22)}" y="${s(0.24)}" width="${w(0.4)}" height="${w(0.05)}" rx="${w(0.025)}" fill="${BG}" opacity=".78"/>
  <rect x="${s(0.22)}" y="${s(0.37)}" width="${w(0.4)}" height="${w(0.05)}" rx="${w(0.025)}" fill="${BG}" opacity=".55"/>
  <rect x="${s(0.22)}" y="${s(0.5)}" width="${w(0.27)}" height="${w(0.05)}" rx="${w(0.025)}" fill="${BG}" opacity=".38"/>
  <!-- 送信（共有シートへ出ていく矢印） -->
  <circle cx="${s(0.71)}" cy="${s(0.7)}" r="${w(0.23)}" fill="${ACCENT}"/>
  <path d="M ${s(0.62)} ${s(0.7)} L ${s(0.8)} ${s(0.7)} M ${s(0.73)} ${s(0.63)} L ${s(0.8)} ${s(0.7)} L ${s(0.73)} ${s(0.77)}"
        stroke="${BG}" stroke-width="${w(0.045)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
}

const TARGETS = [
    { file: 'icon-192.png', size: 192, maskable: false },
    { file: 'icon-512.png', size: 512, maskable: false },
    { file: 'maskable-192.png', size: 192, maskable: true },
    { file: 'maskable-512.png', size: 512, maskable: true },
    { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
fs.mkdirSync(OUT_DIR, { recursive: true });

try {
    for (const target of TARGETS) {
        const context = await browser.newContext({
            viewport: { width: target.size, height: target.size },
            deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        await page.setContent(
            `<!doctype html><style>*{margin:0;padding:0}html,body{width:${target.size}px;height:${target.size}px;overflow:hidden}</style>${svg(target.size, target.maskable)}`,
            { waitUntil: 'load' }
        );
        fs.writeFileSync(path.join(OUT_DIR, target.file), await page.screenshot({ type: 'png', omitBackground: false }));
        await context.close();
        console.log(`  ✓ ${target.file} (${target.size}px${target.maskable ? ', maskable' : ''})`);
    }
} finally {
    await browser.close();
}

console.log(`アイコンを ${TARGETS.length} 個 作りました: docs/icons/`);
