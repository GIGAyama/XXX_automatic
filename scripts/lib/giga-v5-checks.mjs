/**
 * GIGA Standard v5（Part I）の検査。
 *
 * check-project.mjs の中身が「この仕組み固有の壊れ方」を見るのに対し、
 * こちらはフリート共通の、どのアプリでも同じ形で壊れるものだけを見る。
 * 別ファイルにしてあるのは、共通の検査が更新されたときに
 * このファイルごと差し替えて受けられるようにするためである。
 *
 * ⚠️ ここに書く検査は、必ず「わざと壊して落ちること」を確かめてから足す。
 *    「0件でした」は、合格しているのか何も見ていないのかを区別できない。
 *    実際、この形の検査は次の3つで取りこぼしと誤検知を出したことがある。
 *      ・削除式を正規表現で追うと `(k) => caches.delete(k)` を見落とす
 *        → 「消す式」ではなく「startsWith で絞る式があるか」を見る
 *      ・「localStorage は操作しない」という注意書きに反応する
 *        → 判定の前にコメントを落とす
 *      ・`@supports not (height: 100dvh) { … 100vh }` を素通しできない
 *        → 100vh の前方も見る
 *
 * ⚠️ 静的に読めることしか見ていない。
 *    コントラスト・タップ領域・実際に登録されるか・押したら切り替わるかは
 *    ここでは分からない。tools/measure-ui.mjs と tools/measure-pwa.mjs で測る。
 */
import fs from 'node:fs';
import path from 'node:path';

/** /* … *​/ と // … を落とす。注意書きの文言に反応しないようにするため。 */
export function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 名前付きのリスナー本体を取り出す。
 * addEventListener('install', … ) の … を、括弧の対応を数えて切り出す。
 * 正規表現で「それらしい範囲」を取ると、入れ子の関数で簡単に取り違える。
 */
export function handlerBody(source, event) {
    const head = `addEventListener('${event}'`;
    const at = source.indexOf(head);
    if (at < 0) return null;
    // ⚠️ 数えはじめるのは addEventListener の開き括弧である。
    //    イベント名の終わりの引用符から数えると、最初に見つかる ( が
    //    コールバックの引数リストになり、`addEventListener('install', (event)` までしか
    //    取り出せない。中身を見ているつもりで何も見ていない状態になる（実際にそうなった）。
    const open = at + 'addEventListener'.length;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const c = source[i];
        if (c === '(') depth += 1;
        else if (c === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(at, i + 1);
        }
    }
    return null;
}

/**
 * `100vh` のうち、`@supports not (height: 100dvh)` のフォールバックでないものを探す。
 * dvh を先に書いて @supports で受けるのが正しい形なので、そこは通す。
 */
export function bareViewportHeights(css) {
    const found = [];
    const lines = stripComments(css).split('\n');
    // @supports not (height: 100dvh) { … } の中にいるあいだは数えない
    let guardDepth = null;
    let depth = 0;
    for (const [index, line] of lines.entries()) {
        const opensGuard = /@supports\s+not\s*\(\s*height\s*:\s*100dvh\s*\)/.test(line);
        if (opensGuard) guardDepth = depth;
        depth += (line.match(/{/g) ?? []).length;
        depth -= (line.match(/}/g) ?? []).length;
        if (guardDepth !== null && depth <= guardDepth) {
            guardDepth = null;
            continue;
        }
        if (guardDepth !== null) continue;
        if (/\b100vh\b/.test(line)) found.push({ line: index + 1, text: line.trim() });
    }
    return found;
}

