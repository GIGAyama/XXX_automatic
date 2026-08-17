#!/usr/bin/env node
/**
 * ① 収集 — GitHub からリポジトリの素材を集めて data/repos.json に書く。
 *
 *   node scripts/collect-repos.mjs
 *   node scripts/collect-repos.mjs --limit 5      … 動作確認用に5件だけ
 *
 * ここで集めた素材が、あとの工程すべての土台になる。
 * 「リポジトリの中身を理解したうえで投稿を作る」という要件は、
 * README.md と MANUAL.md をちゃんと読むところから始まる。
 * GIGAyama の全リポジトリには日本語の詳しい README があるので、
 * これが投稿の材料としてそのまま使える。
 *
 * 取りにいくファイルを絞っているのは、55リポジトリ × ファイル数だけ
 * リクエストが飛ぶためである。全部のファイルを舐めるとレート上限に当たる。
 *
 * 画像の一覧もここで作る（images）。note の記事のために撮ったスクリーンショットが
 * リポジトリに入っているので、投稿に添える候補として拾っておく。
 * 中身は取ってこない。パスと説明文だけを控え、実物はランチャーが raw から直接読む。
 */
import { getFile, getHeadSha, getTree, listPublicRepos, listRecentCommits } from './lib/github.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { jstStamp } from './lib/jst.mjs';
import { assetPathsFor, pickArticlePaths } from './lib/note-article.mjs';
import {
import { pagesUrlFor } from './lib/urls.mjs';
    DEFAULT_REPO_IMAGES,
    captionSourcePaths,
    labelFromPath,
    parseCaptions,
    pickRepoImages,
} from './lib/repo-images.mjs';

/** 読みにいくファイル。上から順に「そのアプリが何者か」を語る密度が高い。 */
const SOURCE_FILES = [
    { key: 'readme', path: 'README.md', maxChars: 12000 },
    { key: 'manual', path: 'MANUAL.md', maxChars: 8000 },
    { key: 'manifest', path: 'manifest.webmanifest', maxChars: 2000 },
    { key: 'packageJson', path: 'package.json', maxChars: 2000 },
];

/**
 * そのリポジトリに置いてある画像のうち、投稿に添えられそうなものを拾う。
 *
 * note の記事を書くときに撮った画面（docs/note/images/01-home.png のような形）が
 * すでに入っている。実際に操作した結果の絵なので、機械が撮りなおすより中身が濃い。
 *
 * リクエストは説明文の Markdown で最大2回。一覧（tree）は呼び出し側が1回だけ取って渡す。
 * 画像そのものはここでは取らない（共有のときにランチャーが raw から直接読む）。
 *
 * ⚠️ 失敗しても投稿づくり全体は止めない。画像は「あれば添えられる」ものであって、
 *    無くても本文と紹介カードで成立する。ただし黙って0件にはせず、理由を出す。
 */
async function collectImages(owner, repoName, headSha, source, config, tree) {
    if (!config.enabled) return [];
    if (!headSha) return []; // SHA で固定できないと、あとで絵が入れかわっても気づけない
    if (!tree) return [];

    const picked = pickRepoImages(tree.entries, config);
    if (picked.length === 0) return [];

    // 上限で切ったぶんは必ず言う。黙って切ると「全部載っている」ように見えて、
    // あの画面が候補に出ない理由をどこからも追えなくなる。
    const all = pickRepoImages(tree.entries, { ...config, maxPerRepo: Number.MAX_SAFE_INTEGER });
    if (all.length > picked.length) {
        info(`   … ${repoName} は候補が ${all.length} 枚あるので ${picked.length} 枚に絞りました（config/media.json の maxPerRepo）`);
    }

    const paths_ = picked.map((image) => image.path);

    // 説明文の材料。README と MANUAL はすでに取ってあるので、ここでは取りにいかない。
    const documents = [
        { path: 'README.md', text: source.readme ?? '' },
        { path: 'MANUAL.md', text: source.manual ?? '' },
    ];
    for (const mdPath of captionSourcePaths(tree.entries, paths_, 2)) {
        try {
            const text = await getFile(owner, repoName, mdPath, headSha);
            if (text) documents.push({ path: mdPath, text: text.slice(0, 20000) });
        } catch (error) {
            console.error(`   … ${repoName}/${mdPath} を読めませんでした — ${error.message}`);
        }
    }

    const captions = parseCaptions(documents, paths_);

    return picked.map((image) => ({
        path: image.path,
        size: image.size,
        // 説明が拾えなければファイル名から作る。無題のサムネイルが並ぶより選びやすい。
        label: captions.get(image.path) ?? labelFromPath(image.path),
        // 説明を人が書いたものかどうかは分けておく。あとで「説明が付いた画像だけ」に
        // 絞りたくなったときに、ファイル名から作ったものと区別できないと困る。
        described: captions.has(image.path),
    }));
}

