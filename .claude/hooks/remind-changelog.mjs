#!/usr/bin/env node
/**
 * 【正本】standards/agents/hooks/remind-changelog.mjs
 * 配布先へは .claude/hooks/remind-changelog.mjs としてコピーする（中身は変えない）。
 *
 * 使う人から見て何かが変わる直しをコミットしようとしたとき、
 * `docs/CHANGELOG.md` に 1 行も足していなければ、**1 回だけ**止める。
 *
 * ── なぜ要るのか ──────────────────────────────────────
 *
 * `giga-changelog` スキルは 42 本すべてへ配ってある。集める仕組み
 * （tools/sync-updates.mjs）も、出す先 3 か所（トップの「更新したこと」・
 * 紹介ページ・使い方マニュアル）も、書式検査も、CI も、ぜんぶ在る。
 *
 * それでも 2026-08-31 に数えたら、`data/changelog.json` はこうだった。
 *
 *     {"apps": {}}
 *
 * **42 本中 0 本。** 配り終えてから今日まで、誰も 1 行も書いていない。
 * スキルは「ユーザーが『更新ログを書いて』と言ったとき」にしか動かないので、
 * 言われなければ永遠に動かない。ルール文書にも書いてあったが、書かれなかった。
 *
 * これは guard-canonical.mjs が生まれたときとまったく同じ型で、
 * 「文書のお願いだけでは止まらなかった」ものを機械の側へ移す。
 *
 * ── コミットの題から作らないこと ────────────────────────
 *
 * ⚠️ 「それなら `feat:` / `fix:` から自動生成すればよい」は**通らない道**。
 *    2026-08-24 に 3 本のリポジトリを実際に数えて捨ててある。正本を配る仕組みが
 *    同じ `chore(gate)` を 42 本へ撒くので、機械で出すと紹介ページに
 *    「秘密の直書きの検査を入れる」が並ぶ。使う先生から見れば、アプリは
 *    何も変わっていない。だから機械がやるのは「思い出させる」ところまでで、
 *    文面は書いた本人が、使う人の言葉で書く。
 *
 * ── 1 回しか止めないこと ──────────────────────────────
 *
 * ⚠️ 満たすまで止める形にしてはいけない。「使う人から見て何も変わらない直し」は
 *    実際にたくさんあり（CI・検査・道具・正本）、そこで止めつづけると、
 *    書き手は止まらないために**嘘の更新ログを足す**。それは
 *    「使う人から見て何が変わったか」という定義そのものを壊すので、
 *    書かれないことよりも悪い。
 *
 *    同じ変更のかたまりに対しては 1 回だけ止め、控えを `.git/` に残す。
 *    もう一度同じコマンドを走らせれば通る。
 *
 * ⚠️ 控えを作業ツリーに置かないこと。distribute.mjs は `git add .` で
 *    まとめてコミットするので、42 本へ撒かれる。
 *
 * ── 必ず fail-open にすること ──────────────────────────
 *
 * 読み込みでも解析でも git の呼び出しでも、何かおかしければ黙って通す（exit 0）。
 * この hook は 42 本へ配られる。壊れたときにコミットが全部できなくなるほうが、
 * 防ごうとしている「書き忘れ」よりはるかに重い。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CHANGELOG = 'docs/CHANGELOG.md';

/** 日付の見出し。tools/lib/changelog.mjs と giga-changelog の lint と同じ形。 */
const DATE_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/;

/**
 * 使う人から見て変わりようがない置き場。
 *
 * ⚠️ ここは**広めに**取る。うるさく鳴るほうが、黙って落ちるより高くつく。
 *    CI を直すたびに止められる hook は、いずれ hook ごと切られる。
 *    見落としは翌朝 data/changelog.json の数で気づけるが、
 *    切られた hook は二度と戻ってこない。
 */
export const MACHINERY_DIRS = [
  '.github', '.claude', '.agents', '.vscode', '.husky', '.devcontainer',
  'standards', 'tools', 'scripts',
  'docs', 'test', 'tests', '__tests__', 'e2e',
  'dist', 'build', 'out', 'coverage', 'node_modules', '.standards-src',
];

/**
 * 置き場ではなく名前で決まるもの。
 *
 * ⚠️ エージェント向けの手引き（CLAUDE.md・AGENTS.md・.mcp.json）を必ず入れること。
 *    リポジトリ直下に在るので置き場では外れず、**正本を配るたびに 42 本で鳴る**。
 *    2026-08-31、実際に走らせて CLAUDE.md だけで止まるのを見つけた。
 *    いちばんよく直すものが、いちばん使う人と関係ない、という置き場である。
 */
export const MACHINERY_FILES = [
  'sw.js', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'quality.config.json', 'standards-map.json', 'sw-build.config.json',
  'secret-scan.config.json', 'jsconfig.json', 'tsconfig.json',
  'README.md', 'LICENSE', 'LICENSE-CONTENT.md', 'CHANGELOG.md',
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'CODE_OF_CONDUCT.md', '.mcp.json',
  '.gitignore', '.nojekyll', '.editorconfig', 'CNAME', 'robots.txt',
];