/** prefers-reduced-motion のブロックを取り出す（波かっこの対応を数える）。 */
export function reducedMotionBlocks(css) {
    const blocks = [];
    const src = stripComments(css);
    const re = /@media[^{]*prefers-reduced-motion[^{]*{/g;
    let m;
    while ((m = re.exec(src))) {
        let depth = 1;
        let i = re.lastIndex;
        for (; i < src.length && depth > 0; i += 1) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
        }
        blocks.push(src.slice(re.lastIndex, i - 1));
    }
    return blocks;
}

/**
 * Part I の検査を走らせる。
 * @param {object} opts
 * @param {string} opts.root リポジトリの根
 * @returns {{severity:'error'|'warning', code:string, message:string, file:string}[]}
 */
export function runGigaChecks({ root }) {
    const issues = [];
    const at = (...p) => path.join(root, ...p);
    const relative = (p) => path.relative(root, p).split(path.sep).join('/');
    const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
    const error = (code, message, file) => issues.push({ severity: 'error', code, message, file });
    const warn = (code, message, file) => issues.push({ severity: 'warning', code, message, file });

    const htmlFiles = fs.existsSync(at('docs'))
        ? fs
              .readdirSync(at('docs'))
              .filter((f) => f.endsWith('.html'))
              .map((f) => at('docs', f))
        : [];
    const cssFiles = fs.existsSync(at('docs'))
        ? fs
              .readdirSync(at('docs'))
              .filter((f) => f.endsWith('.css'))
              .map((f) => at('docs', f))
        : [];

    /* ── Service Worker ───────────────────────────── */

    const swPath = at('docs', 'sw.js');
    const swRaw = read(swPath);
    if (swRaw === null) {
        error('SW_MISSING', 'docs/sw.js がありません', 'docs/sw.js');
    } else {
        const sw = stripComments(swRaw);

        // ⚠️ 「消している式」を探さない。`(k) => caches.delete(k)` のような書き方を見落とす。
        //    見るのは「自アプリ分だけに絞る式があるか」である。
        const activate = handlerBody(sw, 'activate');
        if (activate && /caches\s*\.\s*keys\s*\(/.test(activate) && !/startsWith\s*\(/.test(activate)) {
            error(
                'SW_CACHE_WIPE',
                'activate が caches.keys() を絞りこまずに扱っています。' +
                    'gigayama.github.io は同一オリジンを多数のアプリで共有しているので、' +
                    '自アプリの接頭辞で startsWith して絞ってください（他アプリが圏外で起動しなくなります）',
                'docs/sw.js'
            );
        }

        const install = handlerBody(sw, 'install');
        if (install && /skipWaiting\s*\(/.test(install)) {
            error(
                'SW_SKIP_WAITING_INSTALL',
                'install の中で skipWaiting() しています。' +
                    '書きかけの本文が画面ごと入れかわって消えます。画面から SKIP_WAITING を受けて切りかえてください',
                'docs/sw.js'
            );
        }

        if (!/addEventListener\s*\(\s*'message'/.test(sw) || !/SKIP_WAITING/.test(sw)) {
            error(
                'SW_NO_UPDATE_PATH',
                'SKIP_WAITING を受ける message のリスナーがありません。' +
                    '待機中の新しい版を切りかえる手段が無く、［さいしんに する］を押しても何も起きません',
                'docs/sw.js'
            );
        }

        if (/localStorage/.test(sw)) {
            error('SW_LOCALSTORAGE', 'Service Worker が localStorage に触れています', 'docs/sw.js');
        }
    }

    /* ── 更新の受けとり方（画面側）───────────────────── */

    const appPath = at('docs', 'app.js');
    const appRaw = read(appPath);
    if (appRaw !== null) {
        const app = stripComments(appRaw);
        if (/controllerchange/.test(app)) {
            const at0 = app.indexOf('controllerchange');
            const body = app.slice(at0, at0 + 600);
            // ⚠️ 「もともと管理下だったか」で分けるのは駄目。見るのは「利用者が押したか」だけ。
            //    押した印を持たずに reload していたら、初回訪問が必ず1回リロードされる。
            if (/location\s*\.\s*reload/.test(body) && !/(asked|requested|accepted|userAsked)/i.test(body)) {
                error(
                    'SW_RELOAD_UNGUARDED',
                    'controllerchange を無条件に受けて reload しています。' +
                        'clients.claim() で初回訪問にも飛んでくるため、はじめて開いた人が必ず1回リロードされます。' +
                        '「利用者が押したか」の印で分けてください',
                    'docs/app.js'
                );
            }
        }
        if (swRaw !== null && /SKIP_WAITING/.test(swRaw) && !/SKIP_WAITING/.test(app)) {
            error(
                'SW_NO_UPDATE_PROMPT',
                'sw.js は SKIP_WAITING を待っていますが、画面側から送っていません。新しい版が永久に待機したままになります',
                'docs/app.js'
            );
        }
        if (!/pagehide/.test(app)) {
            warn(
                'NO_PAGEHIDE',
                'pagehide での確定保存がありません。Chromebook はメモリ不足でタブを黙って捨てるので、打ちかけの入力が消えます',
                'docs/app.js'
            );
        }
    }

    /* ── viewport ─────────────────────────────────── */

    for (const file of htmlFiles) {
        const html = read(file);
        const meta = html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i)?.[0];
        if (!meta) {
            error('VIEWPORT_MISSING', 'viewport の meta がありません', relative(file));
            continue;
        }
        if (!/viewport-fit\s*=\s*cover/.test(meta)) {
            error('VIEWPORT_FIT', 'viewport に viewport-fit=cover がありません（ノッチ側が欠けます）', relative(file));
        }
        if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(meta)) {
            error(
                'VIEWPORT_NO_ZOOM',
                '拡大を禁止しています。誤ズームより、見えづらい人が拡大できない害のほうが大きいので外してください',
                relative(file)
            );
        }
    }

    /* ── 表示（CSS）───────────────────────────────── */

    for (const file of [...cssFiles, ...htmlFiles]) {
        const source = read(file);
        for (const hit of bareViewportHeights(source)) {
            error(
                'VIEWPORT_100VH',
                `${hit.line} 行目で 100vh を単独で使っています。スマホのアドレスバーのぶんだけはみ出します。` +
                    '100dvh を先に書き、@supports not (height: 100dvh) で受けてください',
                relative(file)
            );
        }
        for (const block of reducedMotionBlocks(source)) {
            // ⚠️ 0 や none にすると animation-fill-mode: forwards が効かなくなり、
            //    「動きを止める」つもりが「中身が消える」になる。.01ms でなければならない。
            if (/animation\s*:\s*none|animation-duration\s*:\s*0m?s|transition-duration\s*:\s*0m?s|transition\s*:\s*none/.test(block)) {
                error(
                    'MOTION_ZERO',
                    'prefers-reduced-motion で動きを 0（または none）にしています。' +
                        'animation-fill-mode: forwards が効かなくなり、fadeIn 系の要素が opacity: 0 のまま消えます。.01ms にしてください',
                    relative(file)
                );
            }
        }
    }

    for (const file of cssFiles) {
        if (!/@media\s*\(forced-colors:\s*active\)/.test(read(file))) {
            warn(
                'NO_FORCED_COLORS',
                'forced-colors（ハイコントラストモード）の手当てがありません。塗りが無効化されると、選んでいるものが分からなくなります',
                relative(file)
            );
        }
    }

    /* ── アイコン ─────────────────────────────────── */

    const appleIcon = at('docs', 'icons', 'apple-touch-icon.png');
    if (fs.existsSync(appleIcon)) {
        const buffer = fs.readFileSync(appleIcon);
        // colorType 2 = RGB（アルファ無し）。4/6 はアルファあり、tRNS は透明色の指定。
        // iOS は透明を黒で埋めるので、ホーム画面でアイコンの四隅だけが黒く出る。
        const colorType = buffer[25];
        const hasTrns = buffer.includes(Buffer.from('tRNS', 'ascii'));
        if (colorType === 4 || colorType === 6 || hasTrns) {
            warn(
                'APPLE_ICON_ALPHA',
                'apple-touch-icon に透明を持てる形式が使われています。iOS は透明を黒で埋めるため、' +
                    '四隅だけが黒く出ることがあります（画素まで見ていないので、実際に透明かは tools/measure-* で確かめてください）',
                'docs/icons/apple-touch-icon.png'
            );
        }
    } else {
        error('APPLE_ICON_MISSING', 'apple-touch-icon.png がありません', 'docs/icons/apple-touch-icon.png');
    }

    const manifestRaw = read(at('docs', 'manifest.webmanifest'));
    if (manifestRaw) {
        try {
            const manifest = JSON.parse(manifestRaw);
            const maskable = (manifest.icons ?? []).filter((i) => String(i.purpose ?? '').includes('maskable'));
            if (maskable.length < 2) {
                error(
                    'MASKABLE_MISSING',
                    'maskable のアイコンが 192 / 512 の2つ揃っていません（Android で丸く切り抜かれたときに絵が欠けます）',
                    'docs/manifest.webmanifest'
                );
            }
            for (const icon of manifest.icons ?? []) {
                if (!fs.existsSync(at('docs', icon.src))) {
                    error('ICON_MISSING', `manifest が指す ${icon.src} がありません`, 'docs/manifest.webmanifest');
                }
            }
        } catch (e) {
            error('MANIFEST_UNREADABLE', e.message, 'docs/manifest.webmanifest');
        }
    }

    return issues;
}
