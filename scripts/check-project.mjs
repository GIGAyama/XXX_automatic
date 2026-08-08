#!/usr/bin/env node
/**
 * 品質ゲート。
 *
 *   node scripts/check-project.mjs
 *
 * このリポジトリはアプリではなく道具箱なので、フリート共通の GIGA Standard 検査
 * （単一 HTML アプリ向けの entryHtml / assetLimits など）はそのままでは当てはまらない。
 * ここは「この仕組みが静かに壊れる典型的な壊れ方」だけを見る、専用の検査である。
 *
 * ⚠️ この検査は「0件でした」だけでは信用できない。
 *    検査が動いているのか、何も見ていないのかを区別できないためである。
 *    わざと壊して落ちることを確かめてから信じること。
 */
import fs from 'node:fs';
import path from 'node:path';
import { shellFilesOf, versionOf } from './build-sw.mjs';
import { describeModel, readPolicy } from './lib/gemini-models.mjs';
import { ROOT, paths, readJson, readText, rel } from './lib/io.mjs';
import { isoWeekId, jstDateString, nextWeekDates } from './lib/jst.mjs';
import { extractUrls } from './lib/x-text.mjs';
import { KEEP_WEEKS } from './archive-history.mjs';
import { lintArticle } from './lib/note-lint.mjs';
import { inspectCard, readHeader } from './lib/png.mjs';
import { CARD_SIZE } from './lib/card-template.mjs';

const issues = [];

function error(code, message, file) {
    issues.push({ severity: 'error', code, message, file });
}
function warn(code, message, file) {
    issues.push({ severity: 'warning', code, message, file });
}

/* ── 1. 揃っているべきファイル ───────────────────────── */

const REQUIRED = [
    'README.md',
    'MANUAL.md',
    'LICENSE',
    'CLAUDE.md',
    'package.json',
    'config/accounts.json',
    'config/slots.json',
    'config/themes.json',
    'config/guardrails.json',
    'config/monetization.json',
    'config/media.json',
    'config/audience.json',
    'config/calendar.json',
    'config/note-style.json',
    'scripts/lib/jst.mjs',
    'docs/index.html',
    'docs/app.js',
    'docs/style.css',
    'docs/sw.js',
    'docs/offline.html',
    'docs/manifest.webmanifest',
    'docs/install-hook.js',
    'docs/apps.html',
    'docs/apps.css',
    'docs/lib/jst-client.js',
    'docs/lib/select.js',
    'docs/lib/state.js',
    'docs/lib/format.js',
    'docs/lib/x-length.js',
    'docs/lib/feedback-payload.js',
    '.github/workflows/weekly.yml',
    '.github/workflows/daily-notify.yml',
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/reply-draft.yml',
];

for (const file of REQUIRED) {
    if (!fs.existsSync(path.join(ROOT, file))) error('MISSING_FILE', '必要なファイルがありません', file);
}

/* ── 2. basePath の一致 ──────────────────────────────
 * gigayama.github.io は多数のアプリが同一オリジンを共有している。
 * manifest の id / scope / start_url がリポジトリ名からずれると、
 * 別アプリと取り違えられて「開いたら違うアプリが立ち上がる」事故になる。
 * リポジトリ名を変えたときにここを直し忘れるのが、いちばんありそうな壊れ方である。 */

try {
    const accounts = readJson(paths.config('accounts.json'));
    const manifest = readJson(paths.docs('manifest.webmanifest'));
    const expected = `/${accounts.repoName}/`;

    for (const key of ['id', 'start_url', 'scope']) {
        if (manifest[key] !== expected) {
            error(
                'BASE_PATH_MISMATCH',
                `manifest の ${key} が "${manifest[key]}" ですが、config/accounts.json の repoName からは "${expected}" になるはずです`,
                'docs/manifest.webmanifest'
            );
        }
    }

    if (accounts.launcherUrl && !accounts.launcherUrl.endsWith(expected)) {
        error(
            'BASE_PATH_MISMATCH',
            `launcherUrl が "${accounts.launcherUrl}" ですが、repoName からは "${expected}" で終わるはずです`,
            'config/accounts.json'
        );
    }
} catch (e) {
    error('CONFIG_UNREADABLE', e.message, 'config/accounts.json');
}

/* ── 3. 日付を JST 以外で扱っていないか ─────────────────
 * これがこの仕組みでいちばん起こりやすく、いちばん気づきにくいバグである。
 * cron は UTC で動くので、素の new Date() から日付を取り出すと
 * 日本時間の 0:00〜9:00 のあいだ前日の日付になる。
 * 参考にした記事の著者も、まさにここで事故を起こしている。 */

