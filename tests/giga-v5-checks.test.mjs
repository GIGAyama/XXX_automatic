/**
 * GIGA Standard v5（Part I）の検査そのものを試す。
 *
 * ⚠️ この検査は「0件でした」だけでは信用できない。
 *    合格しているのか、何も見ていないのかを区別できないためである。
 *    だから、正しい形が通ることと、わざと壊した形が落ちることの両方を見る。
 *    実際、この形の検査は取りこぼしと誤検知を出したことがある
 *    （削除式を正規表現で追う／注意書きの文言に反応する／@supports を素通しできない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bareViewportHeights, handlerBody, reducedMotionBlocks, runGigaChecks, stripComments } from '../scripts/lib/giga-v5-checks.mjs';

/* ── 正しい形の一式。ここから1か所ずつ壊していく ────────── */

const GOOD_SW = `
/* Service Worker は localStorage を一切操作しない。 */
const CACHE_PREFIX = 'launcher-';
const SHELL_CACHE = CACHE_PREFIX + 'shell-v1';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(['./'])));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
});
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
`;

const GOOD_APP = `
let userAskedUpdate = false;
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (!userAskedUpdate) return;
  location.reload();
});
worker.postMessage({ type: 'SKIP_WAITING' });
window.addEventListener('pagehide', saveOpenDrafts);
`;

const GOOD_HTML = `<!doctype html><html lang="ja"><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head><body></body></html>`;

const GOOD_CSS = `
body { min-height: 100dvh; }
@supports not (height: 100dvh) { body { min-height: 100vh; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
@media (forced-colors: active) { .btn { border: 2px solid ButtonText; } }
`;

const GOOD_MANIFEST = JSON.stringify({
    icons: [
        { src: 'icons/icon-192.png', purpose: 'any' },
        { src: 'icons/maskable-192.png', purpose: 'maskable' },
        { src: 'icons/maskable-512.png', purpose: 'maskable' },
    ],
});

/** アルファを持たない最小の PNG ヘッダ（colorType 2）。実画像である必要は無い。 */
function pngWithoutAlpha() {
    const buffer = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.write('IHDR', 12, 'ascii');
    buffer[24] = 8; // bit depth
    buffer[25] = 2; // color type: RGB（アルファ無し）
    return buffer;
}

