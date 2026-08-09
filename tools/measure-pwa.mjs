/*
 * GIGA Standard v5 §7-5 の実測。Service Worker の挙動を実ブラウザで確かめる。
 *
 *   ① 登録されているか
 *   ② 初回訪問で勝手にリロードしないか（画面遷移が1回か）
 *   ③ 押すまで切り替わらないか（版を上げて3秒放置し waiting のままか）
 *   ④ 他アプリのキャッシュを巻き添えにしないか  ← 同一オリジン共有なのでここが要
 *   ⑤ 圏外で起動するか／offline.html が出るか
 *
 * ④ は「同じオリジンに別アプリのキャッシュが残っているか」を見る。
 * gigayama.github.io は数十本が同一オリジンを共有しているため、
 * ここが落ちると他アプリが圏外で起動しなくなる。
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'docs';
const PORT = 8124;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// sw.js の VERSION を差し替えて配れるようにする（版を上げた状態を作るため）
let bumpVersion = null;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  let body = fs.readFileSync(file);
  if (p.endsWith('/sw.js') && bumpVersion) body = Buffer.from(String(body).replace(/const VERSION = '[^']*'/, `const VERSION = '${bumpVersion}'`));
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, r));
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();

let navCount = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navCount += 1; });

// ── ④の下ごしらえ：別アプリのキャッシュを2つ置く ──
await page.goto(`${BASE}/index.html`);
await page.evaluate(async () => {
  await caches.open('keisan-card-static-v1').then((c) => c.put('/other-a', new Response('a')));
  await caches.open('kanji-town-static-v3').then((c) => c.put('/other-b', new Response('b')));
});
await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.unregister()));
await page.evaluate(() => caches.keys().then((k) => Promise.all(k.filter((x) => x.startsWith('launcher-')).map((x) => caches.delete(x)))));

// ── ①②：まっさらな状態で1回開く ──
navCount = 0;
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const registered = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return r ? { scope: r.scope, active: !!r.active, waiting: !!r.waiting } : null;
});
console.log(`① 登録: ${registered ? `されている（active=${registered.active}）` : '❌ されていない'}`);
console.log(`② 初回訪問の画面遷移: ${navCount} 回  ${navCount === 1 ? '（正常）' : '（❌ 勝手にリロードしている）'}`);

const cachesAfterFirst = await page.evaluate(() => caches.keys());
console.log(`   キャッシュ: ${JSON.stringify(cachesAfterFirst)}`);

// ── ④：他アプリのキャッシュが残っているか ──
const survivedFirst = cachesAfterFirst.filter((k) => !k.startsWith('launcher-'));
console.log(`④-a 初回 activate のあと、他アプリのキャッシュ: ${survivedFirst.length ? JSON.stringify(survivedFirst) : '❌ 全部消えた'}`);

// ── 消えていたら置き直して、版を上げたときの挙動を見る ──
await page.evaluate(async () => {
  await caches.open('keisan-card-static-v1').then((c) => c.put('/other-a', new Response('a')));
  await caches.open('kanji-town-static-v3').then((c) => c.put('/other-b', new Response('b')));
});

// ── ③：版を上げて3秒放置。waiting のままか ──
bumpVersion = 'vTESTBUMP';
navCount = 0;
await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
await page.waitForTimeout(3000);
const afterUpdate = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { waiting: !!r.waiting, active: r.active ? 'あり' : 'なし', caches: await caches.keys() };
});
console.log(`③ 版を上げて3秒放置: waiting=${afterUpdate.waiting}  ${afterUpdate.waiting ? '（正常：押すまで切り替わらない）' : '❌ 勝手に切り替わった（install で skipWaiting している）'}`);
console.log(`   画面遷移: ${navCount} 回 ${navCount === 0 ? '（正常）' : '❌ 押していないのに読み直した'}`);
console.log(`   キャッシュ: ${JSON.stringify(afterUpdate.caches)}`);
const survivedUpdate = afterUpdate.caches.filter((k) => !k.startsWith('launcher-'));
console.log(`④-b 版を上げたあと、他アプリのキャッシュ: ${survivedUpdate.length ? JSON.stringify(survivedUpdate) + '（正常）' : '❌ 全部消えた — 同一オリジンの他アプリが圏外で起動しなくなる'}`);

// ── ③': 押したら切り替わるか ──
//    「押すまで切り替わらない」だけを確かめて満足すると、
//    「押しても何も起きない」ボタンを置いたまま合格にしてしまう。
const barShown = await page.evaluate(() => !!document.getElementById('updatebar'));
console.log(`③' 更新の帯が出ているか: ${barShown ? '出ている' : '❌ 出ていない（押す手段が無い）'}`);
if (barShown) {
  navCount = 0;
  await page.click('#updatebar .btn--done');
  await page.waitForTimeout(3000);
  const afterClick = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { waiting: !!r.waiting, caches: await caches.keys() };
  });
  const stale = afterClick.caches.filter((k) => k.startsWith('launcher-') && !k.includes('TESTBUMP'));
  console.log(`   押したあと: waiting=${afterClick.waiting} / 画面遷移 ${navCount} 回 ${navCount >= 1 ? '（正常：読み直した）' : '❌ 読み直していない'}`);
  console.log(`   古いキャッシュ: ${stale.length ? '❌ ' + JSON.stringify(stale) : '消えた（正常）'}`);
  console.log(`   他アプリのキャッシュ: ${JSON.stringify(afterClick.caches.filter((k) => !k.startsWith('launcher-')))}`);
}

// ── ⑤：圏外で起動するか ──
bumpVersion = null;
await page.waitForTimeout(500);
await ctx.setOffline(true);
navCount = 0;
let offlineOk = true;
try {
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
} catch { offlineOk = false; }
const title = await page.title().catch(() => '(取得できず)');
console.log(`⑤-a 圏外で起動: ${offlineOk ? `できた（title="${title}"）` : '❌ できない'}`);

// 本体のキャッシュだけ消してから圏外にすると offline.html が出るか
await ctx.setOffline(false);
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.evaluate(() => caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('launcher-shell')).map(async (k) => {
  const c = await caches.open(k);
  for (const req of await c.keys()) if (!req.url.includes('offline.html')) await c.delete(req);
}))));
await ctx.setOffline(true);
let offlineHtml = '(出なかった)';
try {
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  offlineHtml = await page.title();
} catch { /* noop */ }
console.log(`⑤-b 本体が無いときの表示: title="${offlineHtml}"`);

await browser.close();
server.close();
