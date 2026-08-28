#!/usr/bin/env node
/**
 * lint-giga.mjs — GIGAスクール標準 静的品質・教育・セキュリティ検証スクリプト
 *
 * 検査項目（ここに書いてあるものだけを実際に見る）:
 *   1. Zero External CDN … 既知の CDN ホストからの読み込み（errors）
 *                          その他の外部オリジンからの読み込み（warnings）
 *                          CSS の @import url(http…)（errors）
 *   2. Zero PII        … 氏名・出席番号などを求める入力欄（errors）
 *
 * ⚠️ タップ領域（48px）と SW キャッシュ整合性は**ここでは見ていない**。
 *    以前この見出しには両方が並んでいたが、実装は無かった。
 *    「検査項目に書いてあるから見ているはず」と読まれるほうが、
 *    検査が無いことより危ない。見るようになったらここに足すこと。
 *    ・タップ領域 … 各リポジトリの品質ゲート（scripts/check-project.mjs 等）
 *    ・SW 版数    … node tools/build-sw.mjs --check
 *
 * 使用法:
 *   node scripts/lint-giga.mjs [targetDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* 止めたい CDN のホスト。
 *
 * ⚠️ ここに `https://…` という**完成した URL の形**を書かないこと。
 *    このファイルは全リポジトリの .claude/ と .agents/ に配られる。
 *    各リポジトリの品質ゲート（check-project.mjs の B2 など）はリポジトリ全体を
 *    走査して `https://<既知のCDN>` を探すので、検査する側のパターンそのものを
 *    「違反」として拾ってしまう。2026-08-28 に Reading-Books ほかで実測した
 *    （配っただけで、触っていないリポジトリのゲートが赤くなる）。
 *    ホスト名だけを並べ、スキームは実行時に組み立てる。 */
export const FORBIDDEN_CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'code.jquery.com',
  'stackpath.bootstrapcdn.com',
  'cdn.tailwindcss.com',
];

/* ⚠️ スキームを省いた `//cdn.jsdelivr.net/…`（プロトコル相対 URL）も同じ違反である。
   ブラウザはページと同じスキームを補って外へ取りにいくので、動きは https:// と変わらない。
   `https?://` だけで見ていたころは**検査を素通りしていた**。
   Shared-Folder-Sync の js.html が実際にこの形で、Zero-CDN 合格のまま
   SweetAlert2 を外から読んでいた（2026-08-28、実ブラウザの通信記録で見つけた）。
   静的検査が「0 件」と言っても、実際に開いて通信を見るまでは信じないこと。 */
const SCHEME = '(?:https?:)?\\/\\/';
const FORBIDDEN_CDN_PATTERNS = FORBIDDEN_CDN_HOSTS.map(
  (host) => new RegExp(SCHEME + host.replace(/\./g, '\\.'), 'i'),
);

/* 既知の CDN ではないが外部から読んでいるもの。ホストを並べる形では
   スキーム付きで直に書かれた別ホストがすり抜ける。ただし
   raw.githubusercontent.com から画像を読むリポジトリ（XXX_automatic）のように
   意図して外を読む例があるので、こちらは warnings にとどめて止めない。 */
/* ⚠️ 絵や動画も外から取れば同じことが起きる。
   Moral_note の「先生の合図を待ってね」の画面は、待っているあいだの絵を
   外部の CDN から取っていた。塞がれると児童には「画像が壊れた印」だけが出る。
   script/link/iframe しか見ていなかったので、検査は通っていた
   （2026-08-28、実ブラウザの通信記録で見つけた）。 */
const EXTERNAL_LOAD_PATTERN =
  /<(?:script|link|iframe|img|source|video|audio|embed|object)\b[^>]*\b(?:src|href|data|poster)\s*=\s*["'](?:https?:)?\/\/[^"']+["']/i;

/* <link> のうち、実行時に何かを取りに行くもの。
   canonical / alternate / me などは「その URL を指す」だけで読み込みではない。
   区別しないと、自分の公開 URL を canonical に書いてあるページが全部ひっかかる
   （KANJI_Town は quality.config.json に「実行コードの取得元ではない」と
   わざわざ書いている。同じことを検査側でも分かっている必要がある）。 */
