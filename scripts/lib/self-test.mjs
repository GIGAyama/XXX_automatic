/**
 * 検査そのものを確かめる。
 *
 * なぜ要るか:
 *   「0件でした」は、合格しているのか何も見ていないのかを区別できない。
 *   木ごと写して1か所ずつ壊し、狙った検査がちゃんと落ちることを確かめる。
 *   落ちない変異は「守るものが無い」証拠なので、そこで赤にする。
 *
 * ⚠️ 壊し方が当たらなかった（対象の文字列が無かった）場合も赤にする。
 *    黙って素通りさせると「確かめたつもり」が残り、いちばん危ない。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 壊しかたの一覧。正本の検査38件のうち、このリポジトリの木で壊せるものを並べる。
 *
 * ⚠️ 旧IDを機械的に置き換えただけの変異は当たらない。
 *    「正本が何を見ているか」を読んでから書くこと（standards/docs/gate-forks.md）。
 */
/** 配るスタイルシート。表示の検査は「このどこかにあればよい」を見る。 */
const CSS = ['docs/style.css', 'docs/apps.css'];

export const BREAKS = [
    // ── そろえておくもの
    { id: 'A_LICENSE', file: 'LICENSE', remove: true },
    { id: 'A_GITIGNORE', file: '.gitignore', remove: true },
    { id: 'A_DEPENDABOT', file: '.github/dependabot.yml', remove: true },
    { id: 'A_DOCS', file: 'MANUAL.md', remove: true },
    // ⚠️ replaceAll にすること。このファイルは1件目が「説明のコメント」で、
    //    replace だとそちらだけ置き換わり、本物の on: の下が残る。
    { id: 'A_CI_ON_PR', file: '.github/workflows/ci.yml', apply: (s) => s.replaceAll('pull_request', 'pull_request_DISABLED') },

    // ── 差しこまれたコードを止める
    {
        id: 'B_NO_CDN_CODE',
        file: 'docs/index.html',
        apply: (s) => s.replace('</head>', '  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n</head>'),
    },
    { id: 'B_CSP', file: 'docs/index.html', apply: (s) => s.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") },
    { id: 'B_NO_INLINE_SCRIPT', file: 'docs/index.html', apply: (s) => s.replace('</body>', '<script>window.x = 1;</script>\n</body>') },

    // ── 打ちかけを消さない
    { id: 'C_NO_LS_CLEAR', file: 'docs/app.js', apply: (s) => `${s}\nfunction __selftest() { localStorage.clear(); }\n` },
    { id: 'C_PAGEHIDE', file: 'docs/app.js', apply: (s) => s.replaceAll('pagehide', 'REMOVED-hide') },
    { id: 'C_NO_POSTMESSAGE_STAR', file: 'docs/app.js', apply: (s) => `${s}\nfunction __selftest2(w) { w.postMessage({ a: 1 }, '*'); }\n` },

    // ── 表示
    { id: 'D_VIEWPORT', file: 'docs/index.html', apply: (s) => s.replace(', viewport-fit=cover', '') },
    { id: 'D_VIEWPORT', file: 'docs/index.html', apply: (s) => s.replace('initial-scale=1,', 'initial-scale=1, user-scalable=no,') },
    { id: 'D_DVH', file: 'docs/style.css', apply: (s) => `${s}\n.__selftest { height: 100vh; }\n` },
    // ⚠️ 表示の4件は「配るスタイルのどこかにあればよい」という見かたである。
    //    1枚だけ壊しても、もう1枚が身代わりになって落ちない。
    //    このリポジトリは style.css と apps.css の2枚を配るので、両方こわす。
    { id: 'D_SAFE_AREA', files: CSS, apply: (s) => s.replaceAll('safe-area-inset', 'REMOVED-inset') },
    { id: 'D_FLUID_TYPE', files: CSS, apply: (s) => s.replace(/clamp\([^)]*\)/g, '18px') },
    { id: 'D_REDUCED_MOTION', files: CSS, apply: (s) => s.replaceAll('prefers-reduced-motion', 'prefers-REMOVED') },
    { id: 'D_FORCED_COLORS', files: CSS, apply: (s) => s.replaceAll('forced-colors', 'REMOVED-colors') },

    // ── 配信の形
    {
        id: 'E_MANIFEST_ID',
        file: 'docs/manifest.webmanifest',
        apply: (s) => s.replace(/"start_url"\s*:\s*"[^"]*"/, '"start_url": "/xxx_automatic/"'),
    },
    { id: 'E_CNAME', file: 'docs/CNAME', apply: (s) => `${s}extra.example.com\n` },
    { id: 'E_STALE_REPO_PATH', file: 'docs/index.html', apply: (s) => s.replace('</body>', '<script>const u = "/xxx_automatic/app.js";</script>\n</body>') },

    // ── アイコン
    //    ⚠️ 「manifest に並んでいる」と「ファイルが在る」は別。any の実体は
    //       2026-08-23 まで誰も読んでいなかった（正本 #61 で塞いだ）。
    { id: 'E_ICONS', file: 'docs/icons/icon-192.png', remove: true },
    { id: 'E_MASKABLE_SAFE_ZONE', file: 'docs/icons/maskable-512.png', remove: true },

    // ── インストールと Service Worker
    { id: 'E_INSTALL_HOOK', file: 'docs/index.html', apply: (s) => s.replace(/<script[^>]+src=["'][^"']*install-hook\.js["'][^>]*><\/script>/, '') },
    { id: 'E_SW_CACHE_SCOPE', file: 'docs/sw.js', apply: (s) => s.replace('.startsWith(', ' !== String(') },
    { id: 'E_SW_NO_LOCALSTORAGE', file: 'docs/sw.js', apply: (s) => `${s}\nself.addEventListener('sync', () => { localStorage.setItem('x', '1'); });\n` },
    {
        id: 'E_SW_NO_SKIP_WAITING_ON_INSTALL',
        file: 'docs/sw.js',
        apply: (s) => s.replace("self.addEventListener('install', (event) => {", "self.addEventListener('install', (event) => {\n  self.skipWaiting();"),
    },
    { id: 'E_SW_UPDATE_PROMPT', file: 'docs/app.js', apply: (s) => s.replaceAll('SKIP_WAITING', 'XXX_WAITING') },
    // ⚠️ このリポジトリは load を待たずに登録している。それ自体は正しい形なので、
    //    readyState を消しても見るものが無い。「load を待つのに見はりが無い」
    //    形に変えて落とす（読み込みずみで開くと登録がされない、という壊れ方）。
    {
        id: 'E_SW_REGISTER_READYSTATE',
        file: 'docs/app.js',
        apply: (s) => s.replace(
            "  navigator.serviceWorker\n    .register('sw.js')",
            "  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js'); });\n  navigator.serviceWorker\n    .register('sw.js')"
        ),
    },
    {
        id: 'E_SW_VERSION_GENERATED',
        file: 'docs/sw.js',
        apply: (s) => s.replace(/const VERSION = '([^']*)'; \/\* __APP_VERSION__ \*\//, "const VERSION = '$1';"),
    },
    { id: 'E_OFFLINE_HTML', file: 'docs/offline.html', remove: true },
    { id: 'E_SW_PRECACHE_OFFLINE', file: 'docs/sw.js', apply: (s) => s.replace("'./offline.html', ", '') },

    // ── 重さと画像
    // ⚠️ 入口の index.html に <img> は1枚も無い。画像を並べるのは apps.html である。
    //    index.html を狙っても「見るものが無い」ので、確かめたことにならない。
    { id: 'F_IMG_DIMENSIONS', file: 'docs/apps.html', apply: (s) => s.replace(/(<img\b[^>]*?)\s+width="[^"]*"\s+height="[^"]*"/, '$1') },
];