// 「暦の上の日付」をローカル時刻から取り出すものだけを見る。
//   new Date().toISOString()               … UTC の瞬間そのもの。記録用として正しいので通す
//   new Date().toISOString().slice(0, 10)  … そこから日付を切り出している。9時間ずれる。落とす
//   new Date().getDate()                   … 実行環境のタイムゾーン依存。落とす
const DATE_FROM_RAW_NOW = [
    /new Date\([^)]*\)\.(getDate|getDay|getMonth|getFullYear|getHours)\s*\(/,
    /\.toISOString\(\)\s*\.(slice|substring|substr)\s*\(/,
    /\.toISOString\(\)\s*\.split\s*\(\s*['"]T['"]/,
];

// ⚠️ docs/ も歩く。
//    以前は scripts/ しか見ていなかったので、docs/app.js の
//    `jst.toISOString().slice(0, 10)` が素通りしていた（+9h を足してあるので
//    結果は正しかったが、誰かが将来そこを触っても誰も気づけない状態だった）。
for (const file of [...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, 'docs'))]) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue;
    // 3つだけ例外がある。
    //   scripts/lib/jst.mjs      … JST を定義している本人。ここで new Date() を使うのは当たり前
    //   docs/lib/jst-client.js   … ブラウザ側の同じ役目。tests が両者の一致を確かめている
    //   check-project.mjs        … 検査の正規表現そのものを含むので、必ず自分に当たる
    if (file.endsWith(path.join('lib', 'jst.mjs'))) continue;
    if (file.endsWith(path.join('lib', 'jst-client.js'))) continue;
    if (file.endsWith(path.join('scripts', 'check-project.mjs'))) continue;

    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
        if (DATE_FROM_RAW_NOW.some((re) => re.test(line))) {
            error(
                'RAW_DATE',
                `${i + 1}行目で new Date() から直接 日付を取り出しています。scripts/lib/jst.mjs を使ってください（cron は UTC なので9時間ずれます）`,
                rel(file)
            );
        }
    });
}

/* ── 4. 秘密情報が混ざっていないか ──────────────────────
 * config/ と docs/ はリポジトリに入り、docs/ は公開される。
 * API キーを一度でも push すると、消しても履歴に残る。 */

const SECRET_PATTERNS = [
    { re: /AIza[0-9A-Za-z_-]{20,}/, what: 'Google/Gemini の API キーらしき文字列' },
    { re: /gh[pousr]_[0-9A-Za-z]{20,}/, what: 'GitHub のトークンらしき文字列' },
    { re: /discord(app)?\.com\/api\/webhooks\/\d+\//i, what: 'Discord の Webhook URL' },
];

for (const dir of ['config', 'docs']) {
    for (const file of walk(path.join(ROOT, dir))) {
        if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const { re, what } of SECRET_PATTERNS) {
            if (re.test(text)) error('SECRET_IN_REPO', `${what}が入っています。GitHub Secrets に移してください`, rel(file));
        }
    }
}

/* ── 5. ガードレールが空になっていないか ────────────────
 * 禁止パターンが空でも検査は「合格」を返す。
 * それは検査が通っているのではなく、何も見ていないだけである。 */

try {
    const guardrails = readJson(paths.config('guardrails.json'));
    if ((guardrails.forbiddenPatterns ?? []).length === 0) {
        error(
            'EMPTY_GUARDRAILS',
            'forbiddenPatterns が空です。この状態だと検査は必ず合格になり、何も守っていません',
            'config/guardrails.json'
        );
    }
    for (const rule of guardrails.forbiddenPatterns ?? []) {
        try {
            new RegExp(rule.pattern, 'iu');
        } catch (e) {
            error('BAD_REGEX', `正規表現が壊れています（${rule.pattern}）: ${e.message}`, 'config/guardrails.json');
        }
    }
} catch (e) {
    error('CONFIG_UNREADABLE', e.message, 'config/guardrails.json');
}

/* ── 6. ランチャーが外部を読みにいっていないか ──────────
 * 学校のネットワークは CDN を塞いでいることがある。
 * このフリート共通の方針でもある。 */

