#!/usr/bin/env node
/**
 * ⑤' アプリ一覧ページを作る。
 *
 *   node scripts/build-apps-page.mjs
 *
 * data/repos.json と data/profiles/*.json から docs/apps.html を組み立てる。
 *
 * なぜ要るのか:
 *   投稿からアプリに来てもらうのが目的なのに、着地できるのは個々のアプリだけだった。
 *   「ほかにも作っています」を見せる場所がどこにも無かったので、
 *   1つのアプリを見た人がそこで止まっていた。
 *
 * なぜ JSON + JS ではなく静的な HTML にするのか:
 *   このページは投稿の着地先である。検索と OGP に拾われることに意味がある。
 *   JS で描く形にすると、そのどちらにも弱くなる。
 *   作りなおすのは週1回・52件ぶんなので、差分の大きさは許容できる。
 *
 * ⚠️ index.html と同じ CSP を持たせる。style は docs/apps.css（外部ファイル）に置くこと。
 *    style-src 'self' なのでインラインの <style> は動かない。
 *
 * ⚠️ このページの CSP は script-src 'none'。JS を 1 バイトも動かさないと決めてある。
 *    だから利用規約とプライバシーへの行き先は、共通部品（docs/giga-app-links.js）
 *    ではなく素の <a> で書く。部品を置くために 'none' をゆるめないこと。
 *    ゆるめると、このページを静的な HTML にした理由（検索と OGP）まで薄まる。
 *    ランチャー（docs/index.html）のほうは JS が動くので、そちらは部品を使う。
 */
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { escapeHtml, subjectKeyOf } from './lib/card-template.mjs';
import { fail, info, loadConfig, paths, readJson, rel, writeText } from './lib/io.mjs';
import { launcherUrlOf, pagesUrlFor } from './lib/urls.mjs';

/** 教科の並び順。学校の時間割に近い順に置く。「その他」は最後。 */
const SUBJECT_ORDER = ['国語', '算数', '理科', '社会', '英語', '音楽', '体育', '学級経営', '校務', 'その他'];

function loadProfiles() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(paths.data('profiles', f)));
}

