#!/usr/bin/env node
/**
 * lint-changelog.mjs — 更新ログ（docs/CHANGELOG.md）の書式を見る
 *
 *   node lint-changelog.mjs docs/CHANGELOG.md
 *   node lint-changelog.mjs docs/CHANGELOG.md --json
 *
 * ── なぜ要るのか ────────────────────────────────
 *
 * このファイルは giga-school.com の 3 か所に組み直される（トップの「更新したこと」・
 * 紹介ページ・使い方マニュアル）。**書式を外しても、手元では何も起きない。**
 * 気づくのは翌朝、書いたはずの行がどこにも出ていないときになる。
 *
 * いちばん多い外し方は日付の見出しで、`## 2026/08/23` や `## v1.2.0` は
 * 組み立て側（tools/lib/changelog.mjs の DATE_RE）が拾わないので、その下の
 * 項目ごと丸ごと消える。エラーも出ない。
 *
 * ⚠️ 落とすのは「機械が拾えなくなるもの」だけにする。書き方の好みで落とすと、
 *    書き手はこの検査を通さなくなる（lint-manual.mjs と同じ考え方）。
 *    言い回しは warn で言うだけで、止めない。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * ⚠️ この 2 つは tools/lib/changelog.mjs（ポータル）の写し。
 *    スキルは 42 本へ配られるので、あちらを import できない。
 *    食い違うと「lint は通ったのに出ない」が起きるので、
 *    ポータル側の tools/lib/changelog.test.mjs が両者を突き合わせている。
 */
const DATE_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/;
const ITEM_RE = /^\s*[-*]\s+(.+?)\s*$/;

/** 読み手（先生・子ども）に届かない語。落とさず、言い換えを勧めるだけ。 */
const JARGON = [
  'Service Worker', 'ServiceWorker', 'キャッシュ', 'リポジトリ', 'デプロイ',
  'リファクタ', 'ビルド', 'コミット', 'lint', 'CI', 'localStorage',
  '正本', 'ゲート', 'PR ', 'API',
];

/** コミットの題をそのまま貼ったもの。機械が撒いた語なので、これは落とす。 */
const CONVENTIONAL = /^(feat|fix|chore|refactor|docs|test|ci|build|perf|style)(\([^)]*\))?!?:/i;
const DISTRIBUTION = 'chore(standards): Sync with latest standards';

const ITEM_MIN = 8;
const ITEM_MAX = 45;
const PER_DAY_SHOWN = 3;    // トップで 1 アプリ 1 日あたりに出る数
const DAYS_SHOWN = 3;       // 紹介ページに出る日付の数

/** その日付が実在するか（2026-02-31 のような書きまちがいを拾う）。 */
function realDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * @param {string} md docs/CHANGELOG.md の中身
 * @param {string} [today] YYYY-MM-DD。未来の日付を見るため
 * @returns {{level: 'error'|'warn'|'info', line: number, message: string}[]}
 */