// ⚠️ 見るのは「読みこむもの」だけ。<a href> のリンク先は対象外にする。
//    アプリ一覧ページは各アプリへのリンクが本体なので、
//    href をまとめて弾くと 52 件ぜんぶがエラーになって検査そのものが使えなくなる。
//    読みこむのは src=... と、<link ...> の href（スタイルシートなど）である。
const LOADS_EXTERNAL = [
    /\bsrc\s*=\s*"https?:\/\/[^"]+"/gi,
    /<link\b[^>]*\bhref\s*=\s*"https?:\/\/[^"]+"[^>]*>/gi,
    /@import\s+(?:url\()?["']https?:\/\//gi,
];

for (const name of ['index.html', 'apps.html', 'offline.html']) {
    const html = readText(paths.docs(name), null);
    if (html === null) continue; // 無いことは 1. で報告ずみ

    // offline.html は圏外で出す最小の画面。CSP を持たない代わりに外部も読まない。
    if (name !== 'offline.html' && !/Content-Security-Policy/i.test(html)) {
        warn('NO_CSP', 'CSP の指定がありません', `docs/${name}`);
    }
    for (const re of LOADS_EXTERNAL) {
        for (const hit of html.match(re) ?? []) {
            error('EXTERNAL_ASSET', `外部から読みこんでいます（${hit.slice(0, 120)}）。同梱してください`, `docs/${name}`);
        }
    }

    // 相対パスで指しているファイルが実在するか。綴りを1文字まちがえると白い画面になる。
    for (const hit of html.matchAll(/(?:src|href)\s*=\s*"(?!https?:|data:|#|mailto:)([^"]+)"/gi)) {
        const target = paths.docs(hit[1].split(/[?#]/)[0]);
        if (!fs.existsSync(target)) {
            error('BROKEN_LOCAL_REF', `参照先が見つかりません（${hit[1]}）`, `docs/${name}`);
        }
    }
}

/* ── 7. Service Worker が launcher.json をキャッシュしていないか ──
 * ここをキャッシュすると「新しい週の投稿がいつまでも出てこない」という、
 * 原因がとても分かりにくい症状になる。 */

try {
    const sw = fs.readFileSync(paths.docs('sw.js'), 'utf8');
    const shellLine = /const SHELL\s*=\s*\[([^\]]*)\]/s.exec(sw);
    if (shellLine && shellLine[1].includes('launcher.json')) {
        error(
            'LAUNCHER_JSON_CACHED',
            'launcher.json を SHELL に入れています。毎週内容が変わるファイルなので、キャッシュすると新しい投稿が出てきません',
            'docs/sw.js'
        );
    }
} catch {
    // 1. で報告ずみ
}

/* ── 8. Service Worker のシェルが実在し、版が中身と合っているか ──
 * cache.addAll は1つでも 404 があると全部失敗する（sw.js 自身がそう警告している）。
 * そして VERSION がシェルの中身とずれていると、直した画面が端末に届かない。
 * どちらも「動いているように見えるのに直っていない」という、いちばん時間を溶かす壊れ方をする。 */

try {
    const sw = fs.readFileSync(paths.docs('sw.js'), 'utf8');
    const files = shellFilesOf(sw, paths.docs());

    const missing = files.filter(({ file }) => !fs.existsSync(file));
    for (const { entry } of missing) {
        error('SW_SHELL_MISSING', `SHELL の "${entry}" がありません。1つでも欠けると addAll が全部失敗します`, 'docs/sw.js');
    }

    if (missing.length === 0) {
        const expected = versionOf(files);
        const current = /const VERSION = '([^']*)';/.exec(sw)?.[1];
        if (current !== expected) {
            error(
                'SW_VERSION_STALE',
                `VERSION が中身と合っていません（いま ${current} / あるべき ${expected}）。\`npm run build:sw\` を実行してください`,
                'docs/sw.js'
            );
        }
    }
} catch (e) {
    error('SW_UNREADABLE', e.message, 'docs/sw.js');
}

/* ── 9. 画像とアイコンが実在するか ────────────────────
 * launcher.json が指す画像が 404 だと、共有シートに画像が乗らない。
 * しかも画面には何も出ないので、気づくのは投稿したあとになる。 */

