#!/usr/bin/env node
/**
 * ①'' 収集（note）— アプリのリポジトリに用意された記事を、貼れる形にして配る。
 *
 *   node scripts/collect-note-articles.mjs
 *   node scripts/collect-note-articles.mjs --repo KANJI_Town   … 1件だけ
 *   node scripts/collect-note-articles.mjs --dry-run           … 書かずに結果だけ出す
 *
 * これは ④'（scripts/generate-note.mjs）の裏返しである。
 * あちらは題材から記事を書かせる。こちらは、すでに書き上がっている記事を見つけて運ぶ。
 * Gemini は呼ばない。人が書いたものを機械が書きかえてはいけない。
 *
 * ── なぜ docs/ に置くのか ─────────────────────────
 *
 * ランチャーは GitHub Pages 上の素の JS で動く。
 * 本文（1本7,900字ほど）を launcher.json に混ぜると、
 * 記事を出さない日でも、画面を開くたびに全部を読むことになる。
 * だから1本ずつ docs/note-articles/<id>.json に置き、
 * launcher.json には見出しだけを載せて、開いたときに読みにいく形にする。
 * docs/orders/ と同じ考え方である。
 *
 * ── 画像は取り込まない ──────────────────────────
 *
 * 記事1本で27点・5MB ほどある。毎週コミットする以上そのままリポジトリの重さになる。
 * ランチャーが raw.githubusercontent.com から直接読む（config/media.json と同じ方針）。
 * URL は必ずコミット SHA で固定する。ブランチ名で組むと、アプリ側で絵を差しかえたときに
 * 画面に出ている絵と共有する絵が食い違い、しかも気づけない。
 *
 * ⚠️ 本文は書きかえない。体裁の指摘（lib/note-lint.mjs）は結果に添えて画面に出し、
 *    直すかどうかは本人が決める。機械が黙って直すと、直した理由が誰にも伝わらない。
 */
import fs from 'node:fs';
import { getFile } from './lib/github.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { jstStamp } from './lib/jst.mjs';
import { parseArticle } from './lib/note-article.mjs';
import { lintArticle } from './lib/note-lint.mjs';
import { rawUrl } from './lib/repo-images.mjs';

// 配る形（schema・id の形・置き場・画像の上限）は画面側と共有する。
// 書く側と読む側で二重に定義すると、片方だけ直したときに黙って取りこぼす。
import { ARTICLES_DIR, ARTICLE_ID_RE, ARTICLE_SCHEMA_ID, MAX_ARTICLE_IMAGES } from '../docs/lib/note-doc.js';

/**
 * 1本ぶんの id を決める。
 *
 * 同じリポジトリに何本もあるときだけ枝番を付ける。
 * 1本しかないアプリの id が途中で変わらないようにするため
 * （id はそのままファイル名になり、端末に残る「公開した」の印もこれで引く）。
 */
export function articleIdFor(repoName, index) {
    return index === 0 ? repoName : `${repoName}--${index + 1}`;
}

/**
 * 記事1本ぶんの、配る形。
 *
 * ネットワークもファイルも触らない（中身は呼び出し側が渡す）。
 * ここを取り出してあるのは、配るものの形をブラウザを立てずに確かめるためである
 * （tests/note-article.test.mjs）。画面はこの形に頼って描くので、
 * 項目が1つ欠けただけで「開いたが何も出ない」になる。
 *
 * @param {object} params
 * @param {string} params.id       ファイル名になる id
 * @param {string} params.owner    GitHub のオーナー名
 * @param {object} params.repo     data/repos.json の1件（name / headSha / pagesUrl を使う）
 * @param {object} params.spec     repo.noteArticles の1件（path / images）
 * @param {string} params.markdown 記事の中身
 */
export function buildArticleRecord({ id, owner, repo, spec, markdown, style, guardrails, monetization }) {
    const parsed = parseArticle(markdown, { path: spec.path, assetPaths: spec.images ?? [] });

    // 体裁の指摘。落とすためではなく、出す前に本人が見るために添える。
    const styleWarnings = lintArticle({
        article: { title: parsed.title },
        markdown,
        style,
        guardrails,
        monetization,
    });

    const images = parsed.images
        // 渡せないものは並べない。押しても何も起きないボタンは、壊れているのと同じである。
        .filter((image) => !image.external && !image.missing)
        .slice(0, MAX_ARTICLE_IMAGES)
        .map((image) => ({
            n: image.n,
            path: image.path,
            src: rawUrl(owner, repo.name, repo.headSha, image.path),
            label: image.label,
            caption: image.caption,
        }));

    return {
        schema: ARTICLE_SCHEMA_ID,
        id,
        repo: repo.name,
        path: spec.path,
        sha: repo.headSha,
        sourceUrl: `https://github.com/${owner}/${repo.name}/blob/${repo.headSha}/${spec.path}`,
        pagesUrl: repo.pagesUrl ?? null,
        title: parsed.title,
        plain: parsed.plain,
        charCount: parsed.charCount,
        tags: parsed.tags,
        images,
        // 「本文には画像が16点あるが、渡せるのは15点」を隠さない。
        imagesInText: parsed.images.length,
        problems: parsed.problems,
        styleWarnings,
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
    };
}