/**
 * @param {string} root リポジトリの根
 * @param {(root:string)=>{code:string,message:string}[]} failedIssuesOf
 *        木を渡すと「落ちた検査」を返す関数。⚠️ 設定はその木から読むこと。
 * @returns {boolean} すべての変異で落ちたか
 */
export function selfTest(root, failedIssuesOf) {
    console.log('== 品質ゲートの自己確認 ==');
    console.log('ファイルをわざと壊した写しを作り、対応する検査が落ちることを確かめます。\n');

    const base = failedIssuesOf(root);
    if (base.length > 0) {
        console.log('⚠️ もとの状態で落ちている検査があります。先にそちらを直してください。');
        for (const i of base) console.log(`   ❌ ${i.code} ${i.message}`);
        return false;
    }

    let bad = 0;
    for (const brk of BREAKS) {
        const dir = mkdtempSync(path.join(tmpdir(), 'giga-selftest-'));
        try {
            cpSync(root, dir, { recursive: true, filter: (src) => !/node_modules|\.git$|\.git\//.test(src) });
            let missed = false;
            for (const rel of brk.files ?? [brk.file]) {
                const target = path.join(dir, rel);
                if (brk.remove) {
                    rmSync(target, { force: true });
                    continue;
                }
                const before = readFileSync(target, 'utf8');
                const after = brk.apply(before);
                if (after === before) {
                    console.log(`⚠️ ${brk.id.padEnd(34)} 壊し方が当たっていません（${rel} に対象の文字列が無い）`);
                    missed = true;
                    break;
                }
                writeFileSync(target, after);
            }
            if (missed) { bad += 1; continue; }
            const found = failedIssuesOf(dir).some((i) => i.code === brk.id);
            if (found) {
                console.log(`✅ ${brk.id.padEnd(34)} 壊したら落ちた`);
            } else {
                console.log(`❌ ${brk.id.padEnd(34)} 壊したのに落ちませんでした（この検査は何も見ていない）`);
                bad += 1;
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    console.log(`\n${BREAKS.length - bad} / ${BREAKS.length} 件の検査が、壊したときに落ちることを確認しました。`);
    return bad === 0;
}