const launcher = readJson(paths.docs('launcher.json'), null);
if (launcher) {
    const seen = new Set();
    for (const post of launcher.posts ?? []) {
        for (const src of post.mediaList ?? (post.media ? [post.media] : [])) {
            if (seen.has(src)) continue;
            seen.add(src);
            if (!fs.existsSync(paths.docs(src))) {
                error('MISSING_MEDIA', `launcher.json が指す画像がありません（${src} / ${post.id}）`, 'docs/launcher.json');
            }
        }
    }

    /* 添付できる画像の一覧（galleries）。
     * ここに載る repo の画像は raw.githubusercontent.com を直接読む。
     * ランチャーが他所のドメインに取りにいく唯一の場所なので、行き先を確かめる。
     * 生成物とはいえ、外から来たパスがそのまま URL になっているためである。 */
    const owner = readJson(paths.config('accounts.json'), {}).githubOwner ?? '';
    const allowed = `https://raw.githubusercontent.com/${owner}/`;
    for (const [repo, items] of Object.entries(launcher.galleries ?? {})) {
        const ids = new Set();
        for (const item of items) {
            if (ids.has(item.id)) {
                error('DUPLICATE_MEDIA_ID', `galleries の id が重複しています（${repo} / ${item.id}）`, 'docs/launcher.json');
            }
            ids.add(item.id);

            if (item.kind === 'repo') {
                if (!String(item.src).startsWith(allowed)) {
                    error(
                        'FOREIGN_MEDIA',
                        `添付候補が想定外の場所を指しています（${repo} / ${item.src}）。ランチャーは ${allowed} 以下しか読みません`,
                        'docs/launcher.json'
                    );
                }
            } else if (!fs.existsSync(paths.docs(item.src))) {
                error('MISSING_MEDIA', `添付候補の画像がありません（${repo} / ${item.src}）`, 'docs/launcher.json');
            }
        }
    }
}

try {
    const manifest = readJson(paths.docs('manifest.webmanifest'));
    for (const icon of manifest.icons ?? []) {
        if (!fs.existsSync(paths.docs(icon.src))) {
            error('MISSING_ICON', `アイコンがありません（${icon.src}）。ホーム画面に追加できなくなります`, 'docs/manifest.webmanifest');
        }
    }
} catch {
    // 1. で報告ずみ
}

/* ── 10. カード画像が壊れていないか ──────────────────
 * MANUAL に「画像が真っ白／文字が □□□ になる」が既知の症状として書いてあるのに、
 * 確かめる手段が1つも無かった。52枚ぜんぶ真っ白でも撮影は「成功」として終わる。 */

if (fs.existsSync(paths.media())) {
    const cards = fs.readdirSync(paths.media()).filter((f) => /-card(-\d)?\.png$/.test(f));
    let blank = 0;
    for (const name of cards) {
        const buffer = fs.readFileSync(paths.media(name));
        const header = readHeader(buffer);
        if (!header) {
            error('BROKEN_PNG', 'PNG として読めません', `docs/media/${name}`);
            continue;
        }
        if (header.width !== CARD_SIZE.width || header.height !== CARD_SIZE.height) {
            error(
                'CARD_SIZE_MISMATCH',
                `${header.width}×${header.height} です（紹介カードは ${CARD_SIZE.width}×${CARD_SIZE.height}）`,
                `docs/media/${name}`
            );
            continue;
        }
        if (inspectCard(buffer, { expect: CARD_SIZE }).blank) {
            blank += 1;
            error('BLANK_CARD', 'ほぼ単色です。日本語フォントか描画待ちを疑ってください', `docs/media/${name}`);
        }
    }
    if (cards.length === 0) warn('NO_CARDS', '紹介カードが1枚もありません（`npm run media`）', 'docs/media');
    void blank;

    // 撮れていないアプリの一覧。失敗ではないが、把握できないままなのは困る。
    const mediaManifest = readJson(paths.media('manifest.json'), null);
    if (mediaManifest) {
        const notShot = Object.entries(mediaManifest.apps ?? {}).filter(([, v]) => v.shot?.ok === false);
        if (notShot.length > 0) {
            warn(
                'NO_SCREENSHOT',
                `${notShot.length} 件のアプリは画面を撮れていません（文字だけのカードになります）: ${notShot.map(([n]) => n).join(', ')}`,
                'docs/media/manifest.json'
            );
        }
    }
}

/* ── 11. 生成物の形が壊れていないか ──────────────────
 * feedback.json / history.json は無くてもよい（まだ一度も動いていないだけ）。
 * あるのに形が違うときだけ落とす。壊れたまま生成に食われると、
 * 「なぜか毎週同じアプリばかり出る」という気づきにくい症状になる。 */