async function main() {
    const args = parseArgs();
    const { accounts, guardrails, monetization } = loadConfig();
    const style = readJson(paths.config('note-style.json'));
    const owner = accounts.githubOwner;

    info(`①'' リポジトリに用意された note 記事を取り込みます（${jstStamp()}）`);

    const collected = readJson(paths.data('repos.json'), null);
    if (!collected) fail('data/repos.json がありません。先に `npm run collect` を実行してください。');

    // ⚠️ 「探していない」と「探したが無かった」を区別する。
    //    noteArticles は ① 収集が書く項目なので、この工程より前の repos.json には存在しない。
    //    区別しないと、古い repos.json のまま動かしただけで配信物を全部消してしまう。
    const looked = (collected.repos ?? []).some((repo) => Array.isArray(repo.noteArticles));

    let targets = (collected.repos ?? []).filter((repo) => (repo.noteArticles ?? []).length > 0);
    if (args.repo) targets = targets.filter((repo) => repo.name === args.repo);

    if (!looked) {
        info('   data/repos.json に記事を探した記録がありません。先に `npm run collect` を実行してください');
    } else if (targets.length === 0) {
        // 0件は失敗ではない。記事を置いてあるアプリがまだ無いだけのことがある。
        info(
            args.repo
                ? `   ${args.repo} には用意された記事がありません（data/repos.json の noteArticles が空です）`
                : '   用意された記事は見つかりませんでした（docs/note/ に本文を置くと拾います）'
        );
    }

    const articles = [];
    const failures = [];
    // 読めなかった記事の id。掃除のときに守る（下の理由による）。
    const failedIds = new Set();

    for (const repo of targets) {
        for (const [index, spec] of (repo.noteArticles ?? []).entries()) {
            const id = articleIdFor(repo.name, index);
            const label = `${repo.name}/${spec.path}`;

            if (!ARTICLE_ID_RE.test(id)) {
                // リポジトリ名がそのままファイル名になる。形を外れたものは配らない。
                failures.push(`${label} — id「${id}」の形が想定と違うので配りません`);
                continue;
            }
            if (!repo.headSha) {
                failures.push(`${label} — コミット SHA が分からないので、画像の URL を固定できません`);
                failedIds.add(id);
                continue;
            }

            try {
                const markdown = await getFile(owner, repo.name, spec.path, repo.headSha);
                if (!markdown) {
                    failures.push(`${label} — 本文を読めませんでした（消された可能性があります）`);
                    failedIds.add(id);
                    continue;
                }

                const record = buildArticleRecord({
                    id,
                    owner,
                    repo,
                    spec,
                    markdown,
                    style,
                    guardrails,
                    monetization,
                });

                articles.push(record);

                const marks = [
                    `${record.charCount}字`,
                    `画像${record.images.length}点`,
                    record.problems.length > 0 ? `気をつけること${record.problems.length}件` : null,
                    record.styleWarnings.length > 0 ? `体裁の指摘${record.styleWarnings.length}件` : null,
                ]
                    .filter(Boolean)
                    .join(' / ');
                info(`   ✓ ${label} — ${marks}`);
                for (const problem of record.problems) info(`      ⚠ ${problem}`);
            } catch (error) {
                // 1本の失敗で全部を止めない。ただし黙って飛ばすと
                // 「置いたのに出てこない」の理由がどこにも残らないので、最後にまとめて出す。
                failures.push(`${label} — ${error.message}`);
                failedIds.add(id);
            }
        }
    }

    if (args['dry-run']) {
        info(`\n（--dry-run のため書き出していません）記事 ${articles.length} 本`);
        reportFailures(failures);
        return;
    }

    const dir = paths.docs(ARTICLES_DIR);
    fs.mkdirSync(dir, { recursive: true });

    // 消えた記事を残さない。アプリ側で下書きを消したのに、ランチャーからは
    // いつまでも出せてしまう（しかも画像だけ 404 になる）という状態を作らない。
    //
    // ⚠️ 掃除をするのは全件を見たときだけ。--repo で1件だけ動かしたときに消すと、
    //    見ていない残り51件ぶんの記事が「無かったこと」になる。
    //
    // ⚠️ 読めなかったものも消さない。「アプリ側で消された」と「今回たまたま読めなかった」は
    //    別のことである。区別せずに消すと、GitHub が一時的に落ちた週に配信物が丸ごと空になり、
    //    しかもワークフローは緑のまま終わる（この工程は continue-on-error で回している）。
    const keep = new Set(articles.map((article) => `${article.id}.json`));
    let removed = 0;
    if (!args.repo && looked) {
        for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
            if (keep.has(name) || failedIds.has(name.replace(/\.json$/, ''))) continue;
            fs.unlinkSync(paths.docs(ARTICLES_DIR, name));
            removed += 1;
        }
    }

    for (const article of articles) {
        writeJson(paths.docs(ARTICLES_DIR, `${article.id}.json`), article);
    }

    // ⚠️ 一覧のファイルは作らない。
    //    見出しだけを別に持つと、本文のファイルと一覧のどちらが正なのかが決まらず、
    //    「一覧には出るのに開けない」「置いてあるのに一覧に無い」が起こりうる。
    //    ランチャーに載せる一覧は、置いたファイルそのものから組む
    //    （scripts/build-launcher-data.mjs）。正は1つでよい。

    info('');
    info(`①'' 完了 — ${rel(dir)} に ${articles.length} 本`);
    if (removed > 0) info(`   もう無い記事 ${removed} 本を消しました`);
    reportFailures(failures);
}

/**
 * 取り込めなかったものを最後にまとめて出す。
 *
 * 終了コードは 0 のままにする。ここは「あれば運ぶ」工程で、
 * 1本読めなかったことで週次の残り（X の投稿・note の下書き）まで止める理由が無い。
 * ただし黙りはしない（CLAUDE.md §6）。
 */
function reportFailures(failures) {
    if (failures.length === 0) return;
    console.error(`\n   取り込めなかった記事が ${failures.length} 本あります:`);
    for (const line of failures) console.error(`   ✖ ${line}`);
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(failWith);
}
