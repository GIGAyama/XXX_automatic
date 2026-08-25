/* ビルド成果物を、GitHub Pages と同じサブパスの下で配る静的サーバ。
 *
 *   node serve.mjs <ルート> <ポート> <ベースパス> [--spa]
 *   node serve.mjs dist 4180 /Qalc/
 *
 * 本番が https://<user>.github.io/<repo>/ で配信されるアプリは、
 * manifest や Service Worker が /<repo>/ という絶対パスを持っている。
 * ルート直下（http://localhost:4180/）で配ると、そこだけ本番と挙動が変わって
 * 撮影した画面が本物と食いちがう。だからサブパスごと再現する。
 *
 * --spa を付けると、見つからないパスを index.html に落とす。
 * ただし GitHub Pages はそういう動きをしないので、本番に 404.html を置いている
 * アプリでないかぎり使わない。撮影の画面が本番と変わってしまう。
 *
 * 外部への口はいっさい開けない。校内フィルタリングの下と同じ状態で撮るため。
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const SPA = argv.includes('--spa');
const positional = argv.filter((a) => !a.startsWith('--'));
const ROOT = resolve(positional[0] || 'dist');
const PORT = Number(positional[1] || 4180);
let BASE = positional[2] || '/';
if (!BASE.startsWith('/')) BASE = `/${BASE}`;
if (!BASE.endsWith('/')) BASE = `${BASE}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { return send(res, 400, 'bad url'); }

  if (BASE !== '/' && !p.startsWith(BASE)) {
    if (`${p}/` === BASE) { res.writeHead(302, { Location: BASE }); return res.end(); }
    return send(res, 404, 'outside base path');
  }
  let rel = p.slice(BASE.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  let file = join(ROOT, rel);
  const inside = file === ROOT || file.startsWith(ROOT + sep);
  let ok = inside && existsSync(file) && statSync(file).isFile();

  if (!ok && SPA && !extname(rel)) {
    file = join(ROOT, 'index.html');
    ok = existsSync(file);
  }
  if (!ok) {
    console.warn(`  404  ${p}`);
    return send(res, 404, 'not found');
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

// IPv6 が使えない環境があるので v4 の全インタフェースで listen する
server.listen(PORT, '0.0.0.0', () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}${BASE}${SPA ? '  (spa)' : ''}`);
});