const feedback = readJson(paths.data('feedback.json'), null);
if (feedback) {
    if (typeof feedback.posts !== 'object' || typeof feedback.themes !== 'object') {
        error('BROKEN_FEEDBACK', 'posts と themes が要ります（scripts/collect-feedback.mjs が作ります）', 'data/feedback.json');
    } else {
        try {
            const themeIds = new Set(readJson(paths.config('themes.json')).themes.map((t) => t.id));
            const unknown = Object.keys(feedback.themes).filter((id) => !themeIds.has(id));
            if (unknown.length > 0) {
                warn(
                    'STALE_FEEDBACK_THEME',
                    `config/themes.json に無い型の記録が残っています（${unknown.join(', ')}）。生成には効きませんが、消してよいものです`,
                    'data/feedback.json'
                );
            }
        } catch {
            // themes.json の壊れは 5. で報告ずみ
        }

        // フックの型も同じように見る。audience.json から型を消したのに
        // 記録が残っていると、生成に渡す「手応え」に存在しない型が混ざる。
        try {
            const hookIds = new Set((readJson(paths.config('audience.json')).hooks ?? []).map((h) => h.id));
            const unknown = Object.keys(feedback.hooks ?? {}).filter((id) => !hookIds.has(id));
            if (unknown.length > 0) {
                warn(
                    'STALE_FEEDBACK_HOOK',
                    `config/audience.json に無いフックの記録が残っています（${unknown.join(', ')}）。生成には効きませんが、消してよいものです`,
                    'data/feedback.json'
                );
            }
        } catch {
            // audience.json の壊れは 15. で報告ずみ
        }
    }
}

const history = readJson(paths.data('history.json'), null);
if (history && !Array.isArray(history.posts)) {
    error('BROKEN_HISTORY', 'posts が配列ではありません（scripts/archive-history.mjs が作ります）', 'data/history.json');
}

/* ── 11'. 予備の引き出しが空のままになっていないか ──────
 *
 * 生成は成功していても、予備を作る処理だけが例外で落ちることがある（実際にそうなっていた。
 * 日付を持たない枠に曜日の温度を引きにいって throw し、try/catch に吸われていた）。
 * その結果、ランチャーの［いま出す］タブは一度も中身を持ったことがなかった。
 *
 * 週の投稿ができているのに予備だけ無い、という組み合わせでしか見つけられない壊れ方なので、
 * ここで見る。エラーにしないのは、初回の実行では正常に無いためである。 */

{
    const weekId = isoWeekId(jstDateString());
    const nextWeekId = isoWeekId(nextWeekDates()[0]);
    const hasQueue = [weekId, nextWeekId].some((id) => fs.existsSync(paths.data('queue', `${id}.json`)));
    const stock = readJson(paths.data('stock.json'), null);

    if (hasQueue && (stock === null || (stock.posts ?? []).length === 0)) {
        warn(
            'EMPTY_STOCK',
            '週の下書きはあるのに、予備の引き出し（data/stock.json）が空です。' +
                'ランチャーの［いま出す］タブに何も出ません。`npm run generate` のログに理由が出ています',
            'data/stock.json'
        );
    }
}

/* ── 13. 画像が切り取られる形になっていないか ──────────
 *
 * <img> の width / height 属性は、CSS で height を指定しないかぎり
 * 「その高さのボックス」として効いてしまう。幅と高さが両方決まった時点で
 * aspect-ratio は無視されるので、16:9 のつもりが縦長の枠になり、
 * 紹介カードが中央だけ切り取られて何のアプリか分からなくなる（実際にそうなった）。
 *
 * 属性そのものは、読み込み前に場所を確保して画面が飛び跳ねないようにするために要る。
 * 消すべきは属性ではなく、CSS 側の height の指定漏れである。 */

{
    // docs/*.html から「class と height 属性を両方持つ img」を集める
    const withHeightAttr = new Map(); // class名 → 見つけた場所
    for (const name of ['index.html', 'apps.html', 'offline.html']) {
        const html = readText(paths.docs(name), null);
        if (html === null) continue;
        for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
            if (!/\bheight\s*=\s*["']?\d/.test(tag)) continue;
            const className = /\bclass\s*=\s*"([^"]+)"/.exec(tag)?.[1] ?? '';
            for (const cls of className.split(/\s+/).filter(Boolean)) {
                if (!withHeightAttr.has(cls)) withHeightAttr.set(cls, `docs/${name}`);
            }
        }
    }

    for (const [cls, where] of withHeightAttr) {
        for (const cssName of ['style.css', 'apps.css']) {
            const css = readText(paths.docs(cssName), null);
            if (css === null) continue;

            // そのクラスだけを対象にした宣言ブロックを探す
            const rule = new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
            if (!rule) continue;
            const block = rule[1];

            if (/aspect-ratio\s*:/.test(block) && !/(^|[;{\s])height\s*:/.test(block)) {
                error(
                    'IMAGE_CROPPED',
                    `.${cls} が aspect-ratio を持っていますが height を指定していません。` +
                        `${where} の <img> に height 属性があるため、そちらが効いて縦長の枠になり、画像が切り取られます。` +
                        '`height: auto;` を足してください',
                    `docs/${cssName}`
                );
            }
        }
    }
}