export function lintChangelog(md, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  const say = (level, line, message) => out.push({ level, line, message });
  const lines = String(md ?? '').split(/\r?\n/);

  /* コード枠の中は書き方の例。組み立て側も飛ばすので、ここでも飛ばす */
  const fenced = new Set();
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; fenced.add(i); return; }
    if (inFence) fenced.add(i);
  });

  const days = [];       // {date, line, items: [{text, line}]}
  let now = null;
  lines.forEach((raw, i) => {
    if (fenced.has(i)) return;
    const head = DATE_RE.exec(raw);
    if (head) { now = { date: head[1], line: i + 1, items: [] }; days.push(now); return; }

    /* 日付として書いたつもりが拾われない形。ここが「書いたのに出ない」の大半 */
    if (/^##\s+\S/.test(raw) && !head) {
      say('error', i + 1,
        `日付の見出しは ## YYYY-MM-DD にする（この形でないと拾われず、下の項目ごと消える）  ${raw.trim()}`);
      return;
    }
    if (!now) return;                       // 最初の日付より前は前書き
    const item = ITEM_RE.exec(raw);
    if (item) now.items.push({ text: item[1], line: i + 1, indented: /^\s+/.test(raw) });
  });

  if (!days.length) {
    say('error', 1, '日付の見出し（## YYYY-MM-DD）が 1 つも無い。このままでは何も出ない');
    return out;
  }

  const seen = new Map();
  days.forEach((d, n) => {
    if (!realDate(d.date)) say('error', d.line, `存在しない日付  ${d.date}`);
    if (seen.has(d.date)) {
      say('error', d.line, `同じ日付が 2 回ある（${seen.get(d.date)} 行目にもある）  ${d.date}`);
    } else seen.set(d.date, d.line);

    if (!d.items.length) {
      say('error', d.line, `中身の無い日付。見出しごと落とされるので、書いても出ない  ${d.date}`);
    }
    if (d.date > today) say('warn', d.line, `未来の日付  ${d.date}`);
    if (n > 0 && d.date > days[n - 1].date) {
      say('warn', d.line, '新しい順に並んでいない（出す順は機械が直すが、人が読むときに迷う）');
    }
    if (d.items.length > PER_DAY_SHOWN) {
      say('warn', d.line,
        `1 日に ${d.items.length} 項目。トップに出るのは ${PER_DAY_SHOWN} つまでで、`
        + '残りは黙って落ちる。大事なものを先に書く');
    }

    d.items.forEach((it) => {
      if (it.indented) {
        say('error', it.line,
          '入れ子の箇条書きは、親と並べて拾われる。ぶら下げずに 1 行にする');
      }
      if (it.text.startsWith(DISTRIBUTION)) {
        say('error', it.line, '正本配布のコミットの題。42 本すべてに同じ日付で入るので、使う人から見て何も変わっていない');
      } else if (CONVENTIONAL.test(it.text)) {
        say('error', it.line,
          `コミットの題をそのまま貼っている。使う人から見て何が変わったかに書き直す  ${it.text}`);
      }

      const hit = JARGON.filter((w) => it.text.includes(w));
      if (hit.length) {
        say('warn', it.line,
          `読み手（先生・子ども）に届かない言葉  ${hit.join(' / ')}  → 何ができるようになったかで言い換える`);
      }
      if (it.text.length > ITEM_MAX) {
        say('warn', it.line, `長い（${it.text.length}字）。${ITEM_MAX}字までにすると狭い画面で 2 行に収まる`);
      } else if (it.text.length < ITEM_MIN) {
        say('warn', it.line, `短すぎて何が変わったか分からない  ${it.text}`);
      }
      if (/[（(]?[^。]$/.test(it.text) && !/(しました|なりました|ました)$/.test(it.text)) {
        say('warn', it.line, `「〜しました」で言い切ると、何が起きたのかが伝わる  ${it.text}`);
      }
      if (/\*\*|`|^\||\[.+\]\(.+\)|<[a-z]/i.test(it.text)) {
        say('warn', it.line, '太字・表・リンク・HTML は字としてそのまま出る（書式は効かない）');
      }
    });
  });

  if (days.length > DAYS_SHOWN) {
    say('info', days[DAYS_SHOWN].line,
      `日付が ${days.length} 個。紹介ページに出るのは新しい ${DAYS_SHOWN} つまで（残しておいてよい）`);
  }
  return out;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const path = process.argv.find((a) => a.endsWith('.md'));
  if (!path) {
    console.error('使い方: node lint-changelog.mjs docs/CHANGELOG.md [--json]');
    process.exit(2);
  }
  const found = lintChangelog(readFileSync(path, 'utf8'));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(found, null, 1));
  } else if (!found.length) {
    console.log('✅ 更新ログの書式は問題ありません');
  } else {
    for (const f of found) {
      const mark = { error: '❌', warn: '⚠️ ', info: 'ℹ️ ' }[f.level];
      console.log(`${mark} ${path}:${f.line}  ${f.message}`);
    }
  }
  process.exit(found.some((f) => f.level === 'error') ? 1 : 0);
}
