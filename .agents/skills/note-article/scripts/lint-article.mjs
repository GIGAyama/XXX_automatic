/* eslint-disable */
/* 書き上げた記事を、機械で確かめられるところだけ確かめる。
 *
 *   node lint-article.mjs docs/note/<app>-note-article.md
 *   node lint-article.mjs <記事> --style ../XXX_automatic/config/note-style.json
 *   node lint-article.mjs <記事> --min 7000 --max 12000
 *
 * ── 見ているものが2系統ある
 *
 * 1. 連載の基準。正本は XXX_automatic の config/note-style.json で、投稿ランチャーの
 *    note-lint.mjs が同じものを当てている。--style を渡せばそちらを読む。渡さなければ
 *    下の DEFAULT_STYLE（書き写したもの）を使う。ここが食いちがうと、書き手は
 *    2つの検査から違うことを言われる。
 * 2. 配信の都合。記事は note に貼られるだけでなく、giga-school.com/apps/<slug>/ の
 *    ページに毎朝組み直され、投稿ランチャーにも取りこまれる。どちらも記事の書き方に
 *    頼っているので、外すと黙って壊れる。人が読むぶんには気づけない種類の失敗になる。
 *
 * ✗ は直す。⚠ は見て判断する。ℹ は目安で、外れていても構わない。
 * 依存なし。node 18 以上で動く。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

/* ── 連載の基準（config/note-style.json の写し）──────────────────
 * 変えるときは向こうも変える。片方だけ直すと、書き手が板ばさみになる。 */
const DEFAULT_STYLE = {
  series: '教室で使えるかもしれないもの作り',
  sections: [
    { heading: '🏫 はじめに', chars: [600, 1200] },
    { heading: '📱 このアプリでできること', chars: [1200, 2200] },
    { heading: '✨ 導入のメリット', chars: [700, 1400] },
    { heading: '🛠️ 【管理者向け】導入手順', chars: [600, 1400] },
    { heading: '📖 【利用者向け】使い方のガイド', chars: [700, 1800], allowList: true },
    { heading: '📝 まとめ', chars: [400, 900] },
    { heading: '🏷 ハッシュタグ', generated: true },
  ],
  maxExtraSections: 2,
  charRange: [7000, 12000],
  captionMaxChars: 60,
  hashtagRange: [10, 16],
  forbidden: {
    bold: true,
    table: true,
    symbols: ['→', '／', '▲', '▶', '※', '＞', '≫', '⇒', '▼', '◀', '：'],
    listOutsideGuide: true,
    emojiInBody: true,
    openers: ['結論から言うと', '結論から述べると', 'いかがでしたか', 'いかがでしたでしょうか', 'を解説します', 'について解説', 'まず初めに', '早速ですが', '本記事では', 'この記事では'],
    jargon: [
      ['デプロイ', '公開の設定'], ['ローカルストレージ', 'その端末のなかだけに残ります'],
      ['WebRTC', '端末どうしの直接のやりとり'], ['P2P', '端末どうしの直接のやりとり'],
      ['API', '外部のサービスとのやりとり'], ['リポジトリ', '公開しているファイルの置き場'],
      ['キャッシュ', '端末に一度読みこんだもの'], ['レスポンシブ', '画面の大きさに合わせて'],
      ['インターフェース', '画面のつくり'], ['アルゴリズム', 'しくみ'],
      ['変数', ''], ['配列', ''], ['関数', ''], ['オブジェクト', ''],
    ],
    /* 「最適」と「活用」は入れない。「個別最適な学び」「ICTを活用する」は
       学習指導要領の言葉として現場で使われていて、実例の記事にも入っている。 */
    abstract: ['重要', '効率的', '革新的', '画期的', 'シームレス', 'ソリューション', 'エビデンス'],
    /* A10 数量は算用数字。counters は公開ずみ 32 本に出てきた助数詞を数えて並べた。
       keep は誤検知を実測して足したもの。「じゅうぶん」と読む十分、百分率、四分の一。
       この 3 つを外すと、32 本で 9 件の嘘の警告が出る。 */
    kanjiNumerals: {
      counters: ['時間', '週間', 'か月', '段階', '種類', 'メガバイト', 'キロバイト', 'ページ',
        '文字', '秒', '分', '日', '年', '桁', '枚', '回', '度', '人', '冊', '件', '問', '色',
        '個', '行', '列', '本', '台', '点', '手', '票', '階'],
      keep: ['十分(?=[でだにな])', '百分(?=率)', '[一二三四五六七八九十百千万]+分(?=の[一二三四五六七八九十百千万])'],
    },
  },
  naming: { children: '子どもたち', avoidForChildren: ['児童', '生徒'] },
};