/* ── 14. 配信する投稿の本文に URL が混ざっていないか ────
 *
 * X は本文に外部リンクがある投稿のリーチを大きく下げる。
 * Premium でないアカウントだと、ほとんど誰にも表示されない。
 * リンクは「自分への最初の返信」に回す設計にしてあるが、
 * ここが破れても画面には何も出ない（ふつうに投稿できてしまう）。
 * 出したあとで気づいても取り返せないので、配信物の側でも見る。
 *
 * 生成時の検査（lib/lint.mjs）と二重になっているが、
 * 二重にする価値のある種類の失敗である。 */

if (launcher && (launcher.urlPlacement ?? 'reply') === 'reply') {
    // ⚠️ ここに正規表現を書き写さない。以前は3つ目の写しが置いてあって、
    //    スキームなしの URL（gigayama.github.io/Typa/）を見逃す穴を
    //    生成側の検査と揃って持っていた。判定は x-text.mjs の1か所に寄せる。
    for (const post of launcher.posts ?? []) {
        const main = (post.steps ?? [])[0];
        if (!main) continue;
        const [hit] = extractUrls(main.text ?? '');
        if (hit) {
            error(
                'URL_IN_MAIN_POST',
                `${post.id} の本文に URL が入っています（${hit}）。` +
                    'X は本文に外部リンクがある投稿をほとんど表示しません。リンクは返信に回してください',
                'docs/launcher.json'
            );
        }
    }

    // リンクの返信そのものが落ちていないか。
    // 本文からリンクを外したのに返信も無いと、どこからもアプリに来られない。
    const withoutLink = (launcher.posts ?? []).filter(
        (p) => (p.steps ?? []).length > 0 && !(p.steps ?? []).some((s) => extractUrls(s.text ?? '').length > 0)
    );
    if (withoutLink.length > 0) {
        warn(
            'NO_LINK_ANYWHERE',
            `${withoutLink.length} 件の投稿に URL がどこにもありません（${withoutLink.slice(0, 3).map((p) => p.id).join(', ')}）。` +
                'アプリに来てもらう導線が無い状態です',
            'docs/launcher.json'
        );
    }
}

/* ── 15. 誰に向けて書くかの定義 ─────────────────
 * ここが空だと、当たりさわりのない文章になる。
 * 当たりさわりの無い文章は誰の関心も引かない。 */

try {
    const audience = readJson(paths.config('audience.json'));
    if (!audience.primary?.who) {
        error('EMPTY_AUDIENCE', 'primary.who が空です。誰に向けて書くかが決まっていません', 'config/audience.json');
    }
    if ((audience.hooks ?? []).length === 0) {
        error(
            'EMPTY_HOOKS',
            'hooks が空です。最初の1行の型が1つも無いと、生成が毎回同じ書き出しになります',
            'config/audience.json'
        );
    }
} catch (e) {
    error('CONFIG_UNREADABLE', e.message, 'config/audience.json');
}

/* ── 16. Gemini のモデル設定 ────────────────────────
 * ここが変だと、週次が走ってはじめて分かる（しかも生成の直前まで進んでから落ちる）。
 * 形だけは先に見ておく。 */

try {
    const accounts = readJson(paths.config('accounts.json'));
    const policy = readPolicy(accounts);

    if (!policy.auto && !/^gemini-/.test(policy.pinned ?? '')) {
        error(
            'BAD_GEMINI_MODEL',
            `geminiModel が "${policy.pinned}" です。'auto'（自動で最新を選ぶ）か、gemini- で始まるモデル名を書いてください`,
            'config/accounts.json'
        );
    }
    if (!['flash', 'pro', 'flash-lite'].includes(policy.prefer)) {
        error(
            'BAD_GEMINI_MODEL',
            `geminiModelPrefer が "${policy.prefer}" です。flash / pro / flash-lite のどれかにしてください`,
            'config/accounts.json'
        );
    }
    if (!/^gemini-/.test(policy.fallback)) {
        error(
            'BAD_GEMINI_MODEL',
            `geminiModelFallback が "${policy.fallback}" です。一覧を取れなかったときに使う名前なので、必ず動くモデル名を書いてください`,
            'config/accounts.json'
        );
    }

    // 自動選択にしているのに preview を掴んでいたら知らせる。
    // 毎週の生成を、予告なく消えるものに預けている状態なので、意図したのかを確かめたい。
    const chosen = readJson(paths.data('gemini-model.json'), null);
    if (policy.auto && chosen?.model && !policy.allowPreview) {
        const { stable } = describeModel(chosen.model);
        if (!stable) {
            warn(
                'PREVIEW_GEMINI_MODEL',
                `いま選ばれている ${chosen.model} は安定版ではありません（geminiAllowPreview は false）。\`node scripts/check-gemini.mjs\` で選びなおせます`,
                'data/gemini-model.json'
            );
        }
    }
} catch (e) {
    error('CONFIG_UNREADABLE', e.message, 'config/accounts.json');
}

