/**
 * ランチャー（docs/）が読む投稿の形。
 *
 * もとは scripts/build-launcher-data.mjs のなかにあった。
 * 「いまこのアプリの投稿を作ってほしい」（scripts/generate-promo.mjs）が
 * 同じ形のものを別の口から配るようになったので、ここに出してある。
 *
 * ⚠️ 形を二重に持たない。
 *    画面（docs/app.js）は steps / mediaList / alternatives があることを前提に描く。
 *    2か所で組み立てると、片方に項目を足したときにもう片方だけが古い形を配りつづけ、
 *    「週の投稿では出るのに、作らせた投稿では出ない」という分かりにくい壊れ方になる。
 */
import fs from 'node:fs';
import { paths, readJson } from './io.mjs';
import { rawUrl } from './repo-images.mjs';
import { composeSteps, seedFrom, weightedLength } from './x-text.mjs';

/**
 * 表示に要るものだけを抜き出す。
 *
 * steps（連投の手順）を持たない古い週の投稿は、本文1コマの連投として組み立てなおす。
 * ランチャー側に「steps がある場合とない場合」の分岐を持ち込まないためである。
 *
 * @param {object} post          data/queue/*.json か assemble() が作った投稿
 * @param {string} weekId        週ID。日付を持たないもの（予備・注文）は空文字
 * @param {number} maxLength     config/guardrails.json の maxWeightedLength
 * @param {string} [placement]   'reply' | 'body'
 * @param {(alt:object, post:object)=>boolean} [gate]  落選案をそのまま載せてよいか
 */
export function toLauncherPost(post, weekId, maxLength, placement = 'reply', gate = null) {
    const mediaList = mediaPathsFor(post.repo);
    const steps = (post.steps ?? legacySteps(post, placement)).map((step) => ({
        kind: step.kind,
        label: step.label,
        text: step.text,
        weightedLength: step.weightedLength ?? weightedLength(step.text),
    }));
    const main = steps[0];

    return {
        id: post.id,
        weekId,
        date: post.date,
        weekday: post.weekday,
        slot: post.slot,
        slotLabel: post.slotLabel,
        hour: post.hour,
        theme: post.theme,
        themeLabel: post.themeLabel,
        repo: post.repo,
        steps,
        // text は本文（1コマ目）。通知や古い版の画面がここだけを見ていても壊れないように残す。
        text: main.text,
        url: post.url,
        // media は1枚目。古い Service Worker が配っている app.js が読んでも壊れないように残す。
        media: mediaList[0] ?? post.media ?? null,
        mediaList,
        weightedLength: main.weightedLength,
        overLimit: main.weightedLength > maxLength,
        // 落選案。ランチャーから差し替えられるようにする。本文だけ渡せば足りる。
        //
        // ⚠️ 配信の直前にもガードレール検査をかける。
        //    ［別の案］はワンタップで本文になるので、本文と同じ基準を通っていないものを
        //    押せる場所に置いてはいけない。生成側（generate-week.mjs）でも同じことをしているが、
        //    data/queue/ には検査が無かったころの週が残りつづける。ここが最後の関所になる。
        alternatives: (post.alternatives ?? [])
            .filter((a) => !gate || gate(a, post))
            .map((a) => ({ body: a.body, thread: a.thread ?? [] })),
        pickReason: post.pickReason ?? null,
        hook: post.hook ?? null,
        // 出しなおしかどうか。画面で分かるようにしておかないと、
        // 「前も見た気がする」が不安（同じものを二度出してしまったのでは）になる。
        reprise: post.reprise ?? null,
    };
}

/**
 * steps を持たない古い週の投稿を、連投の形に組みなおす。
 *
 * 古い形は「本文 + URL + ハッシュタグ」を1つの文につなげてあった。
 * そのまま出すと本文に URL が入った投稿になり、X にほとんど表示されない。
 * 幸い body / url / hashtags は別々に残してあるので、正確に組みなおせる。
 *
 * これは移行のための一度きりの処理ではなく、置いたままにする。
 * data/queue/ には過去の週が残りつづけるし、
 * 画面側に「古い形」の分岐を持ち込まないための場所がここだからである。
 */
export function legacySteps(post, placement) {
    if (post.body && post.url) {
        return composeSteps({
            body: post.body,
            thread: [],
            url: post.url,
            hashtags: post.hashtags ?? [],
            placement,
            seed: seedFrom(post.id),
        });
    }
    // body すら無いものは、そのまま1コマとして出すしかない。
    return [{ kind: 'main', label: '本文', text: post.text }];
}

/** その投稿に付く紹介カードのパス（複数コマがあれば全部）。 */
export function mediaPathsFor(repo) {
    const found = [];
    for (let i = 1; i <= 4; i += 1) {
        const name = i === 1 ? `${repo}-card.png` : `${repo}-card-${i}.png`;
        if (fs.existsSync(paths.media(name))) found.push(`media/${name}`);
        else if (i > 1) break;
    }
    return found;
}

/**
 * 添付できる画像の一覧を、アプリごとに組む。
 *
 * 中身は2種類ある。
 *   card … このリポジトリで作った紹介カード（docs/media/）。既定で選ばれる。
 *   repo … アプリのリポジトリに置いてある画像（note の記事のために撮ったものなど）。
 *
 * repo のほうは raw.githubusercontent.com を直接指す。
 * このリポジトリに取り込まないのは、KANJI_Town だけで28枚・約5MB あり、
 * 毎週コミットする以上それがそのままリポジトリの重さになるためである（config/media.json）。
 *
 * URL はコミット SHA で固定する。ブランチ名で組むと、アプリ側で画像を差しかえたときに
 * 画面に出ている絵と共有される絵が食い違い、しかも気づけない。
 */
export function buildGalleries(repoNames, owner) {
    const collected = readJson(paths.data('repos.json'), { repos: [] }).repos ?? [];
    const byName = new Map(collected.map((repo) => [repo.name, repo]));
    const galleries = {};

    for (const name of repoNames) {
        const items = galleryFor(name, owner, byName);
        if (items.length > 0) galleries[name] = items;
    }

    return galleries;
}

/** アプリ1件ぶんの添付候補。 */
export function galleryFor(name, owner, byName) {
    const items = mediaPathsFor(name).map((src, i) => ({
        id: `card:${i}`,
        src,
        kind: 'card',
        label: i === 0 ? '紹介カード' : `紹介カード ${i + 1}`,
    }));

    const repo = byName instanceof Map ? byName.get(name) : byName?.[name];
    if (repo?.headSha) {
        for (const image of repo.images ?? []) {
            items.push({
                // id はパスで作る。SHA で作ると、アプリ側に1つコミットが入っただけで
                // 端末に残した「この画像を選んだ」が全部はずれる。
                id: `repo:${image.path}`,
                src: rawUrl(owner, name, repo.headSha, image.path),
                kind: 'repo',
                label: image.label,
            });
        }
    }

    return items;
}

/** data/repos.json を名前で引ける形にして返す。galleryFor に渡す。 */
export function reposByName() {
    const collected = readJson(paths.data('repos.json'), { repos: [] }).repos ?? [];
    return new Map(collected.map((repo) => [repo.name, repo]));
}