/* ── AIらしさの追加検査 ─────────────────────────────
 * 正本には無いが、記号を禁じている理由（人が書いたものに読めること）から出てくるもの。
 * 全部 ⚠ にとどめる。 */
const EXTRA_WORDS = [
  ['前置き', ['以下で解説', 'ご紹介します', 'していきます', 'について説明します']],
  ['安全クッション', ['一般的に', '多くの場合', '一概には', '状況によって異なり', 'ケースバイケース', 'と言えるでしょう']],
  ['抽象語', ['最大限に', '多岐にわたる', '本質的', '様々な', 'さまざまな', '効果的']],
  ['抽象まとめ', ['まとめると', '要するに', '総じて', '以上のように']],
  ['締めの定型句', ['参考になれば幸い', 'ぜひお試しください', 'まずは小さく始め', 'お役に立てれば']],
];

/* 教室での出来事を、実際に見たこととして書いていないか（guardrails.json と同じ）。 */
const EXPERIENCE = [
  [/(?:うちの|わたしの|私の|自分の)(?:クラス|学級|教室)/, '自分の教室で起きたこととして書いている'],
  [/担任(?:している|する)(?:クラス|学級)/, '自分の教室で起きたこととして書いている'],
  [/(?:使って|やって|試して|導入して)み(?:たら|ると|たところ|て、)/, '実際に試した結果として書いている'],
  [/(?:子ども|児童)(?:たち)?(?:が|は|も)[^。]{0,20}(?:くれました|ていました|そうでした|喜んで|盛り上が)/, '子どもの様子を見たこととして書いている'],
  [/(?:去年|昨年度?|先週|先月|昨日|今週)(?:は|の)?(?:授業|学級|クラス|教室)/, 'いつの授業かを特定して書いている'],
  [/(?:学力|成績|点数)が(?:必ず|確実に|絶対)?(?:上が|伸び)/, '根拠のない学習効果の断定'],
];

// ---------------------------------------------------------------- 引数
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const target = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
if (!target) {
  console.error('使いかた: node lint-article.mjs <記事のパス> [--style note-style.json] [--min 7000] [--max 12000]');
  process.exit(2);
}
const path = resolve(target);
if (!existsSync(path)) { console.error(`見つからない: ${path}`); process.exit(2); }

const STYLE = (() => {
  const p = opt('style');
  if (!p) return DEFAULT_STYLE;
  const loaded = JSON.parse(readFileSync(resolve(p), 'utf8'));
  return { ...DEFAULT_STYLE, ...loaded, forbidden: { ...DEFAULT_STYLE.forbidden, ...(loaded.forbidden || {}) } };
})();
const MIN = Number(opt('min') || STYLE.charRange[0]);
const MAX = Number(opt('max') || STYLE.charRange[1]);

const src = readFileSync(path, 'utf8');
const lines = src.split('\n');
const dir = dirname(path);

