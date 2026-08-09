/*
 * GIGA Standard v5 §7 の実測ツール。
 * コントラスト・タップ領域・CSP違反・JSエラー・横スクロール・PWA挙動を実ブラウザで測る。
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'docs';
const PORT = 8123;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));
const BASE = `http://localhost:${PORT}`;

// ─────────────────────────────────────────────────────────
// ブラウザ内で走らせる走査。色は 1px 塗って読む（§7-2）。
// ─────────────────────────────────────────────────────────
const SCAN = `(() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (s) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000'; ctx.fillStyle = s;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const a = d[3] / 255;
    return a === 0 ? [0, 0, 0, 0] : [d[0] / a, d[1] / a, d[2] / a, a];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const over = (fg, bg) => { const a = fg[3]; return [0,1,2].map(i => fg[i]*a + bg[i]*(1-a)).concat(1); };

  // 実効背景。グラデーションも見る（backgroundColor だけだと白の上の白で 1.0 の誤報になる）
  const bgOf = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const img = cs.backgroundImage;
      let c = parse(cs.backgroundColor);
      if (c[3] === 0 && img && img !== 'none') {
        const m = img.match(/(rgba?\\([^)]+\\)|#[0-9a-f]{3,8}|oklch\\([^)]+\\))/i);
        if (m) c = parse(m[1]);
      }
      if (c[3] === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc[3] >= 0.999) return acc;
    }
    return acc ?? [255, 255, 255, 1];
  };

  const EMOJI = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]/u;
  const contrast = [], taps = [];
  const seen = new Set();

  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    // ── コントラスト（直接の文字を持つ要素だけ）──
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('').trim();
    if (own && !EMOJI.test(own)) {
      const dis = el.disabled || el.getAttribute('aria-disabled') === 'true' || cs.cursor === 'not-allowed';
      if (!dis) {
        const fg = over(parse(cs.color), bgOf(el));
        const bg = bgOf(el);
        const cr = ratio(fg, bg);
        const px = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const need = (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
        if (cr < need) {
          const key = el.tagName + '|' + (el.className || '') + '|' + own.slice(0, 20);
          if (!seen.has(key)) { seen.add(key);
            contrast.push({ tag: el.tagName, cls: String(el.className || ''), text: own.slice(0, 30), color: cs.color, ratio: +cr.toFixed(2), need, fontSize: px }); }
        }
      }
    }

    // ── タップ領域（::after 込み）──
    if (el.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], label')) {
      if (cs.pointerEvents === 'none') continue;
      let w = r.width, h = r.height;
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none' || ps.pointerEvents === 'none') continue;
        const pw = parseFloat(ps.minWidth) || parseFloat(ps.width) || 0;
        const ph = parseFloat(ps.minHeight) || parseFloat(ps.height) || 0;
        if (ps.position === 'absolute') { w = Math.max(w, pw); h = Math.max(h, ph); }
      }
      if (w > 0 && h > 0 && (w < 44 || h < 44)) {
        const key = 'T' + el.tagName + '|' + (el.className || '') + '|' + (el.textContent || '').trim().slice(0, 20);
        if (!seen.has(key)) { seen.add(key);
          taps.push({ tag: el.tagName, cls: String(el.className || ''), text: (el.textContent || '').trim().slice(0, 24), w: +w.toFixed(1), h: +h.toFixed(1) }); }
      }
    }
  }
  // ── hidden 属性が効いているか ──
  // hidden は「display:none」を UA スタイルで当てているだけなので、
  // クラス側で display を書くと黙って無効になる。閉じているつもりのものが
  // ずっと開いたままになり、押しても何も起きないボタンに見える。
  // 実際 .more がこれで、［…］の中身が最初から全部出ていた。
  const hiddenBroken = [...document.querySelectorAll('[hidden]')]
    .filter((el) => getComputedStyle(el).display !== 'none')
    .map((el) => ({ tag: el.tagName, cls: String(el.className || ''), display: getComputedStyle(el).display }))
    .filter((v, i, all) => all.findIndex((x) => x.tag === v.tag && x.cls === v.cls) === i);

  return { contrast, taps, hiddenBroken, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
})()`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});

async function scanPage(url, steps = async () => {}, width = 375, colorScheme = 'light') {
  const ctx = await browser.newContext({ viewport: { width, height: 780 }, deviceScaleFactor: 2, colorScheme });
  const page = await ctx.newPage();
  const errors = [], csp = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy/i.test(t)) csp.push(t);
    else if (m.type() === 'error') errors.push(t);
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await steps(page);
  const r = await page.evaluate(SCAN);
  await ctx.close();
  return { url, ...r, errors, csp };
}

const results = [];

// ① ランチャー本体：タブを1つずつ開いて測る
for (const tab of ['post', 'make', 'note', 'log']) {
  const r = await scanPage(`${BASE}/index.html`, async (page) => {
    await page.click(`#tab-${tab}`).catch(() => {});
    await page.waitForTimeout(400);
  });
  results.push({ name: `index.html [${tab}]`, ...r });
}
// ①-b カードを開いた状態（［…］の中身）
results.push({ name: 'index.html [post + …展開]', ...await scanPage(`${BASE}/index.html`, async (page) => {
  await page.waitForTimeout(300);
  const more = await page.$$('button');
  for (const b of more) { const t = (await b.textContent()) ?? ''; if (t.includes('…') || t.includes('...')) { await b.click().catch(() => {}); break; } }
  await page.waitForTimeout(300);
}) });
// ② アプリ一覧
results.push({ name: 'apps.html', ...await scanPage(`${BASE}/apps.html`) });
// ③ 圏外ページ
results.push({ name: 'offline.html', ...await scanPage(`${BASE}/offline.html`) });

// ④ 320px 幅
for (const nm of ['index.html', 'apps.html', 'offline.html']) {
  const r = await scanPage(`${BASE}/${nm}`, async () => {}, 320);
  results.push({ name: `${nm} @320px`, ...r });
}

// ⑤ 夜の配色（prefers-color-scheme: dark）。
//    明るいほうだけ測ると、暗いほうの薄い文字を丸ごと見落とす。
for (const tab of ['post', 'make', 'note', 'log']) {
  const r = await scanPage(`${BASE}/index.html`, async (page) => {
    await page.click(`#tab-${tab}`).catch(() => {});
    await page.waitForTimeout(400);
  }, 375, 'dark');
  results.push({ name: `index.html [${tab}] 夜`, ...r });
}
results.push({ name: 'apps.html 夜', ...await scanPage(`${BASE}/apps.html`, async () => {}, 375, 'dark') });
results.push({ name: 'offline.html 夜', ...await scanPage(`${BASE}/offline.html`, async () => {}, 375, 'dark') });

console.log('\n===== コントラスト / タップ / 横スクロール =====');
for (const r of results) {
  const oflow = r.scrollW > r.clientW ? `⚠ 横スクロール ${r.scrollW}>${r.clientW}` : 'ok';
  console.log(`\n■ ${r.name}  … コントラスト未満 ${r.contrast.length}件 / タップ44px未満 ${r.taps.length}件 / hidden無効 ${r.hiddenBroken.length}件 / ${oflow} / JSエラー ${r.errors.length} / CSP ${r.csp.length}`);
  for (const c of r.contrast) console.log(`   [contrast ${c.ratio} < ${c.need}] <${c.tag} class="${c.cls}"> ${c.fontSize}px ${c.color} … "${c.text}"`);
  for (const t of r.taps) console.log(`   [tap ${t.w}x${t.h}] <${t.tag} class="${t.cls}"> "${t.text}"`);
  for (const h of r.hiddenBroken) console.log(`   [hidden無効 display:${h.display}] <${h.tag} class="${h.cls}">`);
  for (const e of r.errors.slice(0, 5)) console.log(`   [js] ${e.slice(0, 200)}`);
  for (const e of r.csp.slice(0, 5)) console.log(`   [csp] ${e.slice(0, 200)}`);
}

await browser.close();
server.close();
