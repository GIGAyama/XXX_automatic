/* eslint-disable */
/* 開発記録の記事を、機械で確かめられるところだけ確かめる。
 *
 *   node lint-devlog.mjs docs/devlog/2026-08-24-backlink.md
 *
 * ── なぜ note-article の検査を流用しなかったか ──────────────
 *
 * はじめは lint-article.mjs に --style で設定を渡して済ませるつもりだった。
 * 実際に走らせて**やめた**（2026-08-24 に測った結果）。
 *
 * 設定で切れない検査が 6 件ある。どれも note の入稿の都合に結びついている。
 *
 *   ✗ ファイル名に note-article が入っていない
 *   ✗ 1行目に「# タイトル」がない（開発記録は front matter で始まる）
 *   ✗ 水平線 ×2（front matter の --- を水平線と読む）
 *   ✗ ハッシュタグの行がない（note の検索の入口。開発記録には要らない）
 *   ✗ 本文が 1,200字未満（note 側の下限）
 *   ⚠ docs/note/ に置く
 *
 * 無理に通そうとすると、note 側の基準を緩めることになる。あちらは 31 本の記事が
 * 通っている基準なので、こちらの都合で緩めてはいけない。
 *
 * ── 借りたもの ────────────────────────────────
 *
 * 文体のルール（太字・記号・前置き・抽象語）と、囲みの中を検査から外す作りは
 * lint-article.mjs から持ってきた。あそこが積み上げたものなので、書き直さない。
 *
 * ── 開発記録だけにある検査 ──────────────────────
 *
 * 出してはいけないものの検査。プロンプトには生の事情が混ざる。
 * 学校名・セッションのリンクは、書いた本人には見えなくなっている。
 *
 * ✗ は直す。⚠ は見て判断する。ℹ は目安。
 * 依存なし。node 18 以上で動く。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';

const SECTIONS = [
  { heading: '何をしようとしたか', chars: [300, 700], required: true },
  /* ⚠️ 囲み（```）の中は字数に数えない。プロンプトの節は中身が囲みなので、
     ほかの節と同じ目安にすると必ず「短い」と出る。地の文だけの目安にして、
     中身の厚みは下の「囲みが 2〜5 個」で見る */
  { heading: '出したプロンプト', chars: [300, 1200], required: true },
  { heading: 'うまくいかなかったこと', chars: [500, 1800], required: true },
  { heading: '新しく知ったこと', chars: [400, 1200], required: false },
  { heading: 'できあがったもの', chars: [200, 600], required: false },
  { heading: '次に同じことをする人へ', chars: [300, 800], required: false },
];
const CHAR_RANGE = [2500, 7000];

/* note 版から引き継ぐ文体のルール。読み手が変わっても、
   人が書いた文章に読めることは同じ */
const SYMBOLS = ['→', '⇒', '／', '▲', '▼', '▶', '◀', '※', '＞', '≫', '：'];
const OPENERS = ['結論から言うと', '結論から述べると', 'いかがでしたか', 'いかがでしたでしょうか',
  'を解説します', 'について解説', 'まず初めに', '早速ですが', '本記事では', 'この記事では'];
const ABSTRACT = ['重要', '効率的', '革新的', '画期的', 'シームレス', 'ソリューション', 'エビデンス'];
/* A10 数量は算用数字。counters と keep は note 版の DEFAULT_STYLE と同じものを写している。
   片方だけ直すと、書き手が 2 つの検査から違うことを言われる */
const COUNTERS = ['時間', '週間', 'か月', '段階', '種類', 'メガバイト', 'キロバイト', 'ページ',
  '文字', '秒', '分', '日', '年', '桁', '枚', '回', '度', '人', '冊', '件', '問', '色',
  '個', '行', '列', '本', '台', '点', '手', '票', '階'];
const NUM_KEEP = ['十分(?=[でだにな])', '百分(?=率)', '[一二三四五六七八九十百千万]+分(?=の[一二三四五六七八九十百千万])'];
const CLOSERS = ['参考になれば幸いです', 'いかがでしたでしょうか', 'ぜひお試しください'];
/* 失敗をぼかす言い方。開発記録ではここが価値なので、薄めさせない */
const HEDGE = ['想定と異なる', '調整が必要', '一部で問題', '問題が発生'];
/* 自分を責める書き方も要らない。事実を書けば足りる */
const SELF_BLAME = ['お恥ずかしい', '猛省', '反省しきり', '不徳の致すところ'];

/* ⚠️ 出してはいけないもの。プロンプトには生の事情が混ざる。
   囲みの中も見る（プロンプトの中にこそ入っている） */
const LEAKS = [
  [/claude\.ai\/code\/session_|\bsession_[0-9A-Za-z]{6,}/g, 'セッションのリンク。本人しか開けない'],
  [/[^\s、。「」]{1,12}(小学校|中学校|小|中)の(\d|[一二三四五六])年/g, '学校名らしきもの'],
  [/[^\s、。「」]{2,10}(小学校|中学校)/g, '学校名らしきもの'],
  [/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, 'メールアドレス'],
];

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('使いかた: node lint-devlog.mjs <記事のパス>');
  process.exit(2);
}
const path = resolve(target);
if (!existsSync(path)) { console.error(`見つからない: ${path}`); process.exit(2); }