/** 一式を temp に書き出して、壊しかたを1つだけ当てる。 */
function build(mutate = () => {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-v5-'));
    const files = {
        'docs/sw.js': GOOD_SW,
        'docs/app.js': GOOD_APP,
        'docs/index.html': GOOD_HTML,
        'docs/style.css': GOOD_CSS,
        'docs/manifest.webmanifest': GOOD_MANIFEST,
    };
    mutate(files);
    for (const [name, body] of Object.entries(files)) {
        const full = path.join(root, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    const icons = path.join(root, 'docs', 'icons');
    fs.mkdirSync(icons, { recursive: true });
    for (const name of ['apple-touch-icon.png', 'icon-192.png', 'maskable-192.png', 'maskable-512.png']) {
        fs.writeFileSync(path.join(icons, name), pngWithoutAlpha());
    }
    return root;
}

const codesOf = (root) => runGigaChecks({ root }).map((i) => i.code);

test('正しい形なら何も出ない', () => {
    assert.deepEqual(codesOf(build()), []);
});

/* ── ここから「わざと壊す」 ───────────────────────── */

test('activate が絞りこまずに消していたら落ちる（他アプリの巻き添え）', () => {
    const root = build((f) => {
        f['docs/sw.js'] = f['docs/sw.js'].replace(
            'keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== SHELL_CACHE)',
            'keys.filter((k) => k !== SHELL_CACHE)'
        );
    });
    assert.ok(codesOf(root).includes('SW_CACHE_WIPE'));
});

test('削除が矢印関数で書いてあっても見落とさない', () => {
    // ⚠️ 「消す式」を正規表現で追うと、この形を取りこぼす。
    //    見るのは startsWith で絞る式があるかどうかである。
    const root = build((f) => {
        f['docs/sw.js'] = f['docs/sw.js'].replace(
            'keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== SHELL_CACHE).map((k) => caches.delete(k))',
            'keys.map((k) => caches.delete(k))'
        );
    });
    assert.ok(codesOf(root).includes('SW_CACHE_WIPE'));
});

test('install の中で skipWaiting していたら落ちる', () => {
    // 文字列を継ぎ足すと括弧の対応が狂って、別の理由で落ちたのか分からなくなる。
    // install のリスナーごと書きかえる。
    const root = build((f) => {
        f['docs/sw.js'] = f['docs/sw.js'].replace(
            "self.addEventListener('install', (event) => {\n  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(['./'])));\n});",
            "self.addEventListener('install', (event) => {\n  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(['./'])).then(() => self.skipWaiting()));\n});"
        );
    });
    assert.ok(codesOf(root).includes('SW_SKIP_WAITING_INSTALL'));
});

test('message で SKIP_WAITING を受けていなければ落ちる（押しても何も起きない）', () => {
    const root = build((f) => {
        f['docs/sw.js'] = f['docs/sw.js'].replace(/self\.addEventListener\('message'[\s\S]*$/, '');
        f['docs/app.js'] = f['docs/app.js'].replace(/worker\.postMessage[^\n]*\n/, '');
    });
    assert.ok(codesOf(root).includes('SW_NO_UPDATE_PATH'));
});

test('sw.js は待っているのに画面から送っていなければ落ちる', () => {
    const root = build((f) => {
        f['docs/app.js'] = f['docs/app.js'].replace(/worker\.postMessage[^\n]*\n/, '');
    });
    assert.ok(codesOf(root).includes('SW_NO_UPDATE_PROMPT'));
});

test('localStorage を操作していたら落ちる', () => {
    const root = build((f) => {
        f['docs/sw.js'] += "localStorage.setItem('x', '1');\n";
    });
    assert.ok(codesOf(root).includes('SW_LOCALSTORAGE'));
});

test('「localStorage は操作しない」という注意書きには反応しない', () => {
    // ⚠️ 実際に踏んだ誤検知。判定の前にコメントを落としているかを見ている。
    const root = build((f) => {
        f['docs/sw.js'] += '// ここでは localStorage を使わない\n';
    });
    assert.ok(!codesOf(root).includes('SW_LOCALSTORAGE'));
});

test('controllerchange を無条件に受けて reload していたら落ちる', () => {
    const root = build((f) => {
        f['docs/app.js'] = f['docs/app.js'].replace('if (!userAskedUpdate) return;', '');
        f['docs/app.js'] = f['docs/app.js'].replace('let userAskedUpdate = false;', '');
    });
    assert.ok(codesOf(root).includes('SW_RELOAD_UNGUARDED'));
});

test('pagehide での確定保存が無ければ知らせる', () => {
    const root = build((f) => {
        f['docs/app.js'] = f['docs/app.js'].replace(/window\.addEventListener\('pagehide'[^\n]*\n/, '');
    });
    assert.ok(codesOf(root).includes('NO_PAGEHIDE'));
});

test('viewport-fit=cover が無ければ落ちる', () => {
    const root = build((f) => {
        f['docs/index.html'] = f['docs/index.html'].replace(', viewport-fit=cover', '');
    });
    assert.ok(codesOf(root).includes('VIEWPORT_FIT'));
});

test('拡大を禁止していたら落ちる', () => {
    const root = build((f) => {
        f['docs/index.html'] = f['docs/index.html'].replace('viewport-fit=cover', 'viewport-fit=cover, user-scalable=no');
    });
    assert.ok(codesOf(root).includes('VIEWPORT_NO_ZOOM'));
});

test('100vh を単独で使っていたら落ちる', () => {
    const root = build((f) => {
        f['docs/style.css'] = 'body { min-height: 100vh; }\n';
    });
    assert.ok(codesOf(root).includes('VIEWPORT_100VH'));
});

test('@supports のフォールバックの 100vh は通す', () => {
    // ⚠️ 実際に踏んだ誤検知。100vh の前方を見ていないと、正しい形まで落とす。
    assert.deepEqual(bareViewportHeights(GOOD_CSS), []);
    assert.ok(!codesOf(build()).includes('VIEWPORT_100VH'));
});

test('動きを 0 や none にしていたら落ちる', () => {
    for (const bad of ['animation: none !important;', 'animation-duration: 0s !important;', 'transition-duration: 0ms !important;']) {
        const root = build((f) => {
            f['docs/style.css'] = f['docs/style.css'].replace(
                '*, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }',
                `* { ${bad} }`
            );
        });
        assert.ok(codesOf(root).includes('MOTION_ZERO'), bad);
    }
});

test('forced-colors の手当てが無ければ知らせる', () => {
    const root = build((f) => {
        f['docs/style.css'] = f['docs/style.css'].replace(/@media \(forced-colors[^\n]*\n/, '');
    });
    assert.ok(codesOf(root).includes('NO_FORCED_COLORS'));
});

test('maskable が2つ揃っていなければ落ちる', () => {
    const root = build((f) => {
        f['docs/manifest.webmanifest'] = JSON.stringify({ icons: [{ src: 'icons/icon-192.png', purpose: 'any' }] });
    });
    assert.ok(codesOf(root).includes('MASKABLE_MISSING'));
});

test('manifest が指すアイコンが無ければ落ちる', () => {
    const root = build((f) => {
        const manifest = JSON.parse(f['docs/manifest.webmanifest']);
        manifest.icons.push({ src: 'icons/icon-999.png', purpose: 'any' });
        f['docs/manifest.webmanifest'] = JSON.stringify(manifest);
    });
    assert.ok(codesOf(root).includes('ICON_MISSING'));
});

test('apple-touch-icon が透明を持てる形式なら知らせる', () => {
    const root = build();
    const buffer = pngWithoutAlpha();
    buffer[25] = 6; // color type: RGBA
    fs.writeFileSync(path.join(root, 'docs', 'icons', 'apple-touch-icon.png'), buffer);
    assert.ok(codesOf(root).includes('APPLE_ICON_ALPHA'));
});

/* ── 部品そのもの ─────────────────────────────── */

test('stripComments はブロックと行のコメントを落とす', () => {
    assert.equal(stripComments('/* localStorage */ a').trim(), 'a');
    assert.equal(stripComments('a // localStorage').trim(), 'a');
    // URL の // を消してしまうと、別のところで誤判定が起きる
    assert.match(stripComments("const u = 'https://example.com';"), /https:\/\/example\.com/);
});

test('handlerBody は括弧の対応でリスナー本体を切り出す', () => {
    const body = handlerBody("addEventListener('install', (e) => { f(g(h())); });", 'install');
    assert.match(body, /f\(g\(h\(\)\)\)/);
    assert.equal(handlerBody('', 'install'), null);
});

test('reducedMotionBlocks は入れ子の波かっこを数える', () => {
    const blocks = reducedMotionBlocks('@media (prefers-reduced-motion: reduce) { a { b: c; } }');
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /b: c/);
});