/**
 * リポジトリの一覧（tree）を1回だけ取る。
 *
 * 取れなくても収集そのものは続ける。README と説明文だけで投稿は作れるし、
 * 1件のために55リポジトリの収集を落とすほうが損失が大きい。
 * ただし黙って0件にはしない（「なぜこのアプリだけ画像が出ないのか」を後から追えなくなる）。
 */
async function getRepoTree(owner, repoName, headSha) {
    if (!headSha) return null;
    try {
        const tree = await getTree(owner, repoName, headSha);
        if (tree.truncated) {
            // 一覧が途中で切られた repo。拾えた範囲で続けるが、
            // 「なぜあの画像が候補に出ないのか」を後から追えるようにここで言っておく。
            console.error(`   … ${repoName} は一覧が大きすぎて途中までしか読めていません`);
        }
        return tree;
    } catch (error) {
        console.error(`   … ${repoName} の一覧を取れませんでした（画像と記事なしで続けます）— ${error.message}`);
        return null;
    }
}

/**
 * すでに書き上がっている note 記事を控える。
 *
 * アプリを作った本人が、そのアプリのリポジトリの中で記事を書いていることがある
 * （docs/note/ に本文と、実際に操作して撮った画面と、貼る手順を書いた README）。
 * 機械に書かせたものより中身が濃いのに、これまで投稿ランチャーからは見えなかった。
 *
 * ここで控えるのは場所だけである。本文を取りにいくのは scripts/collect-note-articles.mjs で、
 * そちらが「貼れる形」に変えて docs/note-articles/ に置く。
 * 工程を分けているのは、本文が1本22KBほどあり、52リポジトリぶんを抱える
 * data/repos.json に混ぜると、記事を使わない工程まで重くなるためである。
 *
 * 画像の一覧も一緒に控える。本文が指している絵が本当にあるかを、
 * あとで確かめられるようにするため（無い絵を指したまま配ると、
 * ランチャーには壊れたサムネイルが並び、理由がどこにも出ない）。
 */
