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
import { ROOT, paths, readJson, rel } from './lib/io.mjs';

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
    'scripts/lib/jst.mjs',
    'docs/index.html',
    'docs/app.js',
    'docs/style.css',
    'docs/sw.js',
    'docs/offline.html',
    'docs/manifest.webmanifest',
    'docs/install-hook.js',
    '.github/workflows/weekly.yml',
    '.github/workflows/daily-notify.yml',
    '.github/workflows/deploy-pages.yml',
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

for (const file of walk(path.join(ROOT, 'scripts'))) {
    if (!file.endsWith('.mjs')) continue;
    // 2つだけ例外がある。
    //   jst.mjs          … JST を定義している本人。ここで new Date() を使うのは当たり前
    //   check-project.mjs … 検査の正規表現そのものを含むので、必ず自分に当たる
    if (file.endsWith(path.join('lib', 'jst.mjs'))) continue;
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

try {
    const html = fs.readFileSync(paths.docs('index.html'), 'utf8');
    if (!/Content-Security-Policy/i.test(html)) {
        warn('NO_CSP', 'CSP の指定がありません', 'docs/index.html');
    }
    const external = html.match(/(?:src|href)="https?:\/\/[^"]+"/g) ?? [];
    for (const hit of external) {
        error('EXTERNAL_ASSET', `外部から読みこんでいます（${hit}）。同梱してください`, 'docs/index.html');
    }
} catch {
    // ファイルが無いことは 1. で報告ずみ
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
