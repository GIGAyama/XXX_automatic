/**
 * 公開 URL の組み立て規則。
 *
 * 独自ドメイン giga-school.com に移行し、アプリごとに専用のサブドメインを持つ。
 *   旧: https://gigayama.github.io/XXX_automatic/   （リポジトリ名 = basePath）
 *   新: https://xxx-automatic.giga-school.com/      （リポジトリ名 = サブドメイン）
 * 各リポジトリの CNAME がこの規則どおりに置いてあるので、リポジトリ名から
 * 機械的に決まる。規則が2か所に書かれていると、片方だけ直したときに
 * 「リンク先だけ古い」という直しにくいずれ方をする。
 */

/**
 * リポジトリ名 → サブドメイン名。
 * 小文字にして、アンダースコアをハイフンに置きかえるだけ。
 * ホスト名にアンダースコアは使えないので、この置きかえは省略できない。
 */
export function subdomainFor(repoName) {
    return String(repoName).toLowerCase().replace(/_/g, '-');
}

/** そのアプリの公開 URL。GitHub Pages を持たないリポジトリは null。 */
export function pagesUrlFor(repoName, accounts, hasPages = true) {
    if (!hasPages) return null;
    const domain = String(accounts.appDomain ?? '').replace(/^\.+/, '').replace(/\/+$/, '');
    if (!domain) return null;
    return `https://${subdomainFor(repoName)}.${domain}/`;
}

/** ランチャー（このリポジトリの docs/）の URL。末尾のスラッシュをそろえる。 */
export function launcherUrlOf(accounts) {
    return String(accounts.launcherUrl ?? '').replace(/\/*$/, '/');
}

/** このリポジトリの GitHub URL。 */
export function repoUrlOf(accounts) {
    return `https://github.com/${accounts.githubOwner}/${accounts.repoName}`;
}
