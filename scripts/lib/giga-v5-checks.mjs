/**
 * =====================================================================
 * 【正本】standards/lib/giga-v5-checks.mjs — GIGA Standard v5 / Part I の検査
 * =====================================================================
 *
 * 各リポジトリへは scripts/lib/giga-v5-checks.mjs としてコピーする（中身は変えない）。
 * リポジトリ固有の値は quality.config.json に置き、呼び出し側（check-project.mjs）が
 * runGigaChecks(root, config) に渡す。アプリ固有の検査はこのファイルに書かず、
 * 各リポジトリの tools/ に置く。
 *
 * ■ 検査を書くときの決まりごと（実際に踏んだ穴）
 *
 *   1. 「消す式」を正規表現で追わない。
 *      caches.keys() の全削除をさがすとき、`caches.delete(k)` の形を追うと
 *      `(k) => caches.delete(k)` のような書き方を見のがす。
 *      見るべきは **`startsWith` でしぼっている式があるか**。
 *
 *   2. 判定の前にコメントを落とす。
 *      「localStorage はさわりません」という**注意書き**に反応して誤検知する。
 *
 *   3. 前方も見る。
 *      `@supports not (height: 100dvh) { … 100vh … }` は正しいフォールバック。
 *      100vh を見つけただけで落としてはいけない。
 *
 *   4. 引用符は ' と " の両方を受ける。
 *      addEventListener("install" と書くリポジトリがあり、['"] にしていない
 *      コピーは skipWaiting の検査が素通りしていた。
 *
 *   5. ハンドラの切れ目は「次の addEventListener」まで。
 *      install の次に message ハンドラ（正しい skipWaiting の置き場）が来る
 *      構成で、区間を event 名の決め打ちで切ると、並び順しだいで
 *      message の中の skipWaiting を install のものと誤判定する。
 *
 * ■ config（quality.config.json から呼び出し側が渡す）
 *   {
 *     "repoName": "Typa",              // E_STALE_REPO_PATH が /Typa/ をさがす
 *     "sw": "static",                  // static | vite | workbox | none
 *     "swSource": "sw.js",             // 検査する SW の原文（vite なら public/sw.js）
 *     "swVersionConst": "APP_VERSION", // 版の定数名（VERSION 等の別名を許す）
 *     "manifest": "manifest.webmanifest",
 *     "siteRoot": ".",                 // 配信の起点。Vite 型は "public"
 *     "jsDirs": ["js"], "cssDirs": ["css"],
 *     "htmlFiles": ["index.html", "offline.html"],
 *     "imageDirs": ["icons", "img", "images"],
 *     "fluidTypeMin": 3,
 *     "allowedRemoteScripts": ["^https://fonts\\.googleapis\\.com/"],
 *     "skips": [{ "id": "D_CANVAS_DPR", "reason": "Canvas を使わない" }]
 *   }
 *   skips は「検査をゆるめる」のではなく、事情を理由つきで明示する場所。
 *   理由の無い skip は受け付けない。
 */
import fs from 'node:fs';
import path from 'node:path';

/** JavaScript / CSS のコメントを落とす（判定の前に必ず通す） */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code';   // code | line | block | str | tpl
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'") { mode = 'str'; quote = c; out += c; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += c; i++; } continue; }
    // 文字列は生の改行を含められないので、行末で必ず code に戻す。
    // 正規表現リテラルの中の引用符（/…'…/）を文字列開始と取りちがえても、
    // 状態のずれがその行の中で止まり、後続のコメントを見のがさない
    // （実際に reading-books の app.js で誤検知が起きた）。
    if (mode === 'str') { if (c === '\\') { out += c + (n || ''); i += 2; continue; } if (c === quote || c === '\n') mode = 'code'; out += c; i++; continue; }
    if (mode === 'tpl') { if (c === '\\') { out += c + (n || ''); i += 2; continue; } if (c === '`') mode = 'code'; out += c; i++; continue; }
  }
  return out;
}

/**
 * HTML の中身から、判定の前にコメントを落とす（HTML コメントも JS コメントも）。
 *
 * ⚠️ 順番を入れ替えて `stripComments(s).replace(/<!--…-->/g, ' ')` にしないこと。
 *    stripComments() は JavaScript の規則で読むので、HTML コメントの中に
 *    `assets/*.css` のような字面があると `/*` をブロックコメントの開始と
 *    取りちがえ、そのコメント自身の `-->` まで食べてしまう。
 *    残された `<!--` は、ずっと後ろにある別の `-->` と対になり、
 *    あいだの <script src="…"> がまるごと消える。
 *    2026-08-30、Quarto の index.html がまさにこの形だった。
 *    B_NO_CDN_CODE に CDN の <script> をわざと注ぎこんでも落ちず、
 *    `npm run check:self` だけがそれを見つけた（`npm run check` は緑のまま）。
 *    HTML コメントを先に落とせば、その中の字面は JS の目に触れない。
 */
export function stripHtmlComments(src) {
  return stripComments(String(src == null ? '' : src).replace(/<!--[\s\S]*?-->/g, ' '));
}

const DEFAULTS = {
  repoName: null,
  sw: 'static',
  swSource: null,               // 未指定なら sw に応じて既定を選ぶ
  swVersionConst: null,         // 未指定なら APP_VERSION / VERSION の両方を受ける
  manifest: 'manifest.webmanifest',
  // 配信の起点。静的にコミットするアプリは直下がそのまま配られるので '.'。
  // Vite 型は public/ の中身が配信の直下に来るので "public" を指定する。
  // manifest やアイコンの src は「配信されたときのパス」で書いてあるため、
  // ここを見ないとファイルの実体を取りちがえる（実際 digitalcloset で
  // offline.html とアイコン3件が「ありません」と誤検知した）。
  siteRoot: '.',
  // 入口のページ。多くのリポジトリは直下の index.html だが、GitHub Pages を
  // docs/ から配るリポジトリ（SchoolPlan_Editor）は 'docs/index.html' になる。
  // ここを決め打ちにしていたせいで、そういうリポジトリでは CSP も viewport も
  // インストールの合図も「index.html がありません」で落ちていた（2026-08-23）。
  entryHtml: 'index.html',
  // 版を刻む道具の場所。ほとんどのリポジトリは tools/build-sw.mjs だが、
  // 道具を scripts/ にまとめているリポジトリ（xxx_automatic）は
  // 'scripts/build-sw.mjs' になる。ここを決め打ちにしていたせいで、
  // 版を正しく自動生成しているのに「自動生成が外れています」と落ちていた
  // （entryHtml #58・E_CNAME #59 と同じ形の決め打ち。3件目）（2026-08-23）。
  swBuilder: 'tools/build-sw.mjs',
  jsDirs: ['js'],
  cssDirs: ['css'],
  htmlFiles: ['index.html', 'offline.html'],
  imageDirs: ['icons', 'img', 'images'],
  fluidTypeMin: 3,
  allowedRemoteScripts: [],
  skips: [],
};

const read = (root, rel) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
/**
 * 配信されるファイルの実体の場所。
 *
 * manifest やアイコンの src、offline.html は「配信されたときのパス」で
 * 書いてある。静的にコミットするアプリは直下がそのまま配られるので
 * これは実体の場所と一致するが、Vite 型では public/ の中身が配信の直下に
 * 来るので一致しない。cfg.siteRoot を挟まないと「ファイルがありません」と
 * 誤検知する。
 */