/** 教科ごとにまとめる。並べたときに自分の教科をすぐ見つけられるようにするため。 */
export function groupBySubject(apps) {
    const groups = new Map();
    for (const app of apps) {
        const key = subjectKeyOf(app.subject ?? '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(app);
    }
    for (const list of groups.values()) {
        list.sort((a, b) => (b.postability ?? 3) - (a.postability ?? 3) || a.name.localeCompare(b.name));
    }
    return [...groups.entries()].sort(
        (a, b) => orderOf(a[0]) - orderOf(b[0]) || b[1].length - a[1].length
    );
}

function orderOf(subject) {
    const i = SUBJECT_ORDER.indexOf(subject);
    return i === -1 ? SUBJECT_ORDER.length - 1 : i;
}

/** 見出しの id。日本語をそのまま id にすると URL がエンコードされて読みにくい。 */
function anchorOf(subject) {
    const i = SUBJECT_ORDER.indexOf(subject);
    return `g${i === -1 ? SUBJECT_ORDER.length : i}`;
}

function appCard(app, accounts) {
    const url = app.pagesUrl ?? pagesUrlFor(app.name, accounts, app.hasPages);
    const thumb = fs.existsSync(paths.media(`${app.name}-card.png`)) ? `media/${app.name}-card.png` : null;
    const code = `https://github.com/${accounts.githubOwner}/${app.name}`;

    const tags = [app.targetGrade, app.subject]
        .filter(Boolean)
        .map((t) => `<span class="app__tag">${escapeHtml(t)}</span>`)
        .join('');

    // ⚠️ ランチャーへの行き先は index.html（相対）。絶対 URL にしない。
    //    このページはランチャーと同じ場所から配信されるので、相対で足りるし、
    //    手元で `npm run serve` して見たときにも本番へ飛ばされない。
    //
    //    一覧を見ていて「これの話を書きたい」と思った瞬間に始められるようにするための導線である。
    //    ここが無かったあいだ、アプリを選ぶには 52 件の名前を思い出す必要があった。
    const make = `<a class="app__make" href="index.html#make/${encodeURIComponent(app.name)}">投稿をつくる</a>`;

    const links = url
        ? `<a class="app__open" href="${escapeHtml(url)}">ひらく</a><a class="app__code" href="${escapeHtml(code)}">ソース</a>${make}`
        : `<a class="app__code" href="${escapeHtml(code)}">GitHub で見る</a>${make}`;

    // 公開 URL が無いもの（Chrome 拡張・GAS など）は、開けない理由を書く。
    // ボタンだけあって押しても何も起きないより、書いてあるほうが親切である。
    const note = url ? '' : '<p class="app__nopages">ブラウザで直接ひらく形ではありません（拡張機能・スクリプトなど）。</p>';

    return `    <li class="app">
${thumb ? `      <img class="app__thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" width="1200" height="675">\n` : ''}      <div class="app__body">
        <h3 class="app__name">${escapeHtml(app.catchCopy || app.name)}</h3>
        <p class="app__one">${escapeHtml(app.oneLine ?? '')}</p>
        <div class="app__tags"><span class="app__tag">${escapeHtml(app.name)}</span>${tags}</div>
        ${note}
        <div class="app__links">${links}</div>
      </div>
    </li>`;
}

export function buildHtml({ groups, accounts, total, stamp }) {
    const jump = groups
        .map(([subject, list]) => `<a href="#${anchorOf(subject)}">${escapeHtml(subject)}（${list.length}）</a>`)
        .join('\n    ');

    // ⚠️ 教科の色は style 属性で書かない。
    //    CSP の style-src 'self' はインラインの style 属性も止める。
    //    ここだけのために 'unsafe-inline' を足すと、CSP を置いている意味が薄れる。
    //    色は apps.css の .group__mark--gN が持っている（教科の並び順と対応）。
    const sections = groups
        .map(([subject, list]) => {
            const anchor = anchorOf(subject);
            return `  <section class="group" id="${anchor}">
    <h2 class="group__title"><span class="group__mark group__mark--${anchor}"></span>${escapeHtml(subject)}<span class="group__count">${list.length}件</span></h2>
    <ul class="grid">
${list.map((app) => appCard(app, accounts)).join('\n')}
    </ul>
  </section>`;
        })
        .join('\n\n');

    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>つくった学習アプリの一覧</title>
<meta name="description" content="小学校の教室で使うために作った、ブラウザで動く学習アプリの一覧です。登録も費用もいりません。">
<meta name="theme-color" content="#1d3557">

<!-- 外部からは何も読みこまない。学校のネットワークは CDN を塞いでいることがある。 -->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">

<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="stylesheet" href="apps.css">
</head>
<body>
<div class="wrap">

  <header class="head">
    <h1>つくった学習アプリの一覧</h1>
    <p>小学校の教室で使うために作ったものです。ブラウザで開くだけで動き、登録も費用もいりません。<br>
       全${total}件。教科から探せます。</p>
  </header>

  <nav class="jump" aria-label="教科から探す">
    ${jump}
  </nav>

${sections}

  <footer class="foot">
    <p>この一覧は毎週自動で作りなおしています（最終更新: ${escapeHtml(stamp)}）。</p>
    <p><a href="${escapeHtml(launcherUrlOf(accounts))}">投稿ランチャー</a> ・
       <a href="https://github.com/${escapeHtml(accounts.githubOwner)}">GitHub</a> ・
       <a href="terms.html">利用規約</a> ・
       <a href="privacy.html">プライバシーポリシー</a></p>
  </footer>

</div>
</body>
</html>
`;
}

function main() {
    const { accounts } = loadConfig();
    const profiles = loadProfiles();
    if (profiles.length === 0) {
        fail('data/profiles/ が空です。先に `npm run profiles` を実行してください。');
    }

    // repos.json 側の情報（公開 URL の有無）を優先する。
    // profiles は Gemini が README を読んで作ったものなので、公開状態の真とはしない。
    const repos = readJson(paths.data('repos.json'), { repos: [] }).repos ?? [];
    const byName = new Map(repos.map((r) => [r.name, r]));
    const apps = profiles.map((p) => {
        const repo = byName.get(p.name);
        return {
            ...p,
            hasPages: repo?.hasPages ?? p.hasPages ?? false,
            pagesUrl: repo?.pagesUrl ?? p.pagesUrl ?? null,
        };
    });

    const groups = groupBySubject(apps);
    // ⚠️ ここに「いま」を入れない。
    //    実行するたびに中身が変わると、CI で「入力から作りなおしたものと一致するか」を
    //    確かめられなくなる（毎回ずれるので、本当のずれと区別がつかない）。
    //    材料を集めた時刻＝data/repos.json の生成時刻を使う。入力が同じなら結果も同じになる。
    const stamp = readJson(paths.data('repos.json'), {}).generatedAtJst ?? '不明';
    const html = buildHtml({ groups, accounts, total: apps.length, stamp });

    const outPath = paths.docs('apps.html');
    writeText(outPath, html);

    info(`⑤' 完了 — ${rel(outPath)}`);
    info(`   ${apps.length} 件を ${groups.length} 教科に分けました（${groups.map(([s, l]) => `${s}:${l.length}`).join(' / ')}）`);

    const noPages = apps.filter((a) => !a.pagesUrl).length;
    if (noPages > 0) info(`   ※ ${noPages} 件は公開 URL がないので「GitHub で見る」だけになります`);
}

// テストから import されたときは実行しない。
// ⚠️ `file://${process.argv[1]}` を文字列で組み立てて比べないこと。Windows や、空白・日本語を
//    含むパスでは一致せず、何も走らせないまま exit 0 になる（2026-08-28 / 2026-09-02）。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try {
        main();
    } catch (error) {
        fail(error.stack ?? error.message);
    }
}
