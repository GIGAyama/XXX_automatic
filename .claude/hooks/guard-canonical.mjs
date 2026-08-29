#!/usr/bin/env node
/**
 * 【正本】standards/agents/hooks/guard-canonical.mjs
 * 配布先へは .claude/hooks/guard-canonical.mjs としてコピーする（中身は変えない）。
 *
 * 配布先のリポジトリで、正本のコピーを直接書き替えようとしたら止める。
 *
 * ── なぜ要るのか ──────────────────────────────────────
 *
 * 最重要ルール 3「個別リポジトリを直接修正しない」は、これまで文書にしか無かった。
 * この艦隊の歴史でいちばん多い事故の型がこれで、しかも壊れ方が静かである。
 *
 *   1. 配布先の写しを直す
 *   2. そのリポジトリでは直って見える
 *   3. 次の配布で正本に上書きされ、直した内容が消える
 *   4. 正本は直っていないので、他の 41 本にも最初から届いていない
 *
 * どの段階でもエラーは出ない。だから機械で止める。
 *
 * ── 何を見るか ────────────────────────────────────────
 *
 * `standards-map.json` の files[].local と dirs[].local。判定表を自前で持たない。
 * 持つと、正本を 1 本足したときに hook 側の一覧を直し忘れて、
 * 「足したものだけが守られない」という、いちばん気づけない壊れ方をする
 * （2026-08-28 の教訓「決め打ちの一覧」と同じ）。
 *
 * ⚠️ unmanaged は止めない。あれは「ここは意図して別物を持っている」という宣言で、
 *    そのリポジトリが自分で持つと決めた場所。止めると宣言の意味が逆になる。
 *
 * ⚠️ ポータル（standards/ を持つリポジトリ）では常に通す。正本を持つ側なので、
 *    ここで止めると正本そのものが直せなくなる。
 *
 * ── 必ず fail-open にすること ──────────────────────────
 *
 * 読み込みでも解析でも、何かおかしければ黙って通す（exit 0）。
 * この hook は 42 本へ配られる。壊れたときに編集が全部できなくなるほうが、
 * 防ごうとしている事故よりはるかに重い。
 * 「止められなかった」は次の配布で気づけるが、「何も編集できない」は
 * その場で作業が止まる。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 標準入力を最後まで読む */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 触ろうとしている場所が、正本のコピーかどうか。
 *
 * @param {string} relPath リポジトリ直下からの相対パス（posix 区切り）
 * @param {object} map standards-map.json
 * @returns {{canonical: string, local: string}|null} コピーなら対応、違えば null
 */
export function canonicalFor(relPath, map) {
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const target = norm(relPath);
  if (!target) return null;

  const unmanaged = (Array.isArray(map?.unmanaged) ? map.unmanaged : [])
    .map((u) => norm(u?.local ?? ''))
    .filter(Boolean);
  // 宣言された場所（およびその下）は、そのリポジトリのもの
  for (const u of unmanaged) {
    if (target === u || target.startsWith(`${u}/`)) return null;
  }

  for (const f of (Array.isArray(map?.files) ? map.files : [])) {
    if (norm(f?.local ?? '') === target) return { canonical: f.canonical, local: f.local };
  }
  for (const d of (Array.isArray(map?.dirs) ? map.dirs : [])) {
    const local = norm(d?.local ?? '');
    if (!local) continue;
    if (target === local || target.startsWith(`${local}/`)) {
      const rest = target.slice(local.length).replace(/^\//, '');
      return {
        canonical: rest ? `${d.canonical}/${rest}` : d.canonical,
        local: target,
      };
    }
  }
  return null;
}

/** 止める理由の文面。直し方まで書く（止めるだけでは次にどうすればよいか分からない） */
export function refusal({ canonical, local }) {
  return [
    `⛔ ${local} は正本 GIGAyama.github.io/standards/${canonical} のコピーです。`,
    '',
    'ここを直しても、他のリポジトリには届きません。それどころか次の配布で',
    '正本に上書きされて、直した内容は消えます（エラーは出ません）。',
    '',
    '直し方:',
    `  1. GIGAyama.github.io/standards/${canonical} を直す`,
    '  2. 正本をコミットする（先に配ると、手元だけ緑で正本が古く残る）',
    '  3. node tools/distribute.mjs で配る',
    '',
    'このリポジトリだけ別物を持つ必要があるなら、standards-map.json の',
    'unmanaged に理由つきで宣言してください。宣言した場所は止めません。',
  ].join('\n');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return 0;   // 読めない＝判断できない。通す
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return 0;

  const root = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  // 正本を持つ側（ポータル）では働かせない
  if (fs.existsSync(path.join(root, 'standards', 'check-drift.mjs'))) return 0;

  const mapPath = path.join(root, 'standards-map.json');
  if (!fs.existsSync(mapPath)) return 0;

  let map;
  try { map = JSON.parse(fs.readFileSync(mapPath, 'utf8')); }
  catch { return 0; }

  // リポジトリの外を触っているなら関係がない
  const abs = path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 0;

  const hit = canonicalFor(rel, map);
  if (!hit) return 0;

  process.stderr.write(refusal(hit) + '\n');
  return 2;   // 2 = 止める。stderr がエージェントに返る
}

/* 直接起動されたときだけ動かす。
   ⚠️ `file://${process.argv[1]}` を文字列で組み立てて比べないこと。Windows は
      file:///C:/… で、空白や日本語は百分率符号化されるため一致しない。
      2026-08-28 に giga-reviewer がこれで「何も検査せず exit 0」になっていた。 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith('guard-canonical.mjs');
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(0));   // 何があっても通す（fail-open）
}