// ---------------------------------------------------------------- 下ごしらえ
const IMG_ANY = /!\[([^\]]*)\]\(([^)]+)\)/g;
const IMG_LINE = /^!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)\s*$/;   // 組み立て側が拾える形はこれだけ
const fenced = new Set();
{ let f = false; lines.forEach((l, i) => { if (/^\s*```/.test(l)) { f = !f; fenced.add(i); return; } if (f) fenced.add(i); }); }
const isHeading = (l) => /^#{1,6}\s/.test(l);
const isTagLine = (l) => /^\s*#[^\s#]/.test(String(l).trim()) && !isHeading(String(l).trim());
const isImageLine = (l) => IMG_LINE.test(String(l).trim());

const bodyLines = lines.map((l, i) => ({ l, i }))
  .filter(({ l, i }) => !fenced.has(i) && !isHeading(l) && !isImageLine(l) && !isTagLine(l));
const bodyText = bodyLines.map(({ l }) => l).join('\n');
const countOf = (t) => String(t).replace(IMG_ANY, '').replace(/\s/g, '').length;
const charCount = countOf(src);

const issues = [];
const add = (level, line, rule, msg) => issues.push({ level, line, rule, msg });
const scanBody = (re, fn) => { for (const { l, i } of bodyLines) for (const m of l.matchAll(re)) fn(m, i + 1, l); };
const words = (rule, list, level = 'warn') => {
  for (const w of list) for (const { l, i } of bodyLines) {
    let from = 0, at;
    while ((at = l.indexOf(w, from)) >= 0) { add(level, i + 1, rule, `${w}`); from = at + w.length; }
  }
};

// ---------------------------------------------------------------- 節に切る
const heads = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => !fenced.has(i) && /^##\s/.test(l))
  .map(({ l, i }) => ({ text: l.replace(/^##\s*/, '').trim(), line: i + 1 }));
const sectionAt = (lineNo) => { let cur = ''; for (const h of heads) { if (h.line <= lineNo) cur = h.text; else break; } return cur; };
const sectionText = (name) => {
  const at = heads.findIndex((h) => h.text === name);
  if (at < 0) return '';
  const from = heads[at].line, to = heads[at + 1]?.line ?? lines.length + 1;
  return lines.slice(from, to - 1).join('\n');
};

// ---------------------------------------------------------------- 1. 配信の都合
if (!/note[-_]?article|article[-_]?note/i.test(basename(path)))
  add('error', 0, '配信', `ファイル名に note-article が入っていない。組み立て側が記事だと分からない  ${basename(path)}`);
if (basename(dir) !== 'note')
  add('warn', 0, '配信', `docs/note/ に置く。いまは ${dir}`);
for (const f of (existsSync(dir) ? readdirSync(dir) : []))
  if (/\.md$/i.test(f) && f !== basename(path) && !/^(readme|index|_index|contributing|changelog|license)\.md$/i.test(f))
    add('error', 0, '配信', `docs/note/ に別の Markdown がある。2本目の記事として拾われる  ${f}`);

const title = lines.find((l) => /^#\s/.test(l)) || '';
if (!title) add('error', 1, '配信', '1行目に「# タイトル」がない。note のタイトル欄に貼るもの');
if (charCount < 1200) add('error', 0, '配信', `本文が ${charCount}字。1,200字未満は記事とみなされず、取りこまれない`);

const refs = [...src.matchAll(IMG_ANY)];
const imgLines = lines.map((l, i) => ({ l: l.trim(), i })).filter(({ l }) => isImageLine(l));
if (refs.length !== imgLines.length)
  add('error', 0, '配信', `画像は1行に1枚、行頭から書く。文中に混ぜると組み立て側が拾えない（記法${refs.length}件、独立行${imgLines.length}件）`);
if (imgLines.length > 60) add('error', 0, '配信', `画像が ${imgLines.length}枚。投稿ランチャーが渡せるのは60枚まで`);
imgLines.forEach(({ l, i }, n) => {
  const m = l.match(IMG_LINE);
  const alt = m[1], tgt = m[2];
  if (/^[a-z][a-z0-9+.-]*:/i.test(tgt)) add('error', i + 1, '配信', `よそのアドレスの画像は渡せない  ${tgt}`);
  else {
    if (!/^\.?\/?images\//.test(tgt)) add('warn', i + 1, '配信', `画像は images/ の下に置く  ${tgt}`);
    if (!existsSync(resolve(dir, tgt))) add('error', i + 1, '配信', `画像が見つからない  ${tgt}`);
  }
  if (!alt.trim()) add('warn', i + 1, '配信', `alt が空。紹介ページの説明と読み上げに使われる  ${tgt}`);
  if (n === 0) add('info', i + 1, '配信', `1枚目は SNS のカード画像になる  ${tgt}`);
});
{
  const imgDir = join(dir, 'images');
  const used = new Set(refs.map((m) => basename(m[2].split(/[?#]/)[0])));
  if (existsSync(imgDir)) for (const f of readdirSync(imgDir))
    if (/\.(png|jpe?g|webp|gif)$/i.test(f) && !used.has(f)) add('warn', 0, '配信', `記事から参照されていない  images/${f}`);
}

{
  const first = bodyLines.map(({ l }) => l.trim()).find((l) => l && !l.startsWith('>'));
  if (first) {
    add('info', 0, '配信', `検索結果に出る説明文  ${first.slice(0, 110)}${first.length > 110 ? '…' : ''}`);
    if (first.length > 110) add('warn', 0, '配信', `最初の段落が110字で切られる。1文目だけで何の記事か分かる形にする（${first.length}字）`);
  }
}

{
  const setup = sectionText('🛠️ 【管理者向け】導入手順');
  if (setup) {
    if (!/アカウント|ログイン|サインイン/.test(setup)) add('warn', 0, '配信', 'アカウントが要るかどうかが導入手順に書かれていない。書かないと一覧の項目にも出せない');
    if (!/記録|保存|残りま|データ/.test(setup)) add('warn', 0, '配信', '記録がどこに残るかが導入手順に書かれていない。同上');
  }
}

/* 画面が古びていないか。
 * 記事だけ書き直すときにいちばん危ないのが、本文は新しいのに画像が前のままで、
 * 書いてあることと写っているものが食いちがう状態。人が読んでも気づきにくい。
 * git があるときだけ、アプリ側と画像側の最終コミットを比べる。 */
try {
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const root = git('rev-parse', '--show-toplevel');
  const at = (...spec) => { const t = git('log', '-1', '--format=%cI', '--', ...spec); return t ? new Date(t) : null; };
  const shots = at(join(dir, 'images'));
  const app = at(root, ':(exclude)*docs/*', ':(exclude)docs');
  if (shots && app) {
    const days = Math.round((app - shots) / 86400000);
    if (days > 30) add('warn', 0, '画面', `アプリが更新されてから${days}日ぶん、画面を撮り直していない。写っているものと本文が食いちがっていないか`);
    else {
      const when = days === 0 ? '同じ日' : days < 0 ? `${-days}日あと` : `${days}日前`;
      add('info', 0, '画面', `画像はアプリの最後の更新と${when}に撮られている`);
    }
  }
} catch { /* git が無い、あるいは履歴がない。黙って飛ばす */ }

// ---------------------------------------------------------------- 2. 記号と表記
const F = STYLE.forbidden;
if (F.bold) scanBody(/\*\*/g, (m, ln) => add('error', ln, '記号', '太字'));
scanBody(/(?<![*\w])\*[^*\s][^*\n]*\*(?!\*)/g, (m, ln) => add('error', ln, '記号', `斜体  ${m[0].slice(0, 20)}`));
if (F.table) scanBody(/^\s*\|/g, (m, ln) => add('error', ln, '記号', '表。note では表示されない'));
scanBody(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/g, (m, ln) => add('error', ln, '記号', '水平線'));
scanBody(/(?<!!)\[[^\]]*\]\([^)]+\)/g, (m, ln) => add('error', ln, '記号', `Markdown のリンク。URL をそのまま置く  ${m[0].slice(0, 28)}`));
for (const s of F.symbols || [])
  scanBody(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (m, ln) => add('error', ln, '記号', `禁止された記号  ${s}`));
scanBody(/(?<!\w)(?<!\w):[ \u3000]/g, (m, ln) => add('error', ln, '記号', '半角コロンのあとの空白'));
if (F.emojiInBody) scanBody(/\p{Extended_Pictographic}/gu, (m, ln) => add('error', ln, '記号', `本文に絵文字  ${m[0]}`));
if (F.listOutsideGuide) {
  const allowed = new Set((STYLE.sections || []).filter((s) => s.allowList).map((s) => s.heading));
  scanBody(/^\s*(?:[-*+・•]|\d+[.)．、])\s/g, (m, ln) => {
    const sec = sectionAt(ln);
    if (!allowed.has(sec)) add('error', ln, '記号', `「${sec || '見出しの前'}」で箇条書き。手順の節以外は文章で書く`);
  });
}
/* A10 数量は算用数字で書く。横書きで読まれるので、数字のほうが目に入る。
 * ⚠️ 一・二で始まる単独の数は見ない。「一度」「一人」「一つ」「一覧」「一歩」「二人」と、
 *    数を数えていない言葉がそこに集まっていて、拾うと嘘の警告のほうが多くなる。
 *    そのぶん「二手先」のような本物も素通りする。公開ずみ 32 本で測って決めた。
 *    「二十五種類」のように 2 文字以上つながるものは拾う。
 * ⚠️ ✗ にしない。嘘の警告が出つづけると、本物の警告が読み飛ばされる。 */
if (F.kanjiNumerals) {
  const KN = '[一二三四五六七八九十百千万]';
  const { counters = [], keep = [] } = F.kanjiNumerals;
  const keepRe = keep.length ? new RegExp(`^(?:${keep.join('|')})`) : null;
  const numRe = new RegExp(`(?<![一二三四五六七八九十百千万何])(?:[一二]${KN}+|[三四五六七八九十百千万]${KN}*)(?:${counters.join('|')})`, 'g');
  scanBody(numRe, (m, ln, l) => {
    if (keepRe && keepRe.test(l.slice(m.index))) return;
    add('warn', ln, '表記', `数量は算用数字で書く  ${m[0]}`);
  });
}
{
  const per1000 = (n) => (charCount ? (n * 1000) / charCount : 0);
  const k = (bodyText.match(/「/g) || []).length;
  const p = (bodyText.match(/[（(]/g) || []).length;
  add('info', 0, '密度', `かぎかっこ ${k}（1,000字あたり${per1000(k).toFixed(1)}）／かっこ ${p}（${per1000(p).toFixed(1)}）  実例は 4.1 と 2.9`);
  if (per1000(k) > 6) add('warn', 0, '密度', 'かぎかっこが多い。強調のために使っていないか');
  if (per1000(p) > 4) add('warn', 0, '密度', 'かっこが多い。次の一文に開く');
}

// ---------------------------------------------------------------- 3. 語彙
words('前置き', F.openers || [], 'error');
words('呼びかた', STYLE.naming?.avoidForChildren || [], 'error');
words('抽象語', F.abstract || [], 'error');
for (const [term, alt] of F.jargon || []) {
  if (!term) continue;
  for (const { l, i } of bodyLines) if (l.includes(term)) add('error', i + 1, '専門用語', `${term}${alt ? `  ${alt} と言いかえる` : ''}`);
}
for (const [rule, list] of EXTRA_WORDS) words(rule, list, 'warn');

// ---------------------------------------------------------------- 4. リズム
const sentences = bodyText.replace(/\n/g, '').split(/(?<=[。！？])/).map((s) => s.trim()).filter((s) => s.length > 1);
const endings = sentences.filter((s) => s.endsWith('。')).map((s) => s.slice(-4, -1));
let run = 1;
for (let i = 1; i < endings.length; i++) {
  if (endings[i] === endings[i - 1]) { run++; if (run === 3) add('warn', 0, 'リズム', `同じ文末が三つ続く  …${endings[i]}。`); } else run = 1;
}
const lens = sentences.map((s) => s.length);
const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
const sd = lens.length ? Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length) : 0;
if (lens.length > 20 && sd < 12) add('warn', 0, 'リズム', `文の長さがそろいすぎ  平均${avg.toFixed(0)}字、ばらつき${sd.toFixed(0)}`);
for (const w of ['筆者', '私たち', '当方']) for (const { l, i } of bodyLines) if (l.includes(w)) add('warn', i + 1, 'リズム', `一人称の混在  ${w}`);
scanBody(/(?:である|だろう|のだ)。/g, (m, ln) => add('warn', ln, 'リズム', `である調が混ざっている  ${m[0]}`));

// ---------------------------------------------------------------- 5. 内容
for (const [re, why] of EXPERIENCE)
  for (const { l, i } of bodyLines) { const hit = re.exec(l); if (hit) add('error', i + 1, '事実', `${why}  ${hit[0]}`); }
for (const w of ['間違いなく', '必ず盛り上が', 'いちばん盛り上がる', '確実に伸び', '劇的に'])
  for (const { l, i } of bodyLines) if (l.includes(w)) add('warn', i + 1, '事実', `効果を言い切っている  ${w}`);
/* 作った理由が書かれているか。機能の説明だけの記事は、事実が正しくても
   誰が書いても同じものになる。手本はどちらも「あえて〜しませんでした」を2回持っている。 */
{
  const count = (re) => (bodyText.match(re) || []).length;
  const reason = count(/そこで|だから|そのため|ためです|からです/g);
  const restraint = count(/あえて|入れていません|やめました|にしませんでした|しないことに|見送/g);
  const stance = count(/思って|思います|したかった|したくな/g);
  add('info', 0, '書き手', `理由 ${reason}／作らなかった話 ${restraint}／見立て ${stance}  手本は 8・2・8 と 9・2・6`);
  if (!restraint) add('warn', 0, '書き手', '作らなかったもの、やめたものの話が無い。取材で必ず聞く');
  if (!reason) add('warn', 0, '書き手', 'なぜその作りにしたのかが書かれていない。機能の説明だけになっていないか');
}

for (const w of ['アフィリ', '有料note', 'メンバーシップ', '投げ銭'])
  for (const { l, i } of bodyLines) if (l.includes(w)) add('error', i + 1, '事実', `収益化の導線。地方公務員法38条の確認が済むまで入れられない  ${w}`);

// ---------------------------------------------------------------- 6. 構成
const want = (STYLE.sections || []).map((s) => s.heading);
{
  let at = 0;
  for (const h of want) {
    const found = heads.findIndex((x, i) => i >= at && x.text === h);
    if (found < 0) add('error', 0, '構成', `見出しがない、または並びが違う  ${h}`);
    else at = found + 1;
  }
  const known = new Set(want);
  const extras = heads.filter((h) => !known.has(h.text));
  if (extras.length > (STYLE.maxExtraSections ?? 2))
    add('error', 0, '構成', `決まった見出し以外が ${extras.length}本（${STYLE.maxExtraSections}本まで）  ${extras.map((e) => e.text).join(' / ')}`);
  const from = heads.find((h) => h.text === want[1]);
  const to = heads.find((h) => h.text === want[2]);
  for (const e of extras) if (from && to && !(e.line > from.line && e.line < to.line))
    add('warn', e.line, '構成', `追加の見出しは 📱 と ✨ のあいだに置く  ${e.text}`);
}
if (title) {
  if (!title.includes(STYLE.series)) add('error', 1, '構成', 'タイトルに連載名がない');
  if (/#[◯○]/.test(title)) add('warn', 1, '構成', '連載番号が未記入。納品時に書き手へ伝える');
  const bare = title.replace(/^#\s*/, '').replace(new RegExp(`^${STYLE.series}\\s*#\\S*\\s*`), '').trim();
  if ((bare.match(/[「」]/g) || []).length < 4) add('error', 1, '構成', 'タイトルの型。困っていることとアプリ名を鉤かっこで置く');
  if (bare.length > 50) add('error', 1, '構成', `タイトルが長い。連載名を除いて${bare.length}字（50字まで）`);
}
for (const s of STYLE.sections || []) {
  if (s.generated || !s.chars) continue;
  const t = sectionText(s.heading);
  if (!t) continue;
  const n = countOf(t);
  if (n < s.chars[0] || n > s.chars[1]) add('info', 0, '節の長さ', `${s.heading}  ${n}字（目安 ${s.chars[0]}〜${s.chars[1]}）`);
}

// ---------------------------------------------------------------- 7. キャプション
lines.forEach((l, i) => {
  if (!isImageLine(l)) return;
  const next = (lines[i + 1] || '').trim() === '' ? (lines[i + 2] || '') : (lines[i + 1] || '');
  const t = next.trim();
  if (!t || isHeading(t) || isImageLine(t)) { add('warn', i + 1, 'キャプション', 'ない'); return; }
  if (t.length > 120) add('error', i + 1, 'キャプション', `120字を超えると説明とみなされず、紹介ページで本文に二重に出る（${t.length}字）`);
  else if (t.length > (STYLE.captionMaxChars ?? 60)) add('warn', i + 1, 'キャプション', `長い（${t.length}字、目安${STYLE.captionMaxChars ?? 60}字）`);
});

// ---------------------------------------------------------------- 8. ハッシュタグ
{
  const tagLines = lines.filter((l) => isTagLine(l));
  const last = [...lines].reverse().find((l) => l.trim() !== '') || '';
  const tags = tagLines.length ? tagLines.join(' ').trim().split(/\s+/) : [];
  const [lo, hi] = STYLE.hashtagRange || [10, 16];
  if (!tags.length) add('error', 0, 'タグ', 'ハッシュタグの行がない。note の検索の入口になる');
  else {
    if (!isTagLine(last)) add('error', 0, 'タグ', 'ハッシュタグは記事のいちばん最後に置く。あとに段落があると拾われない');
    if (!tags.every((t) => /^#\S+$/.test(t))) add('error', 0, 'タグ', 'タグの行に # で始まらない語が混ざっている。行ごと拾われなくなる');
    if (tags.length < lo || tags.length > hi) add('warn', 0, 'タグ', `${tags.length}個（${lo}〜${hi}個）`);
  }
}

// ---------------------------------------------------------------- 9. 分量
if (charCount < MIN) add('error', 0, '分量', `短い  ${charCount.toLocaleString()}字（下限 ${MIN.toLocaleString()}）`);
if (charCount > MAX) add('error', 0, '分量', `長い  ${charCount.toLocaleString()}字（上限 ${MAX.toLocaleString()}）`);

// ---------------------------------------------------------------- 出力
const mark = { error: '✗', warn: '⚠', info: 'ℹ' };
const group = (list) => {
  const by = new Map();
  for (const i of list) {
    const k = `${i.rule}|${i.msg}`;
    if (!by.has(k)) by.set(k, { ...i, count: 0, lines: [] });
    const g = by.get(k); g.count++; if (i.line) g.lines.push(i.line);
  }
  return [...by.values()].sort((a, b) => (a.lines[0] || 0) - (b.lines[0] || 0));
};
const show = (level, headline) => {
  const list = issues.filter((i) => i.level === level);
  if (!list.length) return;
  console.log(`\n${headline}  ${list.length}件`);
  for (const g of group(list))
    console.log(`  ${mark[level]} ${String(g.line || '-').padStart(4)}  [${g.rule}] ${g.msg}`
      + (g.count > 1 ? `  ×${g.count}  行 ${g.lines.slice(0, 8).join(', ')}` : ''));
};

console.log(`\n${basename(path)}`);
console.log(`  ${charCount.toLocaleString()}字  画像${imgLines.length}枚  見出し${heads.length}本  文${sentences.length}  平均${avg.toFixed(0)}字`);
show('error', '直すところ');
show('warn', '見て判断するところ');
show('info', '目安');
if (!issues.some((i) => i.level !== 'info')) console.log('\n機械で見られるところは通った。あとは声に出して読む。');
console.log('');
process.exit(issues.some((i) => i.level === 'error') ? 1 : 0);