/* ── 19. note の記事が連載の形をしているか ──────────────
 *
 * 記事は数千字あるので、放っておくと「機能を並べただけの文章」になる。
 * 連載として読まれるには、毎回同じ骨格で書かれている必要がある。
 * 生成のときにも検査しているが（scripts/generate-note.mjs）、
 * 基準（config/note-style.json）をあとから厳しくしたときに、
 * 既にある下書きを見なおす入口がどこにも無い。 */

try {
    const style = readJson(paths.config('note-style.json'));
    if ((style.sections ?? []).length === 0) {
        error('EMPTY_NOTE_STYLE', 'sections が空です。この状態だと記事の骨格を何も見ていません', 'config/note-style.json');
    }

    const guardrails = readJson(paths.config('guardrails.json'));
    const monetization = readJson(paths.config('monetization.json'));
    const dir = paths.data('note');

    if (fs.existsSync(dir)) {
        // 今週と翌週ぶんだけ見る。過去の記事はもう出したあとなので直せない。
        const wanted = new Set([isoWeekId(jstDateString()), isoWeekId(nextWeekDates()[0])]);
        for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
            if (!wanted.has(name.replace('.md', ''))) continue;
            const markdown = readText(path.join(dir, name), '');
            const meta = readJson(path.join(dir, name.replace('.md', '.json')), null);
            const problems = lintArticle({
                article: { title: meta?.title ?? markdown.split('\n')[0] },
                markdown,
                style,
                guardrails,
                monetization,
            });
            for (const problem of problems) warn('NOTE_STYLE', problem, `data/note/${name}`);
        }
    }
} catch (e) {
    error('CONFIG_UNREADABLE', e.message, 'config/note-style.json');
}

/* ── 18. 中間ファイルが溜まりすぎていないか ────────────
 *
 * data/queue・data/note・data/trends には、週に3〜4ファイルずつ増えていく。
 * 消す処理はいま archive-history.mjs にあるが、それが動かなくなっても
 * 誰も気づかない（増えるだけで、何も壊れないため）。
 * 毎週コミットするので、気づかないうちにリポジトリが重くなる。 */

{
    const weeks = new Set();
    for (const dir of ['queue', 'note', 'trends']) {
        const at = paths.data(dir);
        if (!fs.existsSync(at)) continue;
        for (const name of fs.readdirSync(at)) {
            const m = /^(\d{4}-W\d{2})\./.exec(name);
            if (m) weeks.add(m[1]);
        }
    }

    // KEEP_WEEKS（26）に、掃除が1〜2回落ちたぶんの余裕を足した線。
    if (weeks.size > 30) {
        warn(
            'DATA_PILING_UP',
            `週ごとの中間ファイルが ${weeks.size} 週ぶん残っています（${KEEP_WEEKS} 週で消えるはずです）。` +
                '`npm run archive` が動いていない可能性があります',
            'data/'
        );
    }
}

/* ── 17. 通知が枠のぶんだけあるか ──────────────────
 *
 * config/slots.json は朝と夜の2枠なのに、通知の cron は朝の1回しか無かった。
 * 夜のぶんは朝の Issue に一緒に載っているだけで、
 * 「朝に見たことを覚えている」ことが前提になっていた。
 * README が「発信を続けるための要」と呼んでいる通知が、枠の半分に効いていない状態である。
 *
 * 枠を足したのに通知を足し忘れる、というのがいちばんありそうな壊れ方なので、
 * daily-notify.yml の対応表と slots.json を突き合わせる。 */