/* CSP の宣言行。`style-src 'self' <外部フォントのCDN>;` は
   「そこから読む」ではなく「読むならここまで」という**制限**である。
   読み込みとして数えると、CSP をきちんと書いたリポジトリほど赤くなり、
   直し方が「CSP を消す」になってしまう。実際の読み込みは同じファイルの
   <link>／<script> の側で捕まえるので、ここで数える必要もない。
   ただし外部ホストを許していること自体は知らせる価値があるので警告に回す。 */
const CSP_DIRECTIVE =
  /\b(?:default|script|style|font|img|connect|frame|media|object|worker|manifest|child|prefetch)-src\b|\bContent-Security-Policy\b|\bframe-ancestors\b|\bbase-uri\b|\bform-action\b/i;

const NON_LOADING_LINK_REL =
  /\brel\s*=\s*["'](?:canonical|alternate|me|author|license|prev|next|search|help|bookmark|nofollow|noopener)["']/i;

/* 検査から外す置き場。生成物・取り寄せたもの・エージェントへ配った写しは
   「このリポジトリが書いたコード」ではない。
   ⚠️ .claude と .agents を外さないと、配られた giga-reviewer 自身の
      テスト資料（わざと CDN を書いてある）を検出して、どのリポジトリでも
      赤くなる。2026-08-28 に 44 本すべてで再現した。 */
/* 検査する拡張子。
   ⚠️ ここに書き忘れた拡張子は、1 行も見られないまま「合格」になる。
      2026-08-28 まで ['.html','.js','.mjs','.ts','.css','.json'] だったので、
      **`.gs` と `.jsx` が丸ごと素通り**していた。GAS のアプリは中身がほぼ `.gs`
      なので、艦隊の半分は Zero-CDN も Zero-PII も一度も見られていなかった。
      React のアプリも同じで、Music-production_studio の App.jsx が
      実行時に `@import url('https://fonts.googleapis.com/…')` を差しこんでいるのを
      見落としていた（検査そのものは 318 行目にあり、届いていなかっただけ）。
   拡張子を足すときは、必ず「その拡張子でわざと違反を書いて落ちること」を確かめること。 */
export const SCANNED_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.gs',
  '.vue', '.svelte', '.css', '.json',
]);

/* 外部からの読み込みは、どの書き方のファイルからでも起こりうる。
   .json はデータであって読み込みではないので外す。 */
export const CDN_EXT = new Set([...SCANNED_EXT].filter((e) => e !== '.json'));

/* 入力欄は画面を組み立てるファイルにある。CSS と JSON には無い。 */
export const PII_EXT = new Set([...CDN_EXT].filter((e) => e !== '.css'));

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'vendor', 'dist', 'build', 'out',
  'coverage', '.standards-src', '.claude', '.agents', '.next', '.cache',
]);

/* テストと自己診断は、わざと違反を書いて「検査が本当に落ちるか」を
   確かめるためのもの。ここを検出すると、正しく書かれた検査ほど赤くなる。 */
const FIXTURE_PATH_PATTERN =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|self-?test|check-project|verify-gate|gate-selftest/i;

/* コメント行。書いてあるだけで読み込んではいない。
   古い構成の説明（KANA_Master/tools/build.mjs は、以前 CDN から読んでいた
   ものを一覧にして残してある）や、コメントアウトした断片が引っかかっていた。

   ⚠️ これはコメントの**始まる行**しか見ていない。
      /* … *\/ や <!-- … --> の途中の行（先頭が空白で始まる本文）は
      素通りして違反として数えられる。実測で 4 件がこれだった（2026-08-28）:
      KANA_Master/tools/build.mjs には「もとはこの 4 本を読ませていた」という
      一覧がブロックコメントで残っていて、その 4 行が毎回赤くなっていた。
      途中の行まで見るのは下の commentMask() の仕事。 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#|<!--)/;

/* 引用符の中を落とす。'https://…' のような文字列に紛れた /* を
   コメントの開きと読まないため。正確な字句解析ではないが、
   「コメントかどうか」を決めるにはこれで足りる。 */