const sitePath = (root, cfg, rel) => path.join(root, cfg.siteRoot, rel.replace(/^\.?\//, ''));
const siteRead = (root, cfg, rel) => {
  const p = sitePath(root, cfg, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
/**
 * 走査から外す置き場。ここは「このアプリの画面をつくっているコード」ではない。
 *
 * ⚠️ 外さないと何が起きるか（2026-08-22 に実際に起きた）:
 *    ice_slide-puzzle は jsDirs が ["."]。下の階層まで見るようにした
 *    とたん、**ゲート自身**（scripts/lib/giga-v5-checks.mjs）と
 *    同梱の vendor/sweetalert2.all.min.js を読みはじめ、
 *    検査の説明に出てくる <img> や localStorage.clear() を
 *    アプリのコードとして 4件の違反に数えた。
 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git',
  'vendor',            // 同梱した他人のコード。直せないものを数えても意味がない
  'scripts', 'tools',  // ゲートと道具。アプリの画面をつくっていない
  'tests', 'test', '__tests__',
  '.standards-src',
]);

/**
 * dir の下からその拡張子のファイルを集める。**下の階層まで見る。**
 *
 * かつては直下しか見ていなかった。reversi の src/lib/ のように1段でも
 * 深いと丸ごと見のがし、そこに何を書いても検査が反応しなかった。
 */
const listFiles = (root, dir, exts, skip = SKIP_DIRS) => {
  const want = Array.isArray(exts) ? exts : [exts];
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      if (skip.has(name)) continue;
      const next = path.join(rel, name);
      if (fs.statSync(path.join(root, next)).isDirectory()) { walk(next); continue; }
      if (want.some((e) => name.endsWith(e))) out.push(next);
    }
  };
  walk(dir);
  return out;
};

/**
 * JavaScript として読むもの。
 *
 * ⚠️ '.js' だけを見ていた時期がある。React で書いたアプリの本体は .jsx
 *    なので、B_NO_SECRETS も C_PAGEHIDE も **ほぼ何も見ないまま緑**を
 *    返していた（2026-08-22、digitalcloset の src/App.jsx にある
 *    pagehide を取りこぼして発覚）。
 */
const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];
/**
 * CNAME の置き場。
 *
 * ⚠️ リポジトリによって違う。配信の起点に置くのが本当だが、直下にあることもある。
 *    片方に決め打ちすると、もう片方のリポジトリでは「独自ドメインをつかって
 *    いません」と言って**黙って通る**。落ちるのではなく通るので、いちばん
 *    気づけない。E_CNAME でこれをやって SchoolPlan_Editor を素通りさせ（#59）、
 *    同じ決め打ちが E_STALE_REPO_PATH にも残っていた（2026-08-23）。
 *    3か所目を作らないために、ここ1つにまとめる。
 */
const cnamePath = (root, cfg) => [sitePath(root, cfg, 'CNAME'), path.join(root, 'CNAME')]
  .find((c) => fs.existsSync(c)) || null;

/**
 * 画面をつくっている JavaScript の一覧。
 *
 * ⚠️ Service Worker は外す。あれは画面のコードではないし、専用の検査
 *    （E_SW_*）がべつに見ている。混ぜると、SW 側に書いてあるだけの語が
 *    画面側の検査を満たしてしまう。
 *    jsDirs が配信ディレクトリそのもの（xxx_automatic の ["docs"]）だと
 *    sw.js が混ざり、画面から SKIP_WAITING を丸ごと消しても
 *    E_SW_UPDATE_PROMPT が通った。sw.js 側の SKIP_WAITING が身代わりに
 *    なっていた（2026-08-23 実測）。C_PAGEHIDE も同じ形で身代わりが効く。
 */
const jsFiles = (root, cfg) => {
  const sw = path.normalize(swSourceOf(cfg));
  return cfg.jsDirs.flatMap((d) => listFiles(root, d, JS_EXTS)).filter((r) => path.normalize(r) !== sw);
};
const cssFiles = (root, cfg) => cfg.cssDirs.flatMap((d) => listFiles(root, d, '.css'));
// CSS の中身の一覧。単一 HTML 型のアプリはスタイルを <style> に書くので、
// .css ファイルに加えて htmlFiles の <style> ブロックも数える。
// @param {boolean} [withOffline=true] offline.html の <style> も含めるか
const cssSources = (root, cfg, withOffline = true) => [
  ...cssFiles(root, cfg).map((rel) => ({ rel, css: read(root, rel) || '' })),
  ...cfg.htmlFiles
    .filter((rel) => withOffline || path.basename(rel) !== 'offline.html')
    .flatMap((rel) => {
      const s = read(root, rel);
      if (!s) return [];
      // ⚠️ 先に HTML コメントを落とす。
      //    説明文の中に <style> と書いてあると（CSP の注意書きなどでよくある）、
      //    そこから本物の </style> までが丸ごと「CSS」として読まれる。
      //    Quarto の index.html では、そうやって取りこまれた 3,164 文字の
      //    説明文の中に prefers-reduced-motion という語があり、
      //    本物の CSS からその指定を消しても D_REDUCED_MOTION が通っていた
      //    （2026-08-23）。検査が「書いてある言葉」で満たされてはいけない。
      const blocks = [...s.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
      return blocks.length ? [{ rel: `${rel} の <style>`, css: blocks.join('\n') }] : [];
    }),
];

/**
 * 「アプリの画面が◯◯に対応しているか」を見る検査のための CSS。
 *
 * offline.html を外す。あれは圏外のときだけ出る、外部資産にも JavaScript にも
 * たよらない小さな一枚で、その中の <style> はアプリ本体のスタイルではない。
 * 混ぜていたせいで、本体 CSS から env(safe-area-inset) や clamp() や
 * forced-colors を全部消しても検査が緑のままになっていた。
 * 実際 typa の self-test は D_SAFE_AREA / D_FLUID_TYPE / D_FORCED_COLORS を
 * 「こわしたのに 通りました」と報告し続けていた。
 */
const appCssSources = (root, cfg) => cssSources(root, cfg, false);
/**
 * addEventListener(..., () => { … }) のハンドラ本体を取り出す。
 *
 * 以前は目印から 400 文字を切り出して見ていた。すると、すぐ下にある別の
 * 関数の見はり（`if (!worker) return;` など）まで窓に入り、
 * controllerchange 側の見はりを丸ごと消しても「見はりがある」と読めてしまう。
 * 実際 Reversi の移行（2026-08-23）で、見はりの行を削っても落ちなかった。
 * 中かっこの対応でハンドラの終わりまでを取れば、隣の関数を巻きこまない。
 *
 * ハンドラを名前で渡している形（addEventListener('x', onChange)）では近くに
 * `{` が無い。そのときだけ、これまでどおり 400 文字の窓で見る。
 */
export function handlerBody(js, from) {
  const open = js.indexOf('{', from);
  if (open < 0 || open - from > 120) return js.slice(from, from + 400);
  let depth = 0;
  for (let i = open; i < js.length; i += 1) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') {
      depth -= 1;
      if (depth === 0) return js.slice(from, i + 1);
    }
  }
  return js.slice(from);
}

const swSourceOf = (cfg) => cfg.swSource || (cfg.sw === 'vite' ? 'public/sw.js' : 'sw.js');

/**
 * 検査の定義。run(root, cfg) は { ok, detail[], skip? } を返す。
 * skip は「このリポジトリでは対象がない」の説明（ok:true と併用）。
 */