/**
 * そのリポジトリが「朝に組み直すもの」として台帳に載せている道。
 *
 * ポータルの tools/outputs.json は、どの道具が何を書き出すかの正本。
 * 生成物の一覧をこの hook 側にもう一度書くと、台帳を直したときに
 * 片方だけ古くなる（guard-canonical が判定表を自前で持たないのと同じ理由）。
 * 配布先にこのファイルは無いので、そこでは何も起きない。
 *
 * @returns {string[]} 生成物の道（ディレクトリは末尾 / 付きのまま）
 */
export function generatedPaths(root, deps = {}) {
  const { exists = fs.existsSync, read = fs.readFileSync } = deps;
  const p = path.join(root, 'tools', 'outputs.json');
  if (!exists(p)) return [];
  try {
    const ledger = JSON.parse(String(read(p, 'utf8')));
    const out = new Set();
    for (const paths of Object.values(ledger?.tools ?? {})) {
      for (const one of Array.isArray(paths) ? paths : []) {
        if (typeof one === 'string' && one) out.add(one);
      }
    }
    return [...out];
  } catch {
    return [];   // 台帳が読めない＝除外できないだけ。判断は続ける
  }
}

/**
 * 使う人（先生・子ども）から見て変わりうる道だけを返す。
 *
 * @param {string[]} files 変更された道（リポジトリ直下からの相対、posix 区切り）
 * @param {string[]} generated tools/outputs.json に載っている生成物
 * @returns {string[]} 使う人向けとみなす道
 */
export function userFacingChanges(files, generated = []) {
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/^\.\//, '');
  const dirs = new Set(MACHINERY_DIRS);
  const names = new Set(MACHINERY_FILES);

  return files.map(norm).filter(Boolean).filter((f) => {
    const head = f.split('/')[0];
    if (dirs.has(head)) return false;
    if (names.has(path.posix.basename(f))) return false;
    // テストと設定は、名前の形で見分ける（置き場が揃っていないリポジトリがある）
    if (/(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(f)) return false;
    if (/(^|\/)[^/]+\.config\.[^/]+$/.test(f)) return false;
    // 朝に組み直されるものは、人が直した跡ではない
    for (const g of generated) {
      const gn = norm(g);
      if (gn.endsWith('/') ? f.startsWith(gn) : f === gn) return false;
    }
    return true;
  });
}

/**
 * 更新ログに、いま書いたばかりの日付があるか。
 *
 * ⚠️ 「今日ちょうど」では狭すぎる。組み直しは UTC で回り、書く人は JST に居る。
 *    日付をまたぐたびに、書いたのに止められることになる。前日まで見る。
 *
 * @param {string} md docs/CHANGELOG.md の中身
 * @param {string} today YYYY-MM-DD
 */
export function hasRecentEntry(md, today) {
  if (typeof md !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) return false;
  const floor = new Date(`${today}T00:00:00Z`);
  floor.setUTCDate(floor.getUTCDate() - 1);
  const since = floor.toISOString().slice(0, 10);
  for (const line of md.split('\n')) {
    const m = DATE_RE.exec(line);
    if (m && m[1] >= since) return true;   // ISO の日付は字の並びで比べられる
  }
  return false;
}

/**
 * git の大域の指定のうち、値を**次の語**として取るもの。
 *
 * ⚠️ ここを落とすと `git -C ../Typa commit` を拾えない。正本の配布や
 *    艦隊の作業では、隣のリポジトリを -C で指して打つ形がふつうに出る。
 */
const GIT_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
]);

/**
 * git の下位命令とその後ろの語を取り出す。git でなければ null。
 *
 * ⚠️ 正規表現 1 本で書かないこと。`-C path` のように値が次の語に来る指定があり、
 *    「- で始まる語を読み飛ばす」だけでは path を下位命令と読んでしまう。
 */
export function gitSubcommand(segment) {
  const toks = String(segment).trim().split(/\s+/).filter(Boolean);
  if (toks[0] !== 'git') return null;
  for (let i = 1; i < toks.length;) {
    const t = toks[i];
    if (!t.startsWith('-')) return { sub: t, rest: toks.slice(i + 1) };
    i += GIT_VALUE_OPTS.has(t) ? 2 : 1;
  }
  return null;
}

/**
 * コミットしようとしているか。
 *
 * ⚠️ 命令文の途中に出てくる `commit` を拾わないこと。`git log --grep=commit` や
 *    `echo "git commit"` で止めると、この hook は「関係ないところで邪魔をするもの」
 *    になる。区切りで割って、先頭が git のものだけを見る。
 *
 * ⚠️ --amend は見送る。直前のコミットの作り直しなので、そのときには既に 1 回聞いている。
 */
export function isCommitCommand(command) {
  if (typeof command !== 'string' || command === '') return false;
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const hit = gitSubcommand(seg);
    if (hit?.sub !== 'commit') continue;
    if (hit.rest.includes('--amend') || hit.rest.includes('--dry-run')) return false;
    return true;
  }
  return false;
}