function stripStrings(line) {
  return line
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/**
 * 行ごとに「コメントの中か」を返す。
 *
 * ブロックコメントは開いた行から閉じた行までを覆う。開いた行・閉じた行も
 * コメント扱いにする（その行に本物の読み込みが同居することは、この艦隊では無い）。
 * 拡張子で言語を切りかえる: .html は <!-- -->、それ以外は /* *\/。
 */
export function commentMask(lines, filePath = '') {
  const html = /\.(?:html?|vue|svelte)$/i.test(filePath);
  const open = html ? '<!--' : '/*';
  const close = html ? '-->' : '*/';
  const mask = new Array(lines.length).fill(false);
  let inside = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = html ? lines[i] : stripStrings(lines[i]);
    if (inside) {
      mask[i] = true;
      if (line.includes(close)) inside = false;
      continue;
    }
    const o = line.indexOf(open);
    if (o !== -1 && line.indexOf(close, o + open.length) === -1) {
      inside = true;
      mask[i] = true;
    } else if (COMMENT_LINE.test(lines[i])) {
      mask[i] = true;
    }
  }
  return mask;
}

/* ビルド時にしか動かない Node のプログラム。ブラウザへは配られない。
   置き場の一覧ではなく、ファイル自身の宣言で見分ける（shebang か node: の取りこみ）。
   この艦隊では .mjs をブラウザへ配っているリポジトリは 1 本も無い（実測）。

   ここを違反として数えると、CSP が効くことを**わざと**確かめている自己検査
   （DigitalCloset/tools/measure-csp.mjs）や、記事用の写しから font link を
   **外す**前処理（Digital-Newspaper/docs/note/capture/prepare.mjs）まで赤くなる。

   ただし黙って見なくするのは違う。生成物に外部を書き出すビルドスクリプトは
   ありうるので、エラーではなく警告として残す。 */
