#!/usr/bin/env node
/**
 * Service Worker の版を、シェルの中身から決める。
 *
 *   node scripts/build-sw.mjs            版を書き換える
 *   node scripts/build-sw.mjs --check    書き換えず、ずれていたら落ちる（CI 用）
 *
 * なぜ要るのか:
 *   docs/sw.js の VERSION は 'v1' の直書きだった。app.js や style.css を直しても
 *   キャッシュ名が変わらないので、端末には古い画面が残りつづける。
 *   MANUAL の「アイコンを消して追加しなおしてください」は、この手当てである。
 *   直したものが端末に届かないと、以降の修正がぜんぶ「直したはずなのに直っていない」に見える。
 *   版をシェルの内容そのものから決めれば、直せば必ず届く。
 *
 * ついでにもう1つ見る。SHELL に並べたファイルが実在するか。
 * cache.addAll は1つでも 404 があると全部失敗する（sw.js 自身がそう警告している）。
 * 綴りを1文字まちがえただけでオフライン対応が丸ごと死ぬので、ここで捕まえる。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail, info, paths, readText, rel } from './lib/io.mjs';

// ⚠️ 行末の /* __APP_VERSION__ */ は艦隊共通の目印である。
//    「この値は手で上げるものではない」を、読み手にも検査にも同じ形で伝える。
//    正本の E_SW_VERSION_GENERATED がこの目印を見て、手書きに戻っていないかを確かめる。
const VERSION_LINE = /^const VERSION = '([^']*)'; \/\* __APP_VERSION__ \*\/$/m;
const SHELL_LINE = /^const SHELL = \[([^\]]*)\];$/m;

/** sw.js の SHELL 配列を読み、実ファイルのパスに直す。 */
export function shellFilesOf(swSource, docsDir) {
    const m = SHELL_LINE.exec(swSource);
    if (!m) throw new Error("docs/sw.js の SHELL 配列を読めませんでした（`const SHELL = [...];` の1行で書いてください）");

    const entries = [...m[1].matchAll(/'([^']+)'/g)].map((hit) => hit[1]);
    return entries.map((entry) => {
        // './' はディレクトリそのものを指す。実体は index.html。
        const relPath = entry === './' ? './index.html' : entry;
        return { entry, file: path.join(docsDir, relPath.replace(/^\.\//, '')) };
    });
}

/** シェルの中身から版を決める。中身が1バイトでも変われば別の版になる。 */
export function versionOf(files) {
    const hash = crypto.createHash('sha256');
    for (const { entry, file } of files) {
        hash.update(entry);
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    }
    return `v${hash.digest('hex').slice(0, 8)}`;
}

function main() {
    const check = process.argv.includes('--check');
    const swPath = paths.docs('sw.js');
    const source = readText(swPath, null);
    if (source === null) fail(`${rel(swPath)} がありません`);

    let files;
    try {
        files = shellFilesOf(source, paths.docs());
    } catch (error) {
        fail(error.message);
    }

    const missing = files.filter(({ file }) => !fs.existsSync(file));
    if (missing.length > 0) {
        fail(
            `docs/sw.js の SHELL に、存在しないファイルが ${missing.length} 件あります。\n` +
                missing.map(({ entry }) => `  - ${entry}`).join('\n') +
                '\n\ncache.addAll は1つでも欠けると全部失敗します。オフライン対応が丸ごと効かなくなるので、綴りを直してください。'
        );
    }

    // launcher.json を混ぜていないか。混ぜると新しい週の投稿が永久に出てこない。
    // check-project.mjs も見ているが、ここは版を計算する場所なので二重に見ておく。
    if (files.some(({ entry }) => entry.includes('launcher.json'))) {
        fail('docs/sw.js の SHELL に launcher.json が入っています。ここに入れると新しい週の投稿が出てこなくなります。');
    }

    const version = versionOf(files);
    const current = VERSION_LINE.exec(source);
    if (!current) {
        fail(
            "docs/sw.js の `const VERSION = '...'; /* __APP_VERSION__ */` の行を読めませんでした。\n" +
                '行末の目印を消すと、ここも正本のゲートも版を追えなくなります。'
        );
    }

    if (current[1] === version) {
        info(`SW の版は最新です（${version} / シェル ${files.length} ファイル）`);
        return;
    }

    if (check) {
        fail(
            `docs/sw.js の VERSION が中身と合っていません（いま ${current[1]} / あるべき ${version}）。\n` +
                '`npm run build:sw` を実行してからコミットしてください。\n' +
                'ここがずれたままだと、直した画面が端末に届きません。'
        );
    }

    fs.writeFileSync(swPath, source.replace(VERSION_LINE, `const VERSION = '${version}'; /* __APP_VERSION__ */`), 'utf8');
    info(`SW の版を更新しました: ${current[1]} → ${version}（シェル ${files.length} ファイル）`);
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (error) {
        fail(error.stack ?? error.message);
    }
}
