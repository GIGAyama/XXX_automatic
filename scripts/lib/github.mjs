/**
 * GitHub REST API を fetch で直接叩く薄い層。
 *
 * Octokit を入れないのは Gemini 側と同じ理由（依存を増やさない）。
 * ここで使うのは「公開リポジトリの一覧」と「ファイルの中身」の2種類だけである。
 *
 * トークンについて:
 *   GitHub Actions では標準の GITHUB_TOKEN で公開リポジトリを読める。
 *   ローカルで動かすときは、スコープ無しの Personal Access Token で足りる
 *   （公開情報しか読まないため）。トークン無しでも動くが、
 *   1時間あたり60リクエストしか通らないので55リポジトリだと途中で止まる。
 */

const API = 'https://api.github.com';

function headers() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const base = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'xxx-automatic',
    };
    return token ? { ...base, authorization: `Bearer ${token}` } : base;
}

async function request(pathOrUrl, extraHeaders = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
    const response = await fetch(url, { headers: { ...headers(), ...extraHeaders } });

    if (response.status === 404) return { ok: false, status: 404, body: null };

    if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0') {
            const resetAt = Number(response.headers.get('x-ratelimit-reset') || 0) * 1000;
            const waitSec = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
            throw new Error(
                `GitHub API のレート上限に達しました（あと ${waitSec} 秒で回復）。\n` +
                    'GITHUB_TOKEN を設定すると 1時間あたり 5,000 リクエストまで使えます。'
            );
        }
    }

    // 401 は「トークンが古い/権限が違う」がほとんど。生のメッセージ（Bad credentials）だけでは
    // 何を直せばよいか分からないので、外し方まで書いておく。
    if (response.status === 401) {
        throw new Error(
            'GitHub API が認証を拒否しました（401 Bad credentials）。\n' +
                '  GITHUB_TOKEN の値が古いか、このリポジトリ向けでない可能性があります。\n' +
                '  読むのは公開リポジトリだけなので、トークンを外しても動きます:\n' +
                '    env -u GITHUB_TOKEN -u GH_TOKEN node scripts/collect-repos.mjs\n' +
                '  （ただし未認証は 1時間あたり 60 リクエストまでなので、全件収集には足りません）'
        );
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`GitHub API ${response.status} ${url}: ${detail.slice(0, 300)}`);
    }

    return { ok: true, status: response.status, body: response, link: response.headers.get('link') };
}

/** ユーザーの公開リポジトリを全ページ分とる。 */
export async function listPublicRepos(owner) {
    const repos = [];
    let url = `${API}/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed&type=owner`;

    while (url) {
        const res = await request(url);
        if (!res.ok) break;
        repos.push(...(await res.body.json()));

        // Link ヘッダの rel="next" をたどる。ページ番号を自前で数えると、
        // 途中でリポジトリが増減したときに取りこぼす。
        const next = /<([^>]+)>;\s*rel="next"/.exec(res.link || '');
        url = next ? next[1] : null;
    }
    return repos;
}

/**
 * リポジトリ内のファイルを文字列でとる。無ければ null。
 * Accept: raw を指定すると base64 を経由せずそのまま返ってくる。
 */
export async function getFile(owner, repo, filePath, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const res = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}${query}`,
        { accept: 'application/vnd.github.raw' }
    );
    if (!res.ok) return null;
    return res.body.text();
}

/** 既定ブランチの最新コミット SHA。プロフィールのキャッシュ判定に使う。 */
export async function getHeadSha(owner, repo, branch) {
    const res = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`
    );
    if (!res.ok) return null;
    const json = await res.body.json();
    return json.sha ?? null;
}

/** 直近のコミットメッセージ。「アップデート報告」の型で何を直したかを書くために使う。 */
export async function listRecentCommits(owner, repo, branch, limit = 10) {
    const res = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
            `?sha=${encodeURIComponent(branch)}&per_page=${limit}`
    );
    if (!res.ok) return [];
    const json = await res.body.json();
    return json.map((c) => ({
        sha: c.sha?.slice(0, 7),
        date: c.commit?.author?.date ?? null,
        message: (c.commit?.message ?? '').split('\n')[0].slice(0, 200),
    }));
}

/** Issue を立てる（毎朝の通知に使う）。 */
export async function createIssue(owner, repo, { title, body, labels = [] }) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new Error('Issue を作るには GITHUB_TOKEN が必要です');

    const response = await fetch(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ title, body, labels }),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Issue の作成に失敗しました ${response.status}: ${detail.slice(0, 300)}`);
    }
    return response.json();
}