export const CHECKS = [
  {
    id: 'A_LICENSE',
    title: 'LICENSE が実ファイルである',
    run: (root) => {
      const s = read(root, 'LICENSE');
      if (!s) return { ok: false, detail: ['LICENSE がありません'] };
      if (!/Copyright \(c\)/i.test(s)) return { ok: false, detail: ['LICENSE に著作権表示がありません'] };
      return { ok: true, detail: [] };
    },
  },
  {
    id: 'A_GITIGNORE',
    title: '.gitignore が秘密ファイルを除いている',
    run: (root) => {
      const s = read(root, '.gitignore');
      if (!s) return { ok: false, detail: ['.gitignore がありません'] };
      const missing = ['node_modules', '.env'].filter((k) => !s.includes(k));
      return { ok: missing.length === 0, detail: missing.map((m) => `${m} の行がありません`) };
    },
  },
  {
    id: 'A_DEPENDABOT',
    title: 'dependabot.yml がある',
    run: (root) => ({
      ok: !!read(root, '.github/dependabot.yml'),
      detail: ['.github/dependabot.yml がありません'],
    }),
  },
  {
    id: 'A_CI_ON_PR',
    title: 'CI が pull_request でも走る',
    run: (root) => {
      const files = listFiles(root, '.github/workflows', '.yml');
      if (!files.length) return { ok: false, detail: ['.github/workflows にワークフローがありません'] };
      const any = files.some((f) => /^\s*pull_request\s*:/m.test(read(root, f) || ''));
      return { ok: any, detail: ['push だけでは PR の時点で落ちていることに気づけません'] };
    },
  },
  {
    id: 'A_DOCS',
    title: 'README / MANUAL / AUDIT がある',
    run: (root) => {
      const missing = ['README.md', 'MANUAL.md', 'AUDIT.md'].filter((f) => !read(root, f));
      return { ok: missing.length === 0, detail: missing.map((m) => `${m} がありません`) };
    },
  },

  {
    id: 'B_NO_CDN_CODE',
    title: '外のホストから読む資産が 0 件（CDN のコード・書体・画像・CSS）',
    run: (root, cfg) => {
      /* ⚠️ `https?://` だけを見ていた時期がある。2026-08-28、この検査が「0 件」と
       *    言うのに実ブラウザは外を読んでいた（①スキームを省いた //cdn… ②<img src>
       *    ③印刷ウィンドウの中の @import）。エージェント用の lint-giga は直したのに、
       *    **CI が走らせるこちら**は 2026-09-02 まで同じ穴のままだった。
       *    見るのは「読みこむ」もの。<a href> は行き先のリンクであって資産の取得では
       *    ない（フッターの giga-school.com へのリンクを誤検知した）。preconnect も
       *    取得ではないが、宛先の申告なので stylesheet 等と同じ扱いで許可リストに
       *    載せてもらう。 */
      const allowed = cfg.allowedRemoteScripts.map((re) => new RegExp(re));
      const ATTR = String.raw`((?:https?:)?\/\/[^"']+)`;       // 引用符つきの属性値・JS の文字列
      const CSSU = String.raw`((?:https?:)?\/\/[^"')\s;]+)`;   // url( ) の中。引用符が無いことが多い
      const quoted = (prefix, flags = 'g') => new RegExp(prefix + '["\']' + ATTR + '["\']', flags);
      const HTML_LOADERS = [
        quoted(String.raw`<(?:script|iframe|img|source|video|audio|track|embed)\b[^>]*\ssrc\s*=\s*`, 'gi'),
        quoted(String.raw`<link\b[^>]*\shref\s*=\s*`, 'gi'),
        quoted(String.raw`<object\b[^>]*\sdata\s*=\s*`, 'gi'),
        quoted(String.raw`<video\b[^>]*\sposter\s*=\s*`, 'gi'),
        quoted(String.raw`<(?:use|image)\b[^>]*\s(?:xlink:)?href\s*=\s*`, 'gi'),
      ];
      // JS からの動的な読み込み。ESM の import と Worker、SW の importScripts も
      const JS_LOADERS = [
        quoted(String.raw`importScripts\(\s*`),
        quoted(String.raw`\.src\s*=\s*`),
        quoted(String.raw`\.setAttribute\(\s*["']src["']\s*,\s*`),
        quoted(String.raw`\bimport\s*\(\s*`),
        quoted(String.raw`\bfrom\s+`),
        quoted(String.raw`new\s+Worker\(\s*`),
      ];
      // CSS。書体（@import / @font-face の url）と画像（background の url）
      const CSS_LOADERS = [
        new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?` + CSSU, 'g'),
        new RegExp(String.raw`\burl\(\s*["']?` + CSSU, 'g'),
      ];
      const SRCSET = /\ssrcset\s*=\s*["']([^"']*)["']/gi;
      const REMOTE = /^(?:https?:)?\/\//;
      const ALL = [...HTML_LOADERS, ...JS_LOADERS, ...CSS_LOADERS];

      const bad = new Set();   // @import url(…) は 2 つの形に当たるので、同じ指摘は 1 つにまとめる
      const report = (rel, url) => {
        if (allowed.some((a) => a.test(url))) return;
        bad.add(`${rel}: ${url} を読んでいます`);
      };
      const scan = (rel, code, patterns) => {
        for (const re of patterns) for (const m of code.matchAll(re)) report(rel, m[1]);
        // srcset は「URL 幅, URL 幅」の並び。候補ごとに見る
        for (const m of code.matchAll(SRCSET)) {
          for (const cand of m[1].split(',')) {
            const url = cand.trim().split(/\s+/)[0];
            if (REMOTE.test(url)) report(rel, url);
          }
        }
      };

      /* CSS のコメントは /* … *\/ だけ。stripComments() は JS の規則で `//` を行末まで
         落とすので、引用符の無い url(https://…) がコメント扱いで消える。CSS には使わない。 */
      const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

      for (const rel of cfg.htmlFiles) {
        const s = read(root, rel);
        if (!s) continue;
        const code = stripHtmlComments(s);
        scan(rel, code, ALL);
        /* <style> の中は CSS として別に見る。上の code は JS の規則でコメントを落として
           あるので、<style>@import url(https://…)</style> の `//` から行末までが消えている。
           単一 HTML 型のアプリはスタイルを <style> に書くので、ここを見ないと書体の
           取り寄せが素通りする。 */
        const noHtmlComments = s.replace(/<!--[\s\S]*?-->/g, ' ');
        for (const m of noHtmlComments.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
          scan(`${rel} の <style>`, stripCssComments(m[1]), CSS_LOADERS);
        }
        if (/babel\/standalone|cdn\.tailwindcss\.com/.test(code)) bad.add(`${rel}: ブラウザの中でコンパイルしています`);
      }
      /* JS は HTML も CSS も文字列で組み立てる（印刷ウィンドウの <link> や @import）ので、
         3 種すべてを当てる。Service Worker も見る。jsFiles() は SW を外すが、
         importScripts で CDN の workbox を読むのは SW の中でしか起きない。 */
      const sw = swSourceOf(cfg);
      for (const rel of [...jsFiles(root, cfg), ...(read(root, sw) ? [sw] : [])]) {
        const s = read(root, rel);
        if (!s) continue;
        scan(rel, stripComments(s), ALL);
      }
      for (const rel of cssFiles(root, cfg)) {
        const s = read(root, rel);
        if (!s) continue;
        scan(rel, stripCssComments(s), CSS_LOADERS);
      }
      return { ok: bad.size === 0, detail: [...bad] };
    },
  },
  {
    id: 'B_NO_SECRETS',
    title: 'API キー・秘密鍵の直書きがない',
    run: (root, cfg) => {
      const bad = [];
      for (const rel of [...cfg.htmlFiles, ...jsFiles(root, cfg)]) {
        const s = read(root, rel);
        if (!s) continue;
        // AIza… は Google API キーの形。BEGIN PRIVATE KEY は鍵そのもの。
        if (/AIza[0-9A-Za-z_-]{35}/.test(s)) bad.push(`${rel}: Google API キーらしき文字列があります`);
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) bad.push(`${rel}: 秘密鍵があります`);
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'B_CSP',
    title: 'CSP があり、script-src がしまっている',
    run: (root, cfg) => {
      const s = read(root, cfg.entryHtml);
      if (!s) return { ok: false, detail: ['index.html がありません'] };
      const m = s.match(/http-equiv=["']Content-Security-Policy["'][^>]*content=["']([\s\S]*?)["']\s*\/?>/i);
      if (!m) return { ok: false, detail: ['CSP の <meta> がありません'] };
      const csp = m[1];
      const bad = [];
      const script = (csp.match(/script-src([^;]*)/) || [])[1] || '';
      if (!/'self'/.test(script)) bad.push("script-src に 'self' がありません");
      if (/'unsafe-inline'|'unsafe-eval'/.test(script)) bad.push('script-src に unsafe-inline / unsafe-eval があります');
      // frame-ancestors は <meta> では無視される（書くと警告が出るだけ）
      if (/frame-ancestors/.test(csp)) bad.push('frame-ancestors は <meta> では無視されます。HTTP ヘッダーで設定してください');
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'B_NO_INLINE_SCRIPT',
    title: 'index.html にインラインの <script> と onclick= がない',
    run: (root, cfg) => {
      const s = read(root, cfg.entryHtml);
      if (!s) return { ok: false, detail: ['index.html がありません'] };
      // コメントの中の例示に反応しないよう、HTML コメントを落としてから見る
      const html = s.replace(/<!--[\s\S]*?-->/g, '');
      const bad = [];
      for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (m[1].trim()) bad.push('中身のある <script> があります（CSP で動きません）');
      }
      if (/\son[a-z]+\s*=\s*["']/i.test(html)) bad.push('onclick= などの属性があります（CSP で動きません）');
      return { ok: bad.length === 0, detail: bad };
    },
  },

  {
    id: 'C_NO_LS_CLEAR',
    title: 'localStorage.clear() をつかっていない',
    run: (root, cfg) => {
      const bad = [];
      for (const rel of jsFiles(root, cfg)) {
        // ⚠️ コメントを落としてから見る。注意書きに反応して誤検知する
        if (/localStorage\s*\.\s*clear\s*\(/.test(stripComments(read(root, rel)))) bad.push(`${rel} でつかっています`);
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'C_PAGEHIDE',
    title: 'pagehide できろくを確定している',
    run: (root, cfg) => {
      // records-hub-client.js（正本コピー）の pagehide は記録ハブへの写しの
      // 送信で、アプリ自身の確定保存ではない。混ぜると本体の保存が消えても
      // 通ってしまうので、除いて見る。
      const hit = jsFiles(root, cfg)
        .filter((rel) => path.basename(rel) !== 'records-hub-client.js')
        .some((rel) => /addEventListener\(\s*['"]pagehide['"]/.test(stripComments(read(root, rel))));
      return { ok: hit, detail: ['Chromebook はメモリ不足でタブをすてます。pagehide で締めてください'] };
    },
  },
  {
    id: 'C_NO_POSTMESSAGE_STAR',
    title: "postMessage の宛先が '*' でない",
    run: (root, cfg) => {
      const bad = [];
      for (const rel of jsFiles(root, cfg)) {
        if (/\.postMessage\([^)]*,\s*['"]\*['"]\s*\)/.test(stripComments(read(root, rel)))) bad.push(rel);
      }
      return { ok: bad.length === 0, detail: bad.map((f) => `${f} で宛先が '*' です`) };
    },
  },

  {
    id: 'D_VIEWPORT',
    title: 'viewport が viewport-fit=cover で、拡大を禁止していない',
    run: (root, cfg) => {
      const s = read(root, cfg.entryHtml);
      const m = s && s.match(/<meta\s+name=["']viewport["'][^>]*content=["']([^"']+)["']/i);
      if (!m) return { ok: false, detail: ['viewport の <meta> がありません'] };
      const bad = [];
      if (!/viewport-fit\s*=\s*cover/.test(m[1])) bad.push('viewport-fit=cover がありません');
      if (/user-scalable\s*=\s*no/.test(m[1])) bad.push('user-scalable=no があります（見えづらい子が拡大できません）');
      if (/maximum-scale\s*=\s*1(\.0)?\b/.test(m[1])) bad.push('maximum-scale=1.0 があります');
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'D_DVH',
    title: '100vh を単独でつかっていない',
    run: (root, cfg) => {
      const bad = [];
      for (const rel of [...cssFiles(root, cfg), ...cfg.htmlFiles]) {
        const s = read(root, rel);
        if (!s) continue;
        // ⚠️ 前方も見る。@supports not (height: 100dvh) の中の 100vh は正しいひかえ。
        //    min-height / max-height で書くリポジトリもあるので、height の変種を受ける
        const css = s.replace(/\/\*[\s\S]*?\*\//g, '');
        const guards = [];
        const re = /@supports\s+not\s*\(\s*(?:min-|max-)?height\s*:\s*100dvh\s*\)\s*\{/g;
        let g;
        while ((g = re.exec(css))) {
          // 対応する } までをひかえの区間とする
          let depth = 1; let i = re.lastIndex;
          while (i < css.length && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
          guards.push([g.index, i]);
        }
        for (const m of css.matchAll(/\b100vh\b/g)) {
          const inGuard = guards.some(([a, b]) => m.index > a && m.index < b);
          // カスケードの上書き（min-height:100vh; min-height:100dvh;）も正しいひかえ。
          // 近く（前後250文字）に dvh の指定があれば、100vh は古いブラウザ向けの行と見なす
          const near = css.slice(Math.max(0, m.index - 250), m.index + 250);
          const hasDvhNearby = /\b100dvh\b/.test(near);
          if (!inGuard && !hasDvhNearby) bad.push(`${rel}: ひかえ（@supports か 100dvh の上書き）なしで 100vh をつかっています`);
        }
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'D_SAFE_AREA',
    title: 'safe-area-inset をつかっている',
    run: (root, cfg) => {
      const n = appCssSources(root, cfg)
        .reduce((a, { css }) => a + (css.match(/env\(\s*safe-area-inset/g) || []).length, 0);
      return { ok: n > 0, detail: ['ノッチ・ホームバーのぶんを足していません'] };
    },
  },
  {
    id: 'D_FLUID_TYPE',
    title: 'clamp() で文字の大きさを決めている',
    run: (root, cfg) => {
      const n = appCssSources(root, cfg)
        .reduce((a, { css }) => a + (css.match(/clamp\(/g) || []).length, 0);
      return { ok: n >= cfg.fluidTypeMin, detail: [`clamp() が ${n} か所しかありません（目安 ${cfg.fluidTypeMin}）`] };
    },
  },
  {
    id: 'D_CANVAS_DPR',
    title: 'Canvas に devicePixelRatio の補正がある（Canvas をつかうときだけ）',
    run: (root, cfg) => {
      const files = jsFiles(root, cfg).filter((rel) => /getContext\(\s*['"]2d['"]/.test(stripComments(read(root, rel))));
      if (!files.length) return { ok: true, detail: [], skip: 'Canvas をつかっていません' };
      const bad = files.filter((rel) => !/devicePixelRatio/.test(stripComments(read(root, rel))));
      return { ok: bad.length === 0, detail: bad.map((f) => `${f}: DPR 補正がありません（高DPI機でぼやけます）`) };
    },
  },
  {
    id: 'D_REDUCED_MOTION',
    title: 'prefers-reduced-motion に対応し、0 ではなく .01ms 以下の実数',
    run: (root, cfg) => {
      const css = appCssSources(root, cfg).map((x) => x.css).join('\n');
      if (!/prefers-reduced-motion/.test(css)) return { ok: false, detail: ['対応していません'] };
      const bad = [];
      // 0 にすると animation-fill-mode: forwards が効かず、中身が消える
      if (/animation-duration\s*:\s*0(m?s)?\s*(!important)?\s*;/.test(css)) bad.push('animation-duration が 0 です（fill-mode: forwards が効かず中身が消えます）');
      if (/transition-duration\s*:\s*0(m?s)?\s*(!important)?\s*;/.test(css)) bad.push('transition-duration が 0 です');
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'D_FORCED_COLORS',
    title: 'forced-colors（ハイコントラスト）に対応している',
    run: (root, cfg) => {
      const css = appCssSources(root, cfg).map((x) => x.css).join('\n');
      return { ok: /forced-colors\s*:\s*active/.test(css), detail: ['地の色が無効にされると、押せることが分からなくなります'] };
    },
  },
  {
    id: 'D_RT_COLOR',
    title: 'ふりがな（rt）の色を決め打ちしていない',
    run: (root, cfg) => {
      const bad = [];
      for (const { rel, css: rawCss } of cssSources(root, cfg)) {
        const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of css.matchAll(/(^|[},])\s*rt\s*\{([^}]*)\}/g)) {
          const body = m[2];
          if (/color\s*:/.test(body) && !/color\s*:\s*inherit/.test(body)) {
            // 色のついた面で継がせる手当てがあればよい。
            //
            // ⚠️ 手当ては「rt を指す規則」でなければならない。
            //    かつては [class*="bg-" や button\s+rt を CSS のどこかから
            //    探すだけだったので、ふりがなと関係のない
            //      [class*="bg-primary"] .text-primary { … }
            //    が身代わりになり、**手当てを丸ごと消して rt に色を決め打ちしても
            //    通っていた**（2026-08-23 に mirai-compass で実測）。
            //    Bootstrap 風の bg- ユーティリティを使う CSS では、この検査が
            //    まるごと効かなくなる。セレクタが rt を含むことまで見る。
            const remedy = /(^|[},])[^{}]*\brt\s*\{[^}]*color\s*:\s*inherit/.test(css);
            if (!remedy) {
              bad.push(`${rel}: rt に色を決め打ちしています（色のついた面で読めなくなります）`);
            }
          }
        }
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'F_LABEL_FOR_TABBABLE',
    title: '<label for> のさす部品が Tab の順から外れていない',
    /*
     * F3（キーボードのみで全機能に到達）が静的に見えるただ1つの形。
     *
     * <label class="btn" for="x">えらぶ</label>
     * <input type="file" id="x" hidden>          ← これ
     *
     * label はそれ自身 Tab に乗らない。さす先が hidden（＝ display:none）だと、
     * **マウスでしか押せないボタン**になる。ビルドも静的解析も通り、画面も
     * ふつうに出るので気づけない。実際に Typa の「ファイルをえらぶ」が
     * この形で、キーボードだけの人は書き出したきろくを読みこむ手が
     * まったくなかった。
     *
     * 見えなくすること自体は問題ではない。
     * position:absolute + opacity:0 なら Tab にはのこる。
     * **hidden / display:none だけ**を落とす。
     */
    run: (root, cfg) => {
      const bad = [];
      const sources = [cfg.entryHtml, ...jsFiles(root, cfg)];
      for (const rel of sources) {
        const src = read(root, rel);
        if (src === null) continue;
        const wanted = new Set();
        for (const m of src.matchAll(/<label[^>]*\sfor=["']([^"']+)["']/g)) wanted.add(m[1]);
        if (!wanted.size) continue;
        for (const id of wanted) {
          const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`<(input|select|textarea|button)\\b[^>]*\\bid=["']${esc}["'][^>]*>`, 'g');
          for (const m of src.matchAll(re)) {
            const tag = m[0];
            if (/\shidden(\s|>|=)/.test(tag) || /display\s*:\s*none/.test(tag)) {
              bad.push(`${rel}: <label for="${id}"> のさす ${m[1]} が Tab の順から外れています`
                + '（hidden／display:none ではなく、position:absolute + opacity:0 で見えなくします）');
            }
          }
        }
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },

  {
    id: 'E_MANIFEST_ID',
    title: 'manifest の id / scope / start_url が配信場所と合っている',
    run: (root, cfg) => {
      const s = read(root, cfg.manifest);
      if (!s) return { ok: false, detail: [`${cfg.manifest} がありません`] };
      let j;
      try { j = JSON.parse(s); } catch (e) { return { ok: false, detail: ['JSON として読めません: ' + e.message] }; }
      const bad = [];
      // 正しい値は「どこで配信するか」で変わる。
      //
      // 独自ドメイン（CNAME あり）だとアプリはサブドメインの直下に置かれる。
      //   https://typa.giga-school.com/
      // ここで scope を /Typa/ のままにすると、scope がページの URL を含まなくなり、
      // manifest ごと無視されて PWA としてインストールできなくなる。
      //
      // CNAME がなければ共有オリジンのサブディレクトリ配信なので
      //   https://（ID）.github.io/Typa/
      // リポジトリ名の絶対パスでないと、同居する別アプリと取りちがえられる。
      //
      // 相対パス（"./"）はどちらの配信でも正しく解決されるので、いつでも通す。
      const hasCname = fs.existsSync(path.join(root, 'CNAME'));
      const want = hasCname ? '"./"（相対パス）か "/"' : '/{リポジトリ名}/';
      // start_url の「どこから開かれたか」の目印（./?source=pwa）は正しい使い方なので、
      // 比べる前にクエリとハッシュを落とす
      const strip = (v) => String(v).replace(/[?#].*$/, '');
      const okPath = (v) => v === './' || (hasCname ? /^\/$/.test(v) : /^\/[^/]+\/$/.test(v));
      for (const k of ['id', 'scope', 'start_url']) {
        if (!j[k]) { bad.push(`${k} がありません`); continue; }
        if (!okPath(strip(j[k]))) bad.push(`${k} が "${j[k]}" です。${want} の形にしてください`);
      }
      if (j.id && j.scope && j.start_url
          && new Set([j.id, j.scope, j.start_url].map(strip)).size !== 1) {
        bad.push('id / scope / start_url がそろっていません');
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'E_CNAME',
    title: 'CNAME に BOM がなく、ドメイン名 1行だけ',
    run: (root, cfg) => {
      // ⚠️ 置き場はリポジトリによって違う。配信の起点に置くのが本当で、
      //    直下に決め打ちすると、docs/ から配るリポジトリでは
      //    「独自ドメインをつかっていません」と言って**黙って通る**。
      //    SchoolPlan_Editor は docs/CNAME を持っているのに、
      //    BOM を入れても1行でなくしても素通りしていた（2026-08-23）。
      const p = cnamePath(root, cfg);
      if (!p) return { ok: true, detail: [], skip: '独自ドメインをつかっていません' };
      const raw = fs.readFileSync(p, 'utf8');
      // ⚠️ BOM を必ず見ること。メモ帳や PowerShell の `>` で書くと先頭に U+FEFF が入る。
      //    目では見えないのに GitHub Pages はドメイン名の一部として読むため、
      //    ホスト名として不正になり、カスタムドメインが有効にならない。
      //    DNS も Pages の設定も正しいのに「なぜかつながらない」という、
      //    いちばん探しにくい壊れかたをする。実際にこれで全リポジトリが止まった。
      if (raw.charCodeAt(0) === 0xFEFF) {
        return { ok: false, detail: ['先頭に BOM があります。BOM なし UTF-8 で保存し直してください'] };
      }
      const lines = raw.split('\n').filter((l) => l.trim() !== '');
      if (lines.length !== 1) return { ok: false, detail: [`ドメイン名 1行だけにしてください（${lines.length} 行あります）`] };
      const host = lines[0].trim();
      if (!/^(?!-)[a-z0-9-]+(\.(?!-)[a-z0-9-]+)+$/.test(host)) {
        return { ok: false, detail: [`"${host}" はホスト名として正しくありません（https:// ・末尾の / ・大文字・空白は入れられません）`] };
      }
      return { ok: true, detail: [] };
    },
  },
  {
    id: 'E_STALE_REPO_PATH',
    title: '旧リポジトリ名の絶対パスがのこっていない（独自ドメインのときだけ）',
    run: (root, cfg) => {
      // manifest だけ直しても、SW の登録先と先読み一覧が旧構成のリポジトリ名の
      // 絶対パス（/Qalc/…）のままだと、登録も先読みも全件 404 になる。
      // どちらも失敗を握りつぶす作りなので、画面にもコンソールにも何も出ないまま
      // 「オフラインで開けない・インストールできない」だけが静かに残る。
      // 実際にこの形で残っていたので、機械で見張る。
      if (!cnamePath(root, cfg)) return { ok: true, detail: [], skip: '独自ドメインをつかっていません' };
      if (!cfg.repoName) return { ok: false, detail: ['quality.config.json に repoName がありません（この検査に必要です）'] };
      const stale = `/${cfg.repoName}/`;
      const bad = [];
      const targets = [...cfg.htmlFiles, cfg.manifest, swSourceOf(cfg), ...jsFiles(root, cfg)];
      for (const rel of new Set(targets)) {
        const s = read(root, rel);
        if (!s) continue;
        // ⚠️ 判定の前にコメントを落とすこと。
        //    落とさないと、この決まりを説明したコメント自身
        //    （「旧 '/Qalc/sw.js' で書かない」）に反応して落ちる。
        const code = stripHtmlComments(s);
        if (code.includes(`'${stale}`) || code.includes(`"${stale}`)) bad.push(`${rel}: ${stale} がのこっています`);
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'E_ICONS',
    title: 'アイコン 4種と、透明をふくまない apple-touch-icon',
    run: (root, cfg) => {
      const s = read(root, cfg.manifest);
      if (!s) return { ok: false, detail: [`${cfg.manifest} がありません`] };
      const j = JSON.parse(s);
      const bad = [];
      const has = (size, purpose) => (j.icons || []).some((i) => i.sizes === size
        && (purpose === 'any' ? (!i.purpose || i.purpose.includes('any')) : (i.purpose || '').includes('maskable')));
      if (!has('192x192', 'any')) bad.push('192 の any アイコンがありません');
      if (!has('512x512', 'any')) bad.push('512 の any アイコンがありません');
      if (!has('192x192', 'maskable')) bad.push('192 の maskable がありません');
      if (!has('512x512', 'maskable')) bad.push('512 の maskable がありません');

      // ⚠️ 並んでいることと、在ることは別である。
      //    maskable の実体は E_MASKABLE_SAFE_ZONE が読むので消えれば落ちるが、
      //    any のほうは誰も読んでいなかった。icons/icon-192.png を消しても
      //    38 件すべて通る状態だった（2026-08-23 に xxx_automatic で実測）。
      //    192 のアイコンが取れないと Chrome はインストールの合図を出さない。
      //    画面は普通に出るので、誰も気づかないまま「入れられないアプリ」になる。
      for (const ic of j.icons || []) {
        if (!ic.src) { bad.push('src の無いアイコンが並んでいます'); continue; }
        if (!fs.existsSync(sitePath(root, cfg, ic.src))) bad.push(`${ic.src} がありません`);
      }

      const html = read(root, cfg.entryHtml) || '';
      const m = html.replace(/<!--[\s\S]*?-->/g, '').match(/rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i);
      if (!m) bad.push('apple-touch-icon がありません');
      else {
        const rel = m[1].replace(/^\.\//, '');
        const p = sitePath(root, cfg, rel);
        if (!fs.existsSync(p)) bad.push(`apple-touch-icon のファイルがありません: ${rel}`);
        else if (pngHasAlpha(p)) bad.push(`${rel} に透明があります（iOS で四すみが黒くなります）`);
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'E_INSTALL_HOOK',
    title: 'インストールの合図を <head> のいちばん先で受け取っている',
    run: (root, cfg) => {
      // Chrome は条件がそろうと即座に beforeinstallprompt を出す。
      // 本体の JS より後だと合図を取りこぼし、通信が遅い端末で
      // 「インストール」ボタンが出なくなる。install-hook.js を
      // <head> で（本体より先に）読むのが決まった形。
      const html = read(root, cfg.entryHtml);
      if (!html) return { ok: false, detail: ['index.html がありません'] };
      const clean = html.replace(/<!--[\s\S]*?-->/g, '');
      const headEnd = clean.indexOf('</head>');
      const head = headEnd > 0 ? clean.slice(0, headEnd) : clean;
      if (/<script[^>]*src=["'][^"']*install-hook\.js["']/.test(head)) return { ok: true, detail: [] };
      // 外部ファイルに分けていなくても、head 内で受けていればよい
      if (head.includes('beforeinstallprompt')) return { ok: true, detail: [] };
      // ファイル名が install-hook.js でなくても（pwa-early.js 等）、
      // head で読むスクリプトの中身が合図を受けていればよい
      for (const m of head.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)) {
        const s = read(root, m[1].replace(/^\.\//, ''));
        if (s && /beforeinstallprompt/.test(s)) return { ok: true, detail: [] };
      }
      return { ok: false, detail: ['<head> で beforeinstallprompt を受けていません（install-hook.js を head で読みます）'] };
    },
  },
  {
    id: 'E_SW_CACHE_SCOPE',
    title: 'SW が自アプリ接頭辞のキャッシュだけを消している',
    run: (root, cfg) => {
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      const rel = swSourceOf(cfg);
      const src = read(root, rel);
      if (!src) return { ok: false, detail: [`${rel} がありません`] };
      const code = stripComments(src);
      const at = code.search(/caches\s*\.\s*keys\s*\(/);
      if (at < 0) return { ok: true, detail: [] };
      // ⚠️ 「消す式」を追ってはいけない（(k) => caches.delete(k) を見のがす）。
      //    見るのは「startsWith でしぼっているか」。
      //
      // ⚠️ ファイル全体から startsWith をさがしてもいけない。
      //    sw.js には fetch の中に
      //      if (!url.pathname.startsWith(...)) return;
      //    のような**別の** startsWith がふつうにある。
      //    それを拾うと、caches.keys() を全消ししていても通ってしまう。
      //    caches.keys() からその式のおわりまでだけを見る。
      const seg = code.slice(at, at + 600);
      const end = seg.search(/addEventListener\s*\(/);
      const scope = end > 0 ? seg.slice(0, end) : seg;
      const ok = /\.\s*startsWith\s*\(/.test(scope) || /\.\s*indexOf\s*\([^)]*\)\s*===?\s*0/.test(scope);
      return { ok, detail: ['caches.keys() の結果をしぼらずに消しています。同じドメインの他アプリがオフラインで起動しなくなります'] };
    },
  },
  {
    id: 'E_SW_NO_LOCALSTORAGE',
    title: 'SW が localStorage にさわっていない',
    run: (root, cfg) => {
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      const rel = swSourceOf(cfg);
      const src = read(root, rel);
      if (!src) return { ok: false, detail: [`${rel} がありません`] };
      // ⚠️ コメントを落としてから見る。「localStorage はさわりません」に反応する
      return { ok: !/localStorage/.test(stripComments(src)), detail: [`${rel} が localStorage をさわっています`] };
    },
  },
  {
    id: 'E_SW_NO_SKIP_WAITING_ON_INSTALL',
    title: 'SW の install で skipWaiting() していない',
    run: (root, cfg) => {
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      if (cfg.sw === 'workbox') return { ok: true, detail: [], skip: 'workbox 生成のため原文に install ハンドラがありません' };
      const rel = swSourceOf(cfg);
      const src = read(root, rel);
      if (!src) return { ok: false, detail: [`${rel} がありません`] };
      const code = stripComments(src);
      // ⚠️ 引用符は ' と " の両方を受けること。"install" と書くリポジトリがある。
      const start = code.search(/addEventListener\(\s*['"]install['"]/);
      if (start < 0) return { ok: false, detail: ['install のハンドラがありません'] };
      // ⚠️ 区間の切れ目は「次の addEventListener」まで。event 名を決め打ちすると、
      //    並び順しだいで message ハンドラの中の（正しい）skipWaiting を
      //    install のものと誤判定する。
      const rest = code.slice(start + 'addEventListener('.length);
      const next = rest.search(/addEventListener\s*\(/);
      const seg = next > 0 ? rest.slice(0, next) : rest;
      const bad = /skipWaiting\s*\(/.test(seg);
      return { ok: !bad, detail: ['install で skipWaiting() すると、児童が操作しているまっさい中に版が入れかわります'] };
    },
  },
  {
    id: 'E_SW_UPDATE_PROMPT',
    title: '更新のおしらせがあり、押されたときだけ切りかえる',
    run: (root, cfg) => {
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      const js = jsFiles(root, cfg).map((rel) => stripComments(read(root, rel))).join('\n');
      const bad = [];
      if (!/SKIP_WAITING/.test(js)) bad.push('画面から SKIP_WAITING をおくっていません（更新のおしらせがありません）');
      if (/addEventListener\(\s*['"]controllerchange['"]/.test(js)) {
        // 押したかどうかの見はりが無いと、初回訪問がかならず1回リロードされる。
        // 見はりの形は if (!asked) return; のほか、minify 後は
        // !H||U||(U=!0,location.reload()) のような短絡式にもなる。
        const seg = handlerBody(js, js.indexOf('controllerchange'));
        const reloadAt = seg.search(/location\s*\.\s*reload/);
        const before = reloadAt > 0 ? seg.slice(0, reloadAt) : '';
        const guarded = /if\s*\(\s*![\w$]+/.test(seg)
          || /![\w$]+\s*\|\|/.test(seg)
          || /[\w$]+\s*&&[^;\n]*location\s*\.\s*reload/.test(seg)
          || /\breturn\b/.test(before);   // reload の前に早期 return の見はりがある形
        if (reloadAt < 0) { /* reload しないなら問題なし */ }
        else if (!guarded) bad.push('controllerchange で無条件に reload しています（初回訪問が1回リロードされます）');
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'E_SW_REGISTER_READYSTATE',
    title: 'Service Worker の登録に readyState の分岐がある',
    run: (root, cfg) => {
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      const files = jsFiles(root, cfg).filter((rel) => /serviceWorker\s*\.\s*register/.test(stripComments(read(root, rel))));
      if (!files.length) return { ok: false, detail: ['serviceWorker.register がありません'] };
      const bad = files.filter((rel) => {
        const code = stripComments(read(root, rel));
        const loads = [...code.matchAll(/addEventListener\(\s*['"]load['"]/g)].map((m) => m.index);
        if (!loads.length) return false;                                    // load を待っていないなら問題なし
        // ⚠️ ファイル全体から readyState をさがしてはいけない。
        //    大きな app.js には SW と関係のない
        //      if (document.readyState === 'loading') …DOMContentLoaded…
        //    がたいてい別の場所にあり、それが身代わりになって、登録の手前の
        //    ガードを消しても検査が通ってしまう。実際 typa の self-test は
        //    この検査を「こわしたのに 通りました」と報告し続けていた。
        //    実装を見ると、ガードは load を待つ行の 50〜56 文字前に置かれる:
        //      if (document.readyState === 'complete') start();
        //      else window.addEventListener('load', start);
        //    なので、load を待つ行のすぐ手前だけを見る。
        // 'complete' との比較でも 'loading' との比較（DOMContentLoaded 方式）でもよい。
        // どちらも「もうイベントが済んでいる場合」を見ている。
        const WINDOW = 200;
        const guarded = loads.some((at) =>
          /readyState\s*[!=]==?\s*['"](?:complete|loading)['"]/.test(code.slice(Math.max(0, at - WINDOW), at)));
        // 「どれか1つでもガードされていれば良し」としている。ファイルの中の
        // どの load 待ちが登録につながるかは、文字だけでは決められないため。
        return !guarded;
      });
      return { ok: bad.length === 0, detail: bad.map((f) => `${f}: load がもう済んでいる場合を見ていません（黙って登録されません）`) };
    },
  },
  {
    id: 'E_SW_VERSION_GENERATED',
    title: 'SW の版が自動生成されている（手書きの定数でない）',
    run: (root, cfg) => {
      // 手書きの版は 2026-08-21 に全リポジトリで同時に上げ忘れる事故を起こした。
      // いまは tools/build-sw.mjs（正本: standards/sw/）が先読み対象の中身から
      // 版を作る。ここでは「その形になっているか」を見る。
      //   - 目印コメント __APP_VERSION__ が行末にある（手で上げる値ではないと読み手に伝わる）
      //   - tools/build-sw.mjs が実在する
      //   - static は v0/dev のままでない（vite は原本が 'dev' で正しい。ビルドが埋める）
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      if (cfg.sw === 'workbox') return { ok: true, detail: [], skip: 'workbox がプリキャッシュのリビジョンを自動生成します' };
      const rel = swSourceOf(cfg);
      const src = read(root, rel);
      if (!src) return { ok: false, detail: [`${rel} がありません`] };
      if (!fs.existsSync(path.join(root, cfg.swBuilder))) {
        return { ok: false, detail: [`${cfg.swBuilder} がありません。版の自動生成が外れています`] };
      }
      // ⚠️ 目印はコメントなので、コメント除去前の原文で見る。
      const name = cfg.swVersionConst ? cfg.swVersionConst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '(?:APP_VERSION|VERSION)';
      // 目印の付け方は2通りある。どちらも tools/build-sw.mjs（正本）が埋める。
      //   ① const APP_VERSION = 'v1a2b3c4'; /* __APP_VERSION__ */
      //   ② const APP_VERSION = '__APP_VERSION__';   ← 値そのものが目印
      // ② は vite-plugin-pwa 型（Quarto）の書き方で、build-sw-vite.mjs が
      //    はじめから対応している。ゲートだけが①しか知らず、正しく自動生成
      //    しているリポジトリを「手書きだ」と落としていた（2026-08-23）。
      const stamped = src.match(new RegExp(`const ${name} = '([^']*)'; /\\* __APP_VERSION__ \\*/`));
      const placeholder = new RegExp(`const ${name} = '__APP_VERSION__';`).test(src);
      if (!stamped && !placeholder) {
        return { ok: false, detail: [`${rel} の版の行が自動生成の形（__APP_VERSION__ の目印つき）になっていません`] };
      }
      if (stamped && cfg.sw === 'static' && (stamped[1] === 'v0' || stamped[1] === 'dev')) {
        return { ok: false, detail: [`${rel} の版が仮の値（${stamped[1]}）のままです。node ${cfg.swBuilder} で埋めてください`] };
      }
      return { ok: true, detail: [] };
    },
  },
  {
    id: 'E_OFFLINE_HTML',
    title: 'offline.html があり、外部資産にも JavaScript にもたよっていない',
    run: (root, cfg) => {
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      const s = siteRead(root, cfg, 'offline.html');
      if (!s) return { ok: false, detail: ['offline.html がありません'] };
      const bad = [];
      const html = s.replace(/<!--[\s\S]*?-->/g, '');
      if (/<script/i.test(html)) bad.push('JavaScript をつかっています（本体が無いときに出るページです）');
      if (/https?:\/\//.test(html.replace(/<!DOCTYPE[^>]*>/i, ''))) bad.push('外のファイルを読んでいます');
      if (/\son[a-z]+\s*=/i.test(html)) bad.push('onclick= があります（CSP で動きません）');
      if (!/<a[^>]+href/i.test(html)) bad.push('もういちどひらくための <a href> がありません');
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'E_SW_PRECACHE_OFFLINE',
    title: 'SW が offline.html を先読みしている',
    run: (root, cfg) => {
      if (cfg.sw === 'none') return { ok: true, detail: [], skip: 'Service Worker をつかっていません' };
      if (cfg.sw === 'workbox') return { ok: true, detail: [], skip: 'workbox の globPatterns が先読みを生成します' };
      const rel = swSourceOf(cfg);
      const src = read(root, rel);
      if (!src) return { ok: false, detail: [`${rel} がありません`] };
      const code = stripComments(src);
      // ⚠️ 先読みを vite-plugin-pwa の injectManifest に任せている型
      //    （self.__WB_MANIFEST）は、原文からは一覧の中身が分からない。
      //    ここで配列を見ても真偽が決まらないので、宣言だけを見る。
      //    ただし黙って素通りはさせない。宣言が無ければ落とす。
      //    実際に offline.html が入ったかは、各リポジトリが dist/sw.js を見て
      //    確かめること（Quarto の E10_OFFLINE_PRECACHED がその形）。
      if (/__WB_MANIFEST/.test(code)) {
        const cfgSrc = read(root, 'sw-build.config.json');
        let declared = false;
        // 読めない JSON は「宣言なし」として扱う（catch では代入しない。
        // 配布先の lint が no-useless-assignment で落ちる）
        try { declared = JSON.parse(cfgSrc || '{}').precacheManagedByPlugin === true; } catch { /* 宣言なしのまま */ }
        if (!declared) {
          return { ok: false, detail: ['先読みを self.__WB_MANIFEST に任せていますが、sw-build.config.json に precacheManagedByPlugin: true がありません'] };
        }
        return { ok: true, detail: [], skip: '先読み一覧はビルドで注入されます（dist を見る検査は各リポジトリ側）' };
      }
      // ⚠️ ファイル全体で offline.html をさがしてはいけない。
      //    fetch の逃げ道に caches.match('./offline.html') と書いてあれば
      //    見つかってしまい、**先読みしていなくても通る**。
      //    圏外では先読みしていないものは出せないので、意味が逆になる。
      //    先読みの配列（[ … ] の中）に入っていることを見る。
      const inArray = [...code.matchAll(/\[[\s\S]{0,4000}?\]/g)]
        .some((m) => /offline\.html/.test(m[0]));
      if (inArray) return { ok: true, detail: [] };

      // ⚠️ ビルドで一覧を注入する型では、原文の配列を見ても真偽が決まらない。
      //    tools/build-sw.mjs が /* __PRECACHE_URLS__ */ の行を実ファイル名で
      //    書き替えるので、原文はただの置き場である。そこに種の一覧を書いて
      //    あるリポジトリ（digitalcloset）は偶然通り、空の [] にしてある
      //    リポジトリ（quoridor）は正しく先読みしているのに落ちていた。
      //    真偽が決まるのは sw-build.config.json の precache のほうなので、
      //    置き場だと分かるときはそちらを見る。
      const isPlaceholder = /__PRECACHE_URLS__/.test(src);
      if (isPlaceholder) {
        const cfgSrc = read(root, 'sw-build.config.json');
        if (!cfgSrc) {
          return { ok: false, detail: ['先読み一覧はビルドで注入する形ですが、sw-build.config.json がありません'] };
        }
        let precache;
        try { precache = JSON.parse(cfgSrc).precache; } catch { precache = null; }
        if (!Array.isArray(precache)) {
          return { ok: false, detail: ['sw-build.config.json に precache の一覧がありません'] };
        }
        return {
          ok: precache.some((e) => /offline\.html/.test(e)),
          detail: ['sw-build.config.json の precache に offline.html を入れていません。圏外では出せません'],
        };
      }
      return { ok: false, detail: ['offline.html を先読みの一覧に入れていません。圏外では出せません'] };
    },
  },
  {
    id: 'E_MASKABLE_SAFE_ZONE',
    title: 'maskable の下地がはしまで届いている',
    run: (root, cfg) => {
      const s = read(root, cfg.manifest);
      if (!s) return { ok: false, detail: [`${cfg.manifest} がありません`] };
      const j = JSON.parse(s);
      const bad = [];
      for (const ic of (j.icons || []).filter((i) => (i.purpose || '').includes('maskable'))) {
        const p = sitePath(root, cfg, ic.src);
        if (!fs.existsSync(p)) { bad.push(`${ic.src} がありません`); continue; }
        if (pngHasAlpha(p)) bad.push(`${ic.src} に透明があります。maskable の下地ははしまでのばしてください（縮んで見えます）`);
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },

  {
    id: 'F_FILE_SIZE',
    title: '1ファイルが 5,000行 / 400KB をこえていない',
    run: (root, cfg) => {
      const bad = [];
      for (const rel of [...jsFiles(root, cfg), ...cssFiles(root, cfg), cfg.entryHtml]) {
        const s = read(root, rel);
        if (!s) continue;
        const lines = s.split('\n').length;
        const kb = Buffer.byteLength(s) / 1024;
        if (lines > 5000) bad.push(`${rel}: ${lines} 行`);
        if (kb > 400) bad.push(`${rel}: ${kb.toFixed(0)} KB`);
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'F_IMG_SIZE',
    title: '画像が 150KB 以下（PWA アイコン 512 は 60KB、favicon は 30KB）',
    run: (root, cfg) => {
      const bad = [];
      const walk = (dir) => {
        const p = path.join(root, dir);
        if (!fs.existsSync(p)) return;
        for (const f of fs.readdirSync(p)) {
          const full = path.join(p, f);
          if (fs.statSync(full).isDirectory()) { walk(path.join(dir, f)); continue; }
          if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
          const kb = fs.statSync(full).size / 1024;
          const limit = /favicon/i.test(f) ? 30 : /512/.test(f) ? 60 : 150;
          if (kb > limit) bad.push(`${path.join(dir, f)}: ${kb.toFixed(1)} KB（上限 ${limit} KB）`);
        }
      };
      for (const d of cfg.imageDirs) walk(d);
      return { ok: bad.length === 0, detail: bad };
    },
  },
  {
    id: 'F_IMG_DIMENSIONS',
    title: '<img> に width / height と alt がある',
    run: (root, cfg) => {
      const bad = [];
      for (const rel of [...cfg.htmlFiles, ...jsFiles(root, cfg)]) {
        const s = read(root, rel);
        if (!s) continue;
        const html = s.replace(/<!--[\s\S]*?-->/g, '');
        for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
          if (!/\bwidth=/.test(m[0]) || !/\bheight=/.test(m[0])) bad.push(`${rel}: width/height がない <img>（画面ががたつきます）`);
          if (!/\balt=/.test(m[0])) bad.push(`${rel}: alt がない <img>`);
        }
      }
      return { ok: bad.length === 0, detail: bad };
    },
  },
];

/** PNG に完全不透明でない画素があるか（標準ライブラリだけで読む） */
export function pngHasAlpha(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  const colorType = buf[25];
  // 0 = グレー, 2 = RGB, 3 = パレット, 4 = グレー+α, 6 = RGBA
  if (colorType === 0 || colorType === 2) return false;
  if (colorType === 3) {
    // パレットのときは tRNS チャンクがあれば透明をもつ
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const tag = buf.toString('latin1', i + 4, i + 8);
      if (tag === 'tRNS') return true;
      if (tag === 'IEND') break;
      i += 12 + len;
    }
    return false;
  }
  // α チャンネルをもつ形式。実際に展開して透明があるかを見る
  return rgbaHasTransparency(buf);
}

function rgbaHasTransparency(buf) {
  const zlib = require$('node:zlib');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const depth = buf[24];
  const colorType = buf[25];
  if (depth !== 8) return true;   // 判定できないときは安全側（透明がある）にたおす
  const ch = colorType === 6 ? 4 : 2;
  let idat = Buffer.alloc(0);
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const tag = buf.toString('latin1', i + 4, i + 8);
    if (tag === 'IDAT') idat = Buffer.concat([idat, buf.subarray(i + 8, i + 8 + len)]);
    if (tag === 'IEND') break;
    i += 12 + len;
  }
  let raw;
  // 読めないときは安全側（透明あり）に倒す。例外の中身は使わないので受けない
  try { raw = zlib.inflateSync(idat); } catch { return true; }
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[pos + x];
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= ch && y > 0) ? out[(y - 1) * stride + x - ch] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + x] = v & 0xff;
    }
    pos += stride;
  }
  for (let k = ch - 1; k < out.length; k += ch) if (out[k] !== 255) return true;
  return false;
}

// node:zlib を同期で読むための小さなヘルパ（ESM から require 相当をつかう）
import { createRequire } from 'node:module';
const require$ = createRequire(import.meta.url);

/**
 * すべての検査を走らせる。
 * config は quality.config.json の中身（またはその一部）。
 * 返り値: [{ id, title, ok, detail[], skipped? }]
 *
 * config.skips に載る検査は実行せず skipped:true で返す（理由必須）。
 * 「検査をゆるめる」のではなく、事情を理由つきで残すための口。
 */
export function runGigaChecks(root, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const skipMap = new Map();
  for (const s of cfg.skips || []) {
    if (!s || !s.id || !s.reason) {
      return [{ id: 'CONFIG', title: 'quality.config.json の skips', ok: false, detail: ['skips の各項目には id と reason が必要です'] }];
    }
    skipMap.set(s.id, s.reason);
  }
  return CHECKS.map((c) => {
    if (skipMap.has(c.id)) {
      return { id: c.id, title: `${c.title}（スキップ: ${skipMap.get(c.id)}）`, ok: true, detail: [], skipped: true };
    }
    let r;
    try { r = c.run(root, cfg); } catch (e) { r = { ok: false, detail: ['検査が例外で落ちました: ' + e.message] }; }
    return { id: c.id, title: c.title + (r.skip ? `（${r.skip}）` : ''), ok: !!r.ok, detail: r.ok ? [] : (r.detail || []) };
  });
}
