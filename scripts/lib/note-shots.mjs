/**
 * 記事に入れる画面（スクリーンショット）の置き場と、その読み方。
 *
 * 紹介カード（docs/media/<repo>-card.png）とは別のものである。
 * カードは X の投稿に添える1枚で、アプリの顔として作ってある。
 * こちらは記事の本文に差しこむ「操作している最中の画面」で、1本の記事に15〜25点入る。
 *
 * ⚠️ 加工も合成もしない。実際に操作して撮ったものだけを使う。
 *    そうでないと、記事を読んで来た先生が見る画面と食い違う。
 *
 * 置き場:
 *   docs/media/article/<repo>/NN-<label>.png
 *   docs/media/article/<repo>/manifest.json
 *
 * docs/ に置くのは、カードと同じ理由である。GitHub Pages から配信されていないと
 * note に上げるときに取り出せない。
 */
import fs from 'node:fs';
import { paths, readJson } from './io.mjs';

/** 記事用の画面を置くディレクトリ。 */
export function shotsDir(repo) {
    return paths.media('article', repo);
}

/**
 * 撮ってある画面を読む。
 *
 * manifest.json には、撮ったときに「何を押して」「画面に何が見えていたか」が入っている。
 * 記事を書かせるときにそれを渡すと、どの画面をどこに置くかを自分で選べる。
 * ファイル名だけ渡しても、中身が分からないので選びようがない。
 *
 * @returns {{file: string, label: string, what: string, seen: string}[]}
 */
export function loadShots(repo) {
    const dir = shotsDir(repo);
    if (!fs.existsSync(dir)) return [];

    const manifest = readJson(`${dir}/manifest.json`, null);
    if (!manifest) {
        // manifest が無くても、ファイルがあれば使える（手で置いた場合）。
        // ただし中身の説明が無いので、選ぶ手がかりはファイル名だけになる。
        return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.png'))
            .sort()
            .map((file) => ({ file, label: file.replace(/^\d+-|\.png$/g, ''), what: '', seen: '' }));
    }

    return (manifest.shots ?? []).filter((s) => s?.file && fs.existsSync(`${dir}/${s.file}`));
}

/** 撮ってある画面を、そのままプロンプトに入れられる形にする。 */
export function shotBlock(shots) {
    return shots
        .map((s) => {
            const parts = [`- ${s.file}`];
            if (s.what) parts.push(`（${s.what}）`);
            if (s.seen) parts.push(`\n    画面に見えていた文字: ${String(s.seen).slice(0, 120)}`);
            return parts.join('');
        })
        .join('\n');
}
