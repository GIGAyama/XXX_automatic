#!/usr/bin/env node
/**
 * github-pages 環境が、このブランチからの配信を許可しているかを先に確かめる。
 *
 *   node scripts/check-pages-env.mjs <ブランチ名>
 *
 * なぜ要るか:
 *   deploy ジョブには environment: github-pages が付いている。
 *   この環境に「配信を許可するブランチ」の制限がかかっていて、そこに
 *   いまのブランチが入っていないと、ジョブはステップを1つも実行しないまま
 *   1〜2秒で失敗する。しかもログが1行も残らないので、
 *   画面上は赤い × が出るだけで原因がまったく分からない。
 *
 *   実際に起きた例:
 *     既定ブランチの名前を変えた（別名 → main）あと、環境側の許可ブランチが
 *     古い名前のまま残っていて、main からの配信が拒否され続けた。
 *
 *   ここで先に見つけて、何をどう直すかまで出す。
 */

const API = 'https://api.github.com';

const branch = process.argv[2];
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

if (!branch) fail('ブランチ名を引数で渡してください: node scripts/check-pages-env.mjs main');
if (!repository) fail('GITHUB_REPOSITORY が設定されていません（GitHub Actions の中で動かす想定です）');

const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'xxx-automatic',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
};

/** 配信できないと分かったときに出す案内。ここが本体。 */
function guidance() {
    return `
GitHub の設定を1か所だけ直してください。

  Settings → Environments → github-pages
    → Deployment branches and tags

  ここで次のどちらかにします。

    ・「No restriction」を選ぶ（いちばん簡単）
    ・「Add deployment branch rule」で ${branch} を追加する

  直したら Actions →「GitHub Pages へ配信」→ Re-run failed jobs を押してください。

  （ブランチの名前を変えたことがあると、環境側に古い名前が残ってこうなります。）
`;
}

async function main() {
    const res = await fetch(`${API}/repos/${repository}/environments/github-pages`, { headers });

    // まだ環境が無いのはおかしくない（初回など）。configure-pages が作る。
    if (res.status === 404) {
        console.log('・github-pages 環境はまだありません。このあとの配信で作られます。');
        return;
    }

    // 環境の設定を読むには権限が要る。読めなくても配信自体はできるので、止めない。
    if (res.status === 403 || res.status === 401) {
        console.log(`::notice::github-pages 環境の設定を読み取れませんでした（HTTP ${res.status}）。`);
        console.log('配信が「1〜2秒でログも無く失敗」する場合は、次を確認してください。');
        console.log(guidance());
        return;
    }

    if (!res.ok) {
        console.log(`::notice::github-pages 環境を確認できませんでした（HTTP ${res.status}）。配信を続けます。`);
        return;
    }

    const env = await res.json();
    const policy = env.deployment_branch_policy;

    // null は「制限なし」。どのブランチからでも配信できる。
    if (!policy) {
        console.log(`✓ github-pages 環境はブランチを制限していません（${branch} から配信できます）`);
        return;
    }

    // 保護ブランチのみ許可。main が保護されていなければ弾かれる。
    if (policy.protected_branches) {
        console.error(`✖ github-pages 環境は「保護ブランチからのみ配信可」に設定されています。`);
        console.error(`   いまのブランチ（${branch}）が保護ブランチでない場合、配信は拒否されます。`);
        console.error(guidance());
        process.exit(1);
    }

    if (policy.custom_branch_policies) {
        const listRes = await fetch(`${API}/repos/${repository}/environments/github-pages/deployment-branch-policies`, {
            headers,
        });
        if (!listRes.ok) {
            console.log(`::notice::許可ブランチの一覧を読めませんでした（HTTP ${listRes.status}）。配信を続けます。`);
            return;
        }

        const { branch_policies: policies = [] } = await listRes.json();
        const names = policies.map((p) => p.name);

        if (names.some((name) => matches(name, branch))) {
            console.log(`✓ ${branch} は配信を許可されています（許可: ${names.join(', ')}）`);
            return;
        }

        console.error(`✖ github-pages 環境が ${branch} からの配信を許可していません。`);
        console.error(`   いま許可されているのは: ${names.length ? names.join(', ') : '（1つもありません）'}`);
        console.error(guidance());
        process.exit(1);
    }

    console.log('✓ github-pages 環境のブランチ制限は問題ありません');
}

/** GitHub の許可ブランチ名は * を含められる（例: releases/*）。 */
function matches(pattern, value) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(value);
}

function fail(message) {
    console.error(`\n✖ ${message}\n`);
    process.exit(1);
}

main().catch((error) => {
    // 確認そのものが落ちても配信は試させる。ここで止めるとかえって邪魔になる。
    console.log(`::notice::github-pages 環境の確認中にエラー: ${error.message}。配信を続けます。`);
});
