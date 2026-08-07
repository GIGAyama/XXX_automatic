/**
 * ファイルの読み書きとパス解決をまとめたもの。
 *
 * スクリプトごとに path.join を書くと、実行するディレクトリによって
 * 動いたり動かなかったりする。ここで一度だけリポジトリのルートを決めて、
 * 以降は必ずここ経由で組み立てる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** このファイルは <root>/scripts/lib/io.mjs にあるので、2つ上がリポジトリのルート。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const paths = {
    config: (name) => path.join(ROOT, 'config', name),
    data: (...parts) => path.join(ROOT, 'data', ...parts),
    docs: (...parts) => path.join(ROOT, 'docs', ...parts),
    media: (...parts) => path.join(ROOT, 'docs', 'media', ...parts),
};

export function readJson(filePath, fallback = undefined) {
    if (!fs.existsSync(filePath)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`ファイルが見つかりません: ${rel(filePath)}`);
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        // JSON の壊れは「どのファイルか」が分からないと直せない。必ずパスを添える。
        throw new Error(`JSON として読めません: ${rel(filePath)} — ${error.message}`);
    }
}

export function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeText(filePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text, 'utf8');
}

export function readText(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
}

/** config/*.json をまとめて読む。どのスクリプトも最初にこれを呼ぶ。 */
export function loadConfig() {
    return {
        accounts: readJson(paths.config('accounts.json')),
        slots: readJson(paths.config('slots.json')),
        themes: readJson(paths.config('themes.json')),
        guardrails: readJson(paths.config('guardrails.json')),
        monetization: readJson(paths.config('monetization.json')),
    };
}

/** CLAUDE.md の §3〜§5（発信ポリシー）だけを切り出す。生成プロンプトに埋め込む。 */
export function loadPolicy() {
    const md = readText(path.join(ROOT, 'CLAUDE.md'), '');
    const start = md.indexOf('## §3');
    const end = md.indexOf('## §6');
    if (start === -1) return '';
    return md.slice(start, end === -1 ? undefined : end).trim();
}

export function rel(filePath) {
    return path.relative(ROOT, filePath) || filePath;
}

/** 引数を --key=value / --key value / --flag の形で読む簡易パーサ。 */
export function parseArgs(argv = process.argv.slice(2)) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            out._.push(token);
            continue;
        }
        const body = token.slice(2);
        const eq = body.indexOf('=');
        if (eq !== -1) {
            out[body.slice(0, eq)] = body.slice(eq + 1);
        } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
            out[body] = argv[i + 1];
            i += 1;
        } else {
            out[body] = true;
        }
    }
    return out;
}

/** 失敗したら黙って続けず、原因を出して終了する。 */
export function fail(message) {
    console.error(`\n✖ ${message}\n`);
    process.exit(1);
}

/**
 * 例外を受けて終了する。各スクリプトの main().catch() はこれを使う。
 *
 * 設定ミス（キーの未登録など）は userFacing を立てて投げてある。
 * その場合スタックトレースを出さない。直し方を書いた案内文の下に
 * 「at requireApiKey (file:///...)」が続くと、読む人はそちらに目を取られて
 * 肝心の案内を読み落とす。原因が分かっている失敗に技術的な出力は要らない。
 */
export function failWith(error) {
    if (error?.userFacing) fail(error.message);
    fail(error?.stack ?? String(error));
}

export function info(message) {
    console.log(message);
}