try {
    const slots = readJson(paths.config('slots.json')).slots ?? [];
    const yaml = readText(path.join(ROOT, '.github', 'workflows', 'daily-notify.yml'), null);

    if (yaml !== null && slots.length > 0) {
        // case 文の「'<cron>') slot=<id> ;;」から対応表を読む
        const mapped = new Set([...yaml.matchAll(/\)\s*slot=([a-z0-9_-]+)\s*;;/gi)].map((m) => m[1]));
        const crons = (yaml.match(/^\s*-\s*cron:/gm) ?? []).length;

        for (const slot of slots) {
            if (!mapped.has(slot.id)) {
                warn(
                    'SLOT_NOT_NOTIFIED',
                    `config/slots.json の枠「${slot.label}（${slot.id}）」に対応する通知がありません。` +
                        'この枠は誰にも知らされないので、出し忘れます',
                    '.github/workflows/daily-notify.yml'
                );
            }
        }
        for (const id of mapped) {
            if (!slots.some((s) => s.id === id)) {
                warn(
                    'SLOT_NOT_DEFINED',
                    `通知が枠「${id}」を指していますが、config/slots.json にありません。この通知は必ず空振りします`,
                    '.github/workflows/daily-notify.yml'
                );
            }
        }
        if (crons < slots.length) {
            warn(
                'SLOT_NOT_NOTIFIED',
                `枠が ${slots.length} 個あるのに cron が ${crons} 本しかありません`,
                '.github/workflows/daily-notify.yml'
            );
        }

        // 通知ワークフローは sparse-checkout で docs/ を取ってこない（29MB あるため）。
        // あとから docs/ を読むようになると、手元では動くのに CI でだけ落ちる。
        // しかも「ファイルが見つかりません」としか出ないので、
        // sparse-checkout が原因だと気づくまでに時間がかかる。
        const sparse = /sparse-checkout:\s*\|\n([\s\S]*?)\n\s*sparse-checkout-cone-mode/.exec(yaml);
        if (sparse) {
            const included = new Set(
                sparse[1]
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)
            );
            const source = readText(path.join(ROOT, 'scripts', 'notify-daily.mjs'), '');
            for (const [, kind] of source.matchAll(/paths\.(docs|media)\(/g)) {
                const needed = 'docs';
                if (!included.has(needed)) {
                    error(
                        'SPARSE_CHECKOUT_TOO_NARROW',
                        `scripts/notify-daily.mjs が paths.${kind}() を使っていますが、` +
                            'daily-notify.yml の sparse-checkout に docs が入っていません。CI でだけファイルが見つかりません',
                        '.github/workflows/daily-notify.yml'
                    );
                    break;
                }
            }
        }
    }
} catch (e) {
    error('CONFIG_UNREADABLE', e.message, 'config/slots.json');
}

/* ── 12. package.json と実行環境の食い違い ────────────
 * `node --run` は Node 22 で入った機能である。engines が ">=20" のまま使うと、
 * Node 20 の環境で npm run が落ちる。CI は serve を実行しないので、
 * この食い違いは誰にも検出されないまま README に載りつづける（実際にそうなっていた）。 */

try {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    const engine = pkg.engines?.node ?? '';
    const major = Number(/(\d+)/.exec(engine)?.[1] ?? 0);

    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (major > 0 && major < 22 && /\bnode --run\b/.test(command)) {
            error(
                'NODE_FEATURE_TOO_NEW',
                `scripts.${name} が \`node --run\` を使っていますが、これは Node 22 以降の機能です（engines.node は "${engine}"）`,
                'package.json'
            );
        }
    }

    // ワークフローが使う Node の版が engines を下回っていないか。
    for (const file of walk(path.join(ROOT, '.github', 'workflows'))) {
        const yaml = fs.readFileSync(file, 'utf8');
        for (const hit of yaml.matchAll(/node-version:\s*'?(\d+)/g)) {
            if (major > 0 && Number(hit[1]) < major) {
                error(
                    'NODE_VERSION_TOO_OLD',
                    `node-version: ${hit[1]} は package.json の engines.node（"${engine}"）を下回っています`,
                    rel(file)
                );
            }
        }
    }
} catch (e) {
    error('CONFIG_UNREADABLE', e.message, 'package.json');
}

/* ── 出力 ─────────────────────────────────────── */

function walk(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
        return [full];
    });
}

const errors = issues.filter((i) => i.severity === 'error');
const warnings = issues.filter((i) => i.severity === 'warning');

if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ issues, errors, warnings }, null, 2));
} else if (issues.length === 0) {
    console.log('✓ 品質ゲート: 問題なし');
} else {
    for (const issue of issues) {
        const mark = issue.severity === 'error' ? '✖' : '⚠';
        console.log(`${mark} [${issue.code}] ${issue.file ?? ''}\n    ${issue.message}`);
    }
    console.log(`\nエラー ${errors.length} 件 / 警告 ${warnings.length} 件`);
}

process.exit(errors.length > 0 ? 1 : 0);
