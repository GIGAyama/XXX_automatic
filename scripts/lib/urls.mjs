/**
 * 公開 URL の組み立て規則。
 *
 * GIGAyama の全リポジトリで「リポジトリ名 = basePath」が守られているので、
 * リポジトリ名から機械的に決まる。規則が2か所に書かれていると、
 * 片方だけ直したときに「リンク先だけ古い」という直しにくいずれ方をする。
 */

/** そのアプリの公開 URL。GitHub Pages を持たないリポジトリは null。 */
export function pagesUrlFor(repoName, accounts, hasPages = true) {
    if (!hasPages) return null;
    const base = String(accounts.pagesBase ?? '').replace(/\/+$/, '');
    if (!base) return null;
    return `${base}/${repoName}/`;
}

/** ランチャー（このリポジトリの docs/）の URL。末尾のスラッシュをそろえる。 */
export function launcherUrlOf(accounts) {
    return String(accounts.launcherUrl ?? '').replace(/\/*$/, '/');
}

/** このリポジトリの GitHub URL。 */
export function repoUrlOf(accounts) {
    return `https://github.com/${accounts.githubOwner}/${accounts.repoName}`;
}
