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
 */
import { getFile, getHeadSha, listPublicRepos, listRecentCommits } from './lib/github.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, rel, writeJson } from './lib/io.mjs';
import { jstStamp } from './lib/jst.mjs';

/** 読みにいくファイル。上から順に「そのアプリが何者か」を語る密度が高い。 */
const SOURCE_FILES = [
    { key: 'readme', path: 'README.md', maxChars: 12000 },
    { key: 'manual', path: 'MANUAL.md', maxChars: 8000 },
    { key: 'manifest', path: 'manifest.webmanifest', maxChars: 2000 },
    { key: 'packageJson', path: 'package.json', maxChars: 2000 },
];

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();
    const owner = accounts.githubOwner;

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
                pagesUrl: repo.has_pages ? `${accounts.pagesBase}${repo.name}/` : null,

                recentCommits: commits,
                source,
                hasReadme: Boolean(source.readme),
            });

            const marks = [
                source.readme ? 'README' : null,
                source.manual ? 'MANUAL' : null,
                repo.has_pages ? 'Pages' : null,
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
    if (withReadme < repos.length) {
        info(`   ※ README の無い ${repos.length - withReadme} 件は、説明文とコミットlog だけで紹介文を書きます`);
    }
}

main().catch(failWith);