export function isNodeProgram(content) {
  if (/^#!.*\bnode\b/.test(content)) return true;
  return /(?:from|require\()\s*['"]node:/.test(content);
}

/* どうしても違反を書き残す必要がある行のための逃げ道。
   黙って外すのではなく、コードに理由つきで宣言させる。 */
const IGNORE_LINE = /giga-lint-ignore-next-line/;
const IGNORE_FILE = /giga-lint-disable-file/;

/**
 * リポジトリが自分で宣言している「許した外部ホスト」を読む。
 *
 * 各リポジトリの品質ゲートは quality.config.json の securityExceptions で
 * 外部ホストを理由つきに許している（2026-08-28 時点で 13 本が使用）。
 * ここがそれを読まないと、宣言を済ませたリポジトリほど赤くなり、
 * 「giga-reviewer は無視してよい」を学習させてしまう。
 * 宣言していないホストは、これまでどおり赤くする。
 */
export function allowedHosts(targetDir, readFile = fs.readFileSync) {
  let raw;
  try { raw = readFile(path.join(targetDir, 'quality.config.json'), 'utf-8'); } catch { return []; }
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return []; }
  const rows = Array.isArray(cfg.securityExceptions) ? cfg.securityExceptions : [];
  return rows
    .filter((r) => r && r.rule === 'external-runtime-host' && typeof r.value === 'string')
    .map((r) => r.value.trim().toLowerCase())
    .filter(Boolean);
}

/* 検索・絞り込みの入力欄は、個人情報を「集める」ものではない。
   `placeholder="本の なまえで さがす"` や `placeholder="キーワード (名前・題名・本文)"` を
   PII 収集として数えていたので、実測 18 件のうち半分以上が誤検出だった（2026-08-28）。
   「名前」を含むというだけで赤くすると、単元名・題名・見つけたものの名前まで巻きこむ。 */
const SEARCH_FIELD = /type\s*=\s*["']search["']|(?:id|name|class)\s*=\s*["'][^"']*(?:search|filter|query|keyword)[^"']*["']|検索|さがす|キーワード|絞り込|フィルタ/i;

/* 人の名前でないことがはっきりしている見出し語。
   これらが直前にあるときは、person-name の指標として数えない。 */
const NOT_PERSON_NAME = /単元|題名|本の|みつけたもの|見つけたもの|グループ|チーム|クラス名|学校名|ファイル|アプリ|テーマ/;

const FORBIDDEN_PII_PATTERNS = [
  /<input[^>]+(?:name|id)=["'](?:student_name|shimei|namae|realname|user_email|email)["']/i,
  /placeholder=["'][^"']*(?:児童名|名前|なまえ|氏名|学籍番号|出席番号|メールアドレス)[^"']*["']/i
];

/** このパスを検査するか。生成物・写し・テスト資料は見ない */
export function shouldLint(filePath) {
  const p = filePath.replace(/\\/g, '/');
  for (const dir of SKIP_DIRS) {
    if (p.includes(`/${dir}/`) || p.startsWith(`${dir}/`) || p === dir) return false;
  }
  return !FIXTURE_PATH_PATTERN.test(p);
}

export function lintContent(filePath, content, options = {}) {
  const errors = [];
  const warnings = [];
  const lines = content.split('\n');
  const allowed = (options.allowedHosts || []).map((h) => h.toLowerCase());
  /** その行の外部参照が、すべて宣言済みホストなら見逃す */
  const declared = (line) => {
    const hosts = [...line.matchAll(/https?:\/\/([^/"'\s)]+)/gi)].map((m) => m[1].toLowerCase());
    return hosts.length > 0 && hosts.every((h) => allowed.some((a) => h === a || h.endsWith(`.${a}`)));
  };

  if (!shouldLint(filePath)) return { errors, warnings };
  // ファイルまるごとの取り消し。理由はコードのそばに書かれる
  if (IGNORE_FILE.test(content)) return { errors, warnings };

  // 直前の行で取り消されているか
  const muted = (idx) => idx > 0 && IGNORE_LINE.test(lines[idx - 1]);

  // コメントの中か（ブロックコメントの途中の行も含む）
  const inComment = commentMask(lines, filePath);
  /* ビルド時にしか動かない Node のプログラムは、配信物ではない。
     赤くはしないが、生成物に書き出していないか目で見てほしいので警告に回す。 */
  const tooling = isNodeProgram(content);
  const cdnFinding = (idx, line, message) => {
    (tooling ? warnings : errors).push({
      file: filePath,
      line: idx + 1,
      rule: tooling ? 'external-in-tooling' : 'zero-cdn',
      message: tooling
        ? `ビルド時のコードに外部CDNが書かれています。配信物には出ませんが、` +
          `生成物へ書き出していないか確かめてください: "${line.trim()}"`
        : message,
    });
  };

  // 1. Zero External CDN Check
  if (CDN_EXT.has(path.extname(filePath).toLowerCase())) {
    lines.forEach((line, idx) => {
      if (muted(idx) || declared(line) || inComment[idx]) return;
      if (CSP_DIRECTIVE.test(line)) {
        // 制限の宣言であって読み込みではない。外部を許していることだけ知らせる
        if (FORBIDDEN_CDN_PATTERNS.some((p) => p.test(line))) {
          warnings.push({
            file: filePath,
            line: idx + 1,
            rule: 'csp-allows-external',
            message: `CSP が外部ホストを許可しています。自己ホストにできれば外せます: "${line.trim()}"`
          });
        }
        return;
      }
      let hit = false;
      for (const pattern of FORBIDDEN_CDN_PATTERNS) {
        if (pattern.test(line)) {
          hit = true;
          cdnFinding(
            idx,
            line,
            `外部CDNからの読み込みが検出されました (Zero External CDN違反): "${line.trim()}"`,
          );
        }
      }
      /* 既知の CDN でなくても、外から実行時に読んでいれば校内ネットワークで
         止まりうる。ただし意図して外を読む例があるので警告にとどめる。
         すでにエラーで出した行は二重に言わない。 */
      if (!hit && EXTERNAL_LOAD_PATTERN.test(line) && !NON_LOADING_LINK_REL.test(line)) {
        warnings.push({
          file: filePath,
          line: idx + 1,
          rule: 'external-origin',
          message: `外部オリジンからの読み込みです。自己完結にできないか確認してください: "${line.trim()}"`
        });
      }
    });
  }

  // 2. Zero PII Check
  if (PII_EXT.has(path.extname(filePath).toLowerCase())) {
    lines.forEach((line, idx) => {
      if (muted(idx) || inComment[idx]) return;
      // 検索欄・人名でない「名前」は、集めているわけではないので数えない
      if (SEARCH_FIELD.test(line) || NOT_PERSON_NAME.test(line)) return;
      for (const pattern of FORBIDDEN_PII_PATTERNS) {
        if (pattern.test(line)) {
          errors.push({
            file: filePath,
            line: idx + 1,
            rule: 'zero-pii',
            message: `個人情報(PII)を要求または保存するフィールドが検出されました (Zero PII違反): "${line.trim()}"`
          });
        }
      }
    });
  }

  // 3. Child UI / Touch Area Advisory Check
  if (filePath.endsWith('.css')) {
    lines.forEach((line, idx) => {
      if (muted(idx) || declared(line) || inComment[idx]) return;
      if (/@import\s+url\(['"]?https?:\/\//i.test(line)) {
        cdnFinding(
          idx,
          line,
          `外部フォント・外部スタイルのインポートが検出されました: "${line.trim()}"`,
        );
      }
    });
  }

  return { errors, warnings };
}

export function lintDirectory(targetDir) {
  const allErrors = [];
  const allWarnings = [];
  const opts = { allowedHosts: allowedHosts(targetDir) };

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCANNED_EXT.has(ext)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const { errors, warnings } = lintContent(fullPath, content, opts);
          allErrors.push(...errors);
          allWarnings.push(...warnings);
        }
      }
    }
  }

  walk(targetDir);
  return { errors: allErrors, warnings: allWarnings };
}

/* CLI execution
 *
 * ⚠️ `file://${process.argv[1]}` を文字列で組み立ててはいけない。
 *    import.meta.url は百分率符号化された URL で、argv[1] はただのパス。
 *    ずれる条件は珍しくない:
 *      ・Windows … import.meta.url は file:///C:/… で スラッシュが3本。
 *                  組み立てた側は file://C:/… なので**必ず**一致しない。
 *      ・空白や日本語を含むパス … %20 などに符号化されて一致しない。
 *    一致しないと、この節がまるごと動かない。検査は何も出力せず exit 0 で
 *    終わるので、**通ったように見える**。2026-08-28 に、空白を含むパスから
 *    走らせて実測した（違反のある資料を渡しても無言で成功した）。
 *    作者の作業機は Windows なので、そこでは一度も動いていなかった。
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetDir = process.argv[2] || process.cwd();
  console.log(`[giga-reviewer] GIGAスクール標準品質検査を開始: ${targetDir}`);
  
  const { errors, warnings } = lintDirectory(targetDir);

  if (warnings.length > 0) {
    console.log(`\n[WARNINGS] (${warnings.length}):`);
    warnings.forEach(w => console.log(`  ${w.file}:${w.line} - [${w.rule}] ${w.message}`));
  }

  if (errors.length > 0) {
    console.error(`\n[ERRORS] (${errors.length}):`);
    errors.forEach(e => console.error(`  ${e.file}:${e.line} - [${e.rule}] ${e.message}`));
    console.error(`\n❌ GIGAスクール標準検査に失敗しました。上記のエラーを修正してください。`);
    process.exit(1);
  } else {
    console.log(`\n✅ すべてのGIGAスクール標準検査（Zero-CDN, Zero-PII, 自己完結性）に合格しました。`);
    process.exit(0);
  }
}