/** 同じ変更のかたまりに対して 1 回だけ止めるための鍵。 */
export function signatureOf(files) {
  return crypto.createHash('sha1')
    .update([...files].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 止める理由の文面。
 *
 * ⚠️ **逃げ道を必ず書くこと。** 書かないと、使う人から見て何も変わらない直しにも
 *    嘘の更新ログが足される。それは書かれないことより悪い（冒頭の説明のとおり）。
 */
export function refusal({ files = [] } = {}) {
  const shown = files.slice(0, 6);
  const rest = files.length - shown.length;
  return [
    `⛔ ${CHANGELOG} に 1 行も足さずにコミットしようとしています。`,
    '',
    '使う人から見て変わりうるものを直しています:',
    ...shown.map((f) => `    ${f}`),
    ...(rest > 0 ? [`    ほか ${rest} 件`] : []),
    '',
    `${CHANGELOG} の先頭に、今日の日付で 1 行足してください。`,
    '',
    '```md',
    '## YYYY-MM-DD',
    '- 写真の上限をなくしました',
    '```',
    '',
    '⚠️ **コミットの題を貼らないこと。** ここに書くのは「使う人から見て',
    '   何が変わったか」であって、リポジトリで何をしたかではありません。',
    '   書いたものは giga-school.com のトップと紹介ページに、',
    '   先生と子どもが読む文として、そのまま出ます。',
    '',
    '書き方の正本（`## YYYY-MM-DD` を外すと機械が拾わず、黙って消えます）:',
    '    .claude/skills/giga-changelog/SKILL.md',
    '検査:',
    `    node .claude/skills/giga-changelog/scripts/lint-changelog.mjs ${CHANGELOG}`,
    '',
    '── 使う人から見て何も変わらない直しなら ──',
    '書かなくてかまいません。**同じコマンドをもう一度走らせれば通ります。**',
    'ここで止めるのは 1 回だけです。',
  ].join('\n');
}

/** 標準入力を最後まで読む */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * コミットに入りうる道を集める。
 *
 * ⚠️ 索引（staged）だけでは足りない。`git add . && git commit -m x` を 1 本の
 *    コマンドで打つと、この hook が走る時点ではまだ何も add されていない。
 */
function changedFiles(root) {
  const git = (args) => {
    try {
      return String(execFileSync('git', args, {
        cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch { return ''; }
  };
  const out = new Set();
  for (const chunk of [
    git(['diff', '--cached', '--name-only']),
    git(['diff', '--name-only']),
    git(['ls-files', '--others', '--exclude-standard']),
  ]) {
    for (const line of chunk.split('\n')) {
      const f = line.trim();
      if (f) out.add(f);
    }
  }
  return [...out];
}

/** 控えの置き場。`.git/` の中（作業ツリーを汚さない）。取れなければ null。 */
function stampFile(root) {
  let gitDir;
  try {
    gitDir = String(execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch { return null; }
  if (!gitDir || !fs.existsSync(gitDir)) return null;
  return path.join(gitDir, 'giga-changelog-asked');
}

async function main() {
  let payload;
  try { payload = JSON.parse(await readStdin()); }
  catch { return 0; }   // 読めない＝判断できない。通す

  if (!isCommitCommand(payload?.tool_input?.command)) return 0;

  const root = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  const files = changedFiles(root);
  if (files.length === 0) return 0;             // 何も変わっていない
  if (files.includes(CHANGELOG)) return 0;      // このコミットで書いている

  const facing = userFacingChanges(files, generatedPaths(root));
  if (facing.length === 0) return 0;            // 道具・検査・生成物だけ

  // すでに今日（または昨日）の分を書いてあるなら、もう聞かない
  try {
    const md = fs.readFileSync(path.join(root, CHANGELOG), 'utf8');
    if (hasRecentEntry(md, new Date().toISOString().slice(0, 10))) return 0;
  } catch { /* 無いなら書いていない、として続ける */ }

  /* ⚠️ 控えを置けないなら止めない。置けないまま止めると、逃げ道が無くなる
        （同じコマンドを何度打っても止まりつづける）。 */
  const stamp = stampFile(root);
  if (!stamp) return 0;

  const sig = signatureOf(facing);
  try {
    if (fs.readFileSync(stamp, 'utf8').trim() === sig) {
      fs.rmSync(stamp, { force: true });   // 2 回目は通す
      return 0;
    }
  } catch { /* 控えが無い＝まだ聞いていない */ }

  try { fs.writeFileSync(stamp, sig); }
  catch { return 0; }   // 控えが書けない＝1 回で終われない。止めない

  process.stderr.write(refusal({ files: facing }) + '\n');
  return 2;   // 2 = 止める。stderr がエージェントに返る
}

/* 直接起動されたときだけ動かす。
   ⚠️ `file://${process.argv[1]}` を文字列で組み立てて比べないこと。Windows は
      file:///C:/… で、空白や日本語は百分率符号化されるため一致しない。
      2026-08-28 に giga-reviewer がこれで「何も検査せず exit 0」になっていた。 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith('remind-changelog.mjs');
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(0));   // 何があっても通す（fail-open）
}