const src = readFileSync(path, 'utf8');
const lines = src.split('\n');

/* 囲み（```）の中は文体の検査から外す。プロンプトもエラーの出力も原文のまま出すため。
   lint-article.mjs と同じ作り */
const fenced = new Set();
{ let f = false; lines.forEach((l, i) => { if (/^\s*```/.test(l)) { f = !f; fenced.add(i); return; } if (f) fenced.add(i); }); }

/* front matter の範囲。ここも文体の検査から外す */
const fm = { from: -1, to: -1, data: {} };
if (lines[0]?.trim() === '---') {
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end > 0) {
    fm.from = 0; fm.to = end;
    for (const l of lines.slice(1, end)) {
      const m = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(l.trim());
      if (m) fm.data[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}
const inFm = (i) => fm.from >= 0 && i >= fm.from && i <= fm.to;

const isHeading = (l) => /^#{1,6}\s/.test(l);
const IMG_ANY = /!\[([^\]]*)\]\(([^)]+)\)/g;
const bodyLines = lines.map((l, i) => ({ l, i }))
  .filter(({ l, i }) => !fenced.has(i) && !inFm(i) && !isHeading(l));
const countOf = (t) => String(t).replace(IMG_ANY, '').replace(/\s/g, '').length;
const charCount = countOf(lines.filter((_, i) => !inFm(i)).join('\n'));

const issues = [];
const add = (level, line, rule, msg) => issues.push({ level, line, rule, msg });
const scanBody = (re, fn) => { for (const { l, i } of bodyLines) for (const m of l.matchAll(re)) fn(m, i + 1, l); };
const words = (rule, list, level) => {
  for (const w of list) for (const { l, i } of bodyLines) {
    let from = 0, at;
    while ((at = l.indexOf(w, from)) >= 0) { add(level, i + 1, rule, w); from = at + w.length; }
  }
};

// ------------------------------------------------------------ 1. front matter
if (fm.from < 0) {
  add('error', 1, '配信', 'front matter がない。組み立て側が記事だと分からない');
} else {
  for (const key of ['app', 'title', 'date']) {
    if (!fm.data[key]) add('error', 1, '配信', `front matter に ${key} がない`);
  }
  if (fm.data.date && !/^\d{4}-\d{2}-\d{2}$/.test(fm.data.date))
    add('error', 1, '配信', `date は YYYY-MM-DD で書く  ${fm.data.date}`);
  if (fm.data.published === undefined)
    add('error', 1, '配信', 'front matter に published がない。既定は false');
  else if (fm.data.published === 'true')
    add('warn', 1, '配信', 'published: true で納品しない。公開は書き手が決める');
  if (fm.data.pr && !/^\d+$/.test(fm.data.pr))
    add('error', 1, '配信', `pr は番号だけ書く  ${fm.data.pr}`);
}
if (!/^docs\/devlog\//.test(target.replace(/^\.\//, '')) && !dirname(path).endsWith('/docs/devlog'))
  add('warn', 0, '配信', `docs/devlog/ に置く。いまは ${dirname(path)}`);
if (!/^\d{4}-\d{2}-\d{2}-/.test(basename(path)))
  add('warn', 0, '配信', `ファイル名は <日付>-<短い名前>.md にする  ${basename(path)}`);

// ------------------------------------------------------------ 2. 出してはいけないもの
/* ⚠️ ここだけは囲みの中も見る。プロンプトの中にこそ入っている */
for (const [re, why] of LEAKS) {
  lines.forEach((l, i) => {
    if (inFm(i)) return;
    for (const m of l.matchAll(re)) add('error', i + 1, '公開できない', `${why}  ${m[0]}`);
  });
}

// ------------------------------------------------------------ 3. 節の構成
const heads = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => !fenced.has(i) && /^##\s/.test(l))
  .map(({ l, i }) => ({ text: l.replace(/^##\s*/, '').trim(), line: i + 1 }));

const sectionText = (heading) => {
  const at = heads.findIndex((h) => h.text === heading);
  if (at < 0) return '';
  const from = heads[at].line;
  const to = heads[at + 1]?.line ?? lines.length + 1;
  return lines.slice(from, to - 1).filter((_, k) => !fenced.has(from + k)).join('\n');
};

for (const s of SECTIONS) {
  const found = heads.some((h) => h.text === s.heading);
  if (!found) {
    add(s.required ? 'error' : 'info', 0, '構成',
      s.required ? `「${s.heading}」が無い` : `「${s.heading}」が無い（書けるなら書く）`);
    continue;
  }
  const n = countOf(sectionText(s.heading));
  if (n < s.chars[0] || n > s.chars[1])
    add('info', 0, '節の長さ', `${s.heading}  ${n}字（目安 ${s.chars[0]}〜${s.chars[1]}）`);
}
const known = new Set(SECTIONS.map((s) => s.heading));
const extras = heads.filter((h) => !known.has(h.text));
if (extras.length > 2)
  add('warn', 0, '構成', `決まった見出し以外が ${extras.length}本（2本まで）  ${extras.map((e) => e.text).join(' / ')}`);

// ------------------------------------------------------------ 4. 文体（note 版から引き継ぐ）
scanBody(/\*\*/g, (m, ln) => add('error', ln, '記号', '太字'));
for (const s of SYMBOLS) words('記号', [s], 'error');
scanBody(/\p{Extended_Pictographic}/gu, (m, ln) => add('error', ln, '記号', `絵文字  ${m[0]}`));
words('前置き', OPENERS, 'error');
words('抽象語', ABSTRACT, 'error');
words('締めの定型句', CLOSERS, 'error');
words('失敗をぼかす言い方', HEDGE, 'warn');
words('自分を責める書き方', SELF_BLAME, 'warn');
/* A10 数量は算用数字で書く。横書きで読まれるので、数字のほうが目に入る。
 * ⚠️ 一・二で始まる単独の数は見ない。「一度」「一人」「一つ」「一覧」「二人」と、
 *    数を数えていない言葉がそこに集まっていて、拾うと嘘の警告のほうが多くなる。
 *    「二十五種類」のように 2 文字以上つながるものは拾う。note 版と同じ作り。 */
{
  const KN = '[一二三四五六七八九十百千万]';
  const keepRe = new RegExp(`^(?:${NUM_KEEP.join('|')})`);
  const numRe = new RegExp(`(?<![一二三四五六七八九十百千万何])(?:[一二]${KN}+|[三四五六七八九十百千万]${KN}*)(?:${COUNTERS.join('|')})`, 'g');
  scanBody(numRe, (m, ln, l) => {
    if (keepRe.test(l.slice(m.index))) return;
    add('warn', ln, '表記', `数量は算用数字で書く  ${m[0]}`);
  });
}

// ------------------------------------------------------------ 5. プロンプトの節
{
  const at = heads.findIndex((h) => h.text === '出したプロンプト');
  if (at >= 0) {
    const from = heads[at].line;
    const to = heads[at + 1]?.line ?? lines.length + 1;
    let blocks = 0;
    for (let i = from; i < to - 1; i++) if (/^\s*```/.test(lines[i] || '')) blocks++;
    blocks = Math.floor(blocks / 2);
    if (blocks === 0)
      add('error', from, 'プロンプト', '囲み（```）が無い。地の文に溶かすとコピーできない');
    else if (blocks > 5)
      add('warn', from, 'プロンプト', `囲みが ${blocks}個（2〜5個が目安）。多いと読み手が追えない`);
    else if (blocks === 1)
      add('info', from, 'プロンプト', '囲みが 1個。効かなかったものも載せると役に立つ');
  }
}

// ------------------------------------------------------------ 6. リズム（note 版の C）
{
  const sentences = bodyLines.map(({ l }) => l).join('')
    .split(/(?<=。)/).map((s) => s.trim()).filter((s) => s.length > 1);
  if (sentences.length >= 3) {
    const avg = Math.round(sentences.reduce((a, s) => a + s.length, 0) / sentences.length);
    add('info', 0, 'リズム', `文 ${sentences.length}／平均 ${avg}字（手本は 33字）`);
    for (let i = 0; i + 2 < sentences.length; i++) {
      const t = sentences.slice(i, i + 3).map((s) => s.slice(-4));
      if (t[0] === t[1] && t[1] === t[2]) { add('warn', 0, 'リズム', `同じ文末が三つ続く  ${t[0]}`); break; }
    }
  }
}

// ------------------------------------------------------------ 7. 分量
if (charCount < CHAR_RANGE[0])
  add('error', 0, '分量', `短い  ${charCount.toLocaleString()}字（下限 ${CHAR_RANGE[0].toLocaleString()}）`);
else if (charCount > CHAR_RANGE[1])
  add('warn', 0, '分量', `長い  ${charCount.toLocaleString()}字（上限 ${CHAR_RANGE[1].toLocaleString()}）`);

// ------------------------------------------------------------ 出力
const mark = { error: '✗', warn: '⚠', info: 'ℹ' };
const order = { error: 0, warn: 1, info: 2 };
const label = { error: '直すところ', warn: '見て判断するところ', info: '目安' };

console.log(`\n${basename(path)}`);
console.log(`  ${charCount.toLocaleString()}字  見出し${heads.length}本  front matter ${fm.from >= 0 ? 'あり' : 'なし'}\n`);

let last = '';
for (const it of issues.sort((a, b) => order[a.level] - order[b.level] || a.line - b.line)) {
  if (it.level !== last) {
    const n = issues.filter((x) => x.level === it.level).length;
    console.log(`${last ? '\n' : ''}${label[it.level]}  ${n}件`);
    last = it.level;
  }
  console.log(`  ${mark[it.level]}  ${String(it.line || '-').padStart(3)}  [${it.rule}] ${it.msg}`);
}
if (!issues.length) console.log('指摘なし');

process.exit(issues.some((i) => i.level === 'error') ? 1 : 0);