function collectNoteArticles(repoName, tree) {
    if (!tree) return [];

    const articles = pickArticlePaths(tree.entries).map((path) => ({
        path,
        images: assetPathsFor(tree.entries, path),
    }));

    if (articles.length > 0) {
        info(`   … ${repoName} には書き上がった note 記事が ${articles.length} 本あります（${articles[0].path}）`);
    }
    return articles;
}

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();
    const owner = accounts.githubOwner;
    const repoImages = { ...DEFAULT_REPO_IMAGES, ...(readJson(paths.config('media.json'), {}).repoImages ?? {}) };

    info(`① 収集を開始します（${jstStamp()}）`);
    info(`   対象: github.com/${owner}`);

    const all = await listPublicRepos(owner);
    info(`   公開リポジトリ ${all.length} 件を取得しました`);

    const excluded = new Set(accounts.excludeRepos ?? []);
    let targets = all.filter((r) => {
        if (r.archived || r.disabled) return false;
        if (excluded.has(r.name)) return false;
        if (r.fork && !accounts.includeForks) return false;
        return true;
    });

    if (args.limit) targets = targets.slice(0, Number(args.limit));
    info(`   題材にするのは ${targets.length} 件（除外・フォークを引いた数）\n`);

    const repos = [];
    for (const [index, repo] of targets.entries()) {
        const label = `[${index + 1}/${targets.length}] ${repo.name}`;
        try {
            const branch = repo.default_branch || 'main';

            // ファイルは並列でとる。1リポジトリあたり4本なので、
            // 直列にすると55リポジトリで待ち時間ばかりになる。
            const [files, headSha, commits] = await Promise.all([
                Promise.all(
                    SOURCE_FILES.map(async (spec) => {
                        const text = await getFile(owner, repo.name, spec.path, branch);
                        return [spec.key, text ? text.slice(0, spec.maxChars) : null];
                    })
                ),
                getHeadSha(owner, repo.name, branch),
                listRecentCommits(owner, repo.name, branch, 8),
            ]);

            const source = Object.fromEntries(files);

            // 一覧（tree）は repo あたり1回だけ取る。画像の候補と、用意された note 記事の
            // 両方がここから決まる。工程ごとに取りにいくと、55リポジトリぶんの往復が倍になる。
            const tree = await getRepoTree(owner, repo.name, headSha);
            const images = await collectImages(owner, repo.name, headSha, source, repoImages, tree);
            const noteArticles = collectNoteArticles(repo.name, tree);

            repos.push({
                name: repo.name,
                description: repo.description ?? '',
                topics: repo.topics ?? [],
                defaultBranch: branch,
                headSha,
                pushedAt: repo.pushed_at,
                createdAt: repo.created_at,
                stars: repo.stargazers_count ?? 0,
                homepage: repo.homepage ?? '',

                // has_pages は GitHub Pages が有効かどうかの正。
                // README に index.html があるかどうかで推測すると、
                // docs/ 配信のもの（MIRAI-Compass など）を取りこぼす。
                hasPages: Boolean(repo.has_pages),

                // GIGAyama の全リポジトリで「リポジトリ名 = basePath」が守られているため、
                // 公開 URL はリポジトリ名から機械的に決まる。
                pagesUrl: pagesUrlFor(repo.name, accounts, repo.has_pages),

                recentCommits: commits,
                source,
                hasReadme: Boolean(source.readme),

                // リポジトリに置いてある画像（note の記事のために撮ったものなど）。
                // 投稿に添える候補として、ランチャーが選べるようにする。
                images,

                // すでに書き上がっている note 記事。本文はここでは取らない
                // （22KB ほどある。52リポジトリぶんを repos.json に抱えても、
                //   使うのは note の工程だけである）。場所と、同じ場所にある画像だけ控える。
                noteArticles,
            });

            const marks = [
                source.readme ? 'README' : null,
                source.manual ? 'MANUAL' : null,
                repo.has_pages ? 'Pages' : null,
                images.length > 0 ? `画像${images.length}` : null,
                noteArticles.length > 0 ? `note記事${noteArticles.length}` : null,
            ]
                .filter(Boolean)
                .join(' ');
            info(`   ✓ ${label} ${marks || '(素材なし)'}`);
        } catch (error) {
            // 1件の失敗で全体を止めない。ただし黙って飛ばすと
            // 「なぜかこのアプリだけ投稿に出てこない」という分かりにくい症状になるので必ず出す。
            console.error(`   ✖ ${label} — ${error.message}`);
        }
    }

    const withReadme = repos.filter((r) => r.hasReadme).length;
    const withPages = repos.filter((r) => r.hasPages).length;

    if (repos.length === 0) fail('1件も取得できませんでした。GITHUB_TOKEN とオーナー名を確認してください。');

    const outPath = paths.data('repos.json');
    writeJson(outPath, {
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        owner,
        count: repos.length,
        repos,
    });

    info('');
    info(`① 完了 — ${rel(outPath)} に ${repos.length} 件`);
    info(`   README あり: ${withReadme} 件 / Pages 公開: ${withPages} 件`);

    const withImages = repos.filter((r) => (r.images ?? []).length > 0);
    const imageCount = withImages.reduce((sum, r) => sum + r.images.length, 0);
    info(`   添付できる画像: ${imageCount} 枚（${withImages.length} 件のアプリ）`);

    const withArticles = repos.filter((r) => (r.noteArticles ?? []).length > 0);
    if (withArticles.length > 0) {
        const articleCount = withArticles.reduce((sum, r) => sum + r.noteArticles.length, 0);
        info(`   用意ずみの note 記事: ${articleCount} 本（${withArticles.length} 件のアプリ）— \`npm run note:repo\` で取り込みます`);
    }
    if (withReadme < repos.length) {
        info(`   ※ README の無い ${repos.length - withReadme} 件は、説明文とコミットlog だけで紹介文を書きます`);
    }
}

main().catch(failWith);
