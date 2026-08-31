import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { lintManual } from './lint-manual.mjs';

/**
 * 通るマニュアルの最小形。ここを土台に 1 か所ずつ壊して試す。
 *
 * ⚠️ 2026-08-29 に、この検査の考え方を変えた。それまでは
 *    「## は 5 つ固定」を確かめていたが、その決まりには技術的な根拠が無く
 *    （目次も索引も見出しの位置しか見ていない）、機能をいくつ持つアプリでも
 *    全部を「できること」の 1 章に押しこませる害があった。
 *    いまは章立てを自由にし、代わりに**名前の質**と**大きさ**を見る。
 */
const OK = `# たしかめアプリ の使い方

## はじめに

かけ算の練習ができるアプリです。学級担任の先生が使います。

読む前に、次のものをお手元にご用意ください。

- インターネットにつながったパソコンかタブレット
- 学校から配られたアプリの URL

## 画面の見かたと各部の名前

![ホーム画面](images/01-home.png)

まんなかに問題が出ます。

## 出てきた問題に答える

1 問ずつ出てくる問題に答えられます。

### 練習をはじめる

1. 「はじめる」を押してください。
2. 答えを選んでください。

![練習の画面](images/02-play.png)

3. 「つぎへ」を押すと、次の問題に進みます。

### とちゅうでやめる

「やめる」を押すと、そこまでの記録を残して終われます。

## これまでの記録を見る

「きろく」を押すと、これまでの結果を見られます。

## こまったとき

### 画面が真っ白のまま進まない

いちど閉じて、開き直してください。
`;

const errorsOf = (md) => lintManual(md).filter((f) => f.level === 'error').map((f) => f.message);
const warnsOf = (md) => lintManual(md).filter((f) => f.level === 'warn').map((f) => f.message);

test('ふつうのマニュアルは通る', () => {
  assert.deepEqual(errorsOf(OK), []);
  assert.deepEqual(warnsOf(OK), []);
});

/* --- 題 --------------------------------------------------------- */
test('題が無い / 2 本ある', () => {
  assert.match(errorsOf(OK.replace('# たしかめアプリ の使い方', '## はじめの題')).join(),
    /題（# ではじまる行）が無い/);
  assert.match(errorsOf(`${OK}\n# もう 1 本\n`).join(), /# は 1 本だけ/);
});

/* --- 章立ては自由。ただし質を見る ---------------------------------- */
test('章の名前も数も自由（5 つ固定をやめた）', () => {
  const md = `# あ の使い方

## このアプリでできること全体の流れ

用意するものはありません。

## 週の予定を書きこむ

![絵](images/01-a.png)

### セルに直接書く

1. セルを押してください。

## 書いたものを紙に印刷する

![絵](images/02-b.png)

### A4 に収めて印刷する

1. 「印刷」を押してください。

## うまくいかないとき

### 画面が出ない

開き直してください。
`;
  assert.deepEqual(errorsOf(md), [], '知らない章名でも落とさない');
});

test('中身の分からない章の名前は落とす', () => {
  for (const bad of ['できること', 'その他', '機能', '応用']) {
    const md = OK.replace('## これまでの記録を見る', `## ${bad}`);
    assert.match(errorsOf(md).join(), new RegExp(`「${bad}」だけでは何の説明か分からない`),
      `${bad} は落とすこと`);
  }
});

test('目印つきの見出しでも、中身で判定する', () => {
  /* 【重要】できること のように目印が付いていても、中身は「できること」 */
  const md = OK.replace('## これまでの記録を見る', '## 【重要】できること');
  assert.match(errorsOf(md).join(), /だけでは何の説明か分からない/);
});

test('短すぎる見出しは警告（ただし「はじめに」は決まりきった名前なので通す）', () => {
  assert.match(warnsOf(OK.replace('## これまでの記録を見る', '## 記録')).join(), /字と短い/);
  assert.ok(!warnsOf(OK).some((w) => /はじめに/.test(w)), '「はじめに」では鳴らないこと');
});

test('章が 3 つ未満だと落とす（機能ごとに章を立てていない形）', () => {
  const md = `# あ の使い方

## はじめに

用意するものはありません。

## できることぜんぶ

![絵](images/01-a.png)

### ひとつめ

1. 押してください。
`;
  assert.match(errorsOf(md).join(), /章（##）が 2 つしかない/);
});

test('節を抱えすぎた章は警告する（機能を 1 章に押しこんだ形）', () => {
  const subs = Array.from({ length: 12 }, (_, i) => `### きのう ${i + 1} を使う\n\n1. 押してください。\n`).join('\n');
  const md = OK.replace('### とちゅうでやめる\n\n「やめる」を押すと、そこまでの記録を残して終われます。\n', subs);
  assert.match(warnsOf(md).join(), /節が \d+ つある/);
});

test('同じ種類のものが 9 つ並ぶ章では鳴らさない（症状ごとの「こまったとき」は正しい形）', () => {
  const subs = Array.from({ length: 9 }, (_, i) => `### 症状 ${i + 1} が出たとき\n\n直してください。\n`).join('\n');
  const md = OK.replace('### 画面が真っ白のまま進まない\n\nいちど閉じて、開き直してください。\n', subs);
  assert.ok(!warnsOf(md).some((w) => /節が/.test(w)), '9 つでは鳴らないこと');
});

test('見出しに自分で番号を振らない（ページの目次が振るので二重になる）', () => {
  assert.match(errorsOf(OK.replace('## はじめに', '## 1. はじめに')).join(), /見出しに番号を書かない/);
  assert.match(errorsOf(OK.replace('### 練習をはじめる', '### 3.1 練習をはじめる')).join(),
    /見出しに番号を書かない/);
});

test('①②③ は通す（順番そのものを見せたいときに使う）', () => {
  const md = OK.replace('### 練習をはじめる', '### ① はじめの画面をひらく');
  assert.ok(!errorsOf(md).some((e) => /番号を書かない/.test(e)));
});

/* --- 機械が足す節 ------------------------------------------------- */
test('機械が足す節を手で書かせない', () => {
  for (const bad of ['学校で使うときは', '変わったこと']) {
    const md = OK.replace('## こまったとき', `## ${bad}\n\nあれこれ。\n\n## こまったとき`);
    assert.match(errorsOf(md).join(), new RegExp(`「${bad}」は書かない`));
    assert.match(errorsOf(md).join(), /filtering/);
  }
});

/* --- 用意するもの --------------------------------------------------- */
test('読む前に用意するものが無いと警告', () => {
  const md = OK.replace(/読む前に、次のものをお手元にご用意ください。[\s\S]*?- 学校から配られたアプリの URL\n/,
    'すぐに使えます。\n');
  assert.match(warnsOf(md).join(), /用意するもの/);
});

/* --- 画像 --------------------------------------------------------- */
test('画面写真が 1 枚も無いと落ちる', () => {
  assert.match(errorsOf(OK.replace(/^!\[.*$/gm, '')).join(), /画面写真が 1 枚も無い/);
});

test('画像の書き方', () => {
  assert.match(errorsOf(OK.replace('![ホーム画面](images/01-home.png)',
    '![](images/01-home.png)')).join(), /alt を空にしない/);
  assert.match(errorsOf(OK.replace('![ホーム画面](images/01-home.png)',
    '![ホーム画面](https://example.com/a.png)')).join(), /相対指定/);
  assert.match(errorsOf(OK.replace('![ホーム画面](images/01-home.png)',
    '![ホーム画面](shots/01-home.png)')).join(), /images\/ に置く/);
  assert.match(errorsOf(OK.replace('![ホーム画面](images/01-home.png)',
    'まんなかに ![ホーム画面](images/01-home.png) が出ます')).join(), /1 行に 1 枚/);
});

test('番号つき手順の途中に画像を置いてよい（組み立て側で番号を続けるようにした）', () => {
  /* OK の土台がまさにこの形（1,2 → 画像 → 3）。落ちないこと */
  assert.deepEqual(errorsOf(OK), []);
  assert.ok(!warnsOf(OK).some((w) => /番号/.test(w)));
});

test('手順のあいだに長い段落を置くと、番号が戻ることを知らせる', () => {
  const md = OK.replace('![練習の画面](images/02-play.png)\n',
    `![練習の画面](images/02-play.png)\n\n${'あ'.repeat(200)}\n`);
  assert.match(warnsOf(md).join(), /番号が 1 に戻る/);
});

test('キャプションのつもりで少し長すぎるものは警告', () => {
  const md = OK.replace('まんなかに問題が出ます。', 'あ'.repeat(130));
  assert.match(warnsOf(md).join(), /ふつうの本文になる/);
});

/* --- 組み立てが扱わない書き方 --------------------------------------- */
test('組み立てが扱わない書き方', () => {
  assert.match(errorsOf(`${OK}\n| a | b |\n`).join(), /表は組み立てが扱わない/);
  assert.match(errorsOf(`${OK}\n---\n`).join(), /水平線/);
  assert.match(warnsOf(OK.replace('1 問ずつ', '**1 問ずつ**')).join(), /太字は使わない/);
});

test('囲みの中は本文として見ない（手順の例を書けるように）', () => {
  const md = `${OK}\n\`\`\`\n| これは表ではない |\n---\n**太字でもない**\n## できること\n\`\`\`\n`;
  assert.deepEqual(errorsOf(md), []);
  assert.deepEqual(warnsOf(md), []);
});

/* --- 目次と紙 ------------------------------------------------------- */
test('見出しの括弧が半角だと警告（目次と検索結果に並ぶので目につく）', () => {
  const md = OK.replace('## これまでの記録を見る', '## これまでの記録を見る (メニュー操作)');
  assert.match(warnsOf(md).join(), /全角（）にする/);
  assert.ok(!warnsOf(OK.replace('## これまでの記録を見る', '## これまでの記録を見る（メニュー操作）'))
    .some((w) => /全角/.test(w)), '全角なら鳴らさない');
});

test('目印を全部の見出しに付けると警告（少ないから効く）', () => {
  const md = OK.replace(/^## /gm, '## 【重要】');
  assert.match(warnsOf(md).join(), /本当に飛ばすと困るものだけに残す/);
  assert.ok(!warnsOf(OK.replace('## こまったとき', '## 【重要】こまったとき'))
    .some((w) => /だけに残す/.test(w)), '1 本なら鳴らさない');
});

test('目次に並ぶ行が多すぎると警告（狭い画面では本文の前に積まれる）', () => {
  const many = OK + Array.from({ length: 80 }, (_, i) => `\n### ${i} 番目の機能を使う\n\nここに説明が入ります。\n`).join('');
  assert.match(warnsOf(many).join(), /目次に並ぶ行が/);
  assert.ok(!warnsOf(OK).some((w) => /目次に並ぶ行/.test(w)));
});

test('薄い章が並ぶと警告する。ただし短いマニュアルでは鳴らさない', () => {
  /* 印刷すると章の頭で改ページするので、薄い章のぶんだけ半分白い紙が出る */
  const filler = Array.from({ length: 160 }, (_, i) => `あ${i} の説明です。`).join('\n\n');
  const long = OK.replace('「きろく」を押すと、これまでの結果を見られます。', filler);
  assert.match(warnsOf(long).join(), /半分白いページ/);

  /* 土台の OK は紙 2〜3 枚ぶんしかない。ここで鳴らすと直しようがない */
  assert.ok(!warnsOf(OK).some((w) => /半分白いページ/.test(w)));
});

/* --- 画像の書き方（組み立てとの食い違い） ---------------------------- */
test('画像の名前に空白があると落とす（組み立ては空白の手前までしか読まない）', () => {
  const md = OK.replace('![ホーム画面](images/01-home.png)', '![ホーム画面](images/01 home.png)');
  assert.match(errorsOf(md).join(), /空白を入れない/);
});

test('alt に ] が入った行は、検査も組み立ても拾えないので落とす', () => {
  /* ⚠️ どちらの正規表現も alt を [^\]]* で取るので、行がそのまま
     `![…](images/…)` という字として本文に印字される。黙って通すのがいちばん悪い */
  const md = OK.replace('![ホーム画面](images/01-home.png)', '![ホーム画面 [1]](images/01-home.png)');
  assert.match(errorsOf(md).join(), /画像の書き方が壊れている/);
});

test('字下げした画像は落とす（行頭からでないと拾われない）', () => {
  const md = OK.replace('![ホーム画面](images/01-home.png)', '  ![ホーム画面](images/01-home.png)');
  assert.match(errorsOf(md).join(), /行頭から書く/);
});

test('画像の直後のラベル行・箱の見出しを拾う（短いので長さでは拾えない）', () => {
  /* 2026-08-29、週案エディタのマニュアルで「【！】覚えておいていただきたいこと:」が
     18 字だったため 45 字のしきい値をすり抜け、添え字に降格していた */
  const label = OK.replace('![ホーム画面](images/01-home.png)\n',
    '![ホーム画面](images/01-home.png)\n\n練習をはじめる手順:\n');
  assert.match(warnsOf(label).join(), /本文から外れる/);

  const box = OK.replace('![ホーム画面](images/01-home.png)\n',
    '![ホーム画面](images/01-home.png)\n\n【！】覚えておいていただきたいこと:\n');
  assert.match(warnsOf(box).join(), /本文から外れる/);

  /* ふつうの短い説明文では鳴らさない（それは本当に写真の説明） */
  assert.ok(!warnsOf(OK).some((w) => /本文から外れる/.test(w)));
});

/* 見出しの中のルビ。2026-08-30 にいったん警告を足したが、同じ日に外した。
   目次と検索の索引が <rt> の中身まで拾っていたのが理由だったところ、
   目次こそ漢字の読めない子が最初に見るところなので、組み立ての側
   （tools/lib/plain-text.mjs）を直した。ここで警告を戻すと、
   いちばんルビの要る場所だけルビが無いマニュアルに戻る。 */
test('見出しの中のルビは何も言わない', () => {
  const found = lintManual([
    '# つかいかた',
    '## <ruby>学<rt>がく</rt></ruby>年で しぼりこむ',
    '本文。',
    '![あ](images/01-a.png)',
  ].join('\n'));
  assert.equal(found.filter((f) => /ルビ/.test(f.message)).length, 0);
});

test('本文の中のルビは何も言わない', () => {
  const found = lintManual([
    '# つかいかた',
    '## 学年で しぼりこむ',
    '<ruby>学<rt>がく</rt></ruby>年の タブを おします。',
    '![あ](images/01-a.png)',
  ].join('\n'));
  assert.equal(found.filter((f) => /ルビ/.test(f.message)).length, 0);
});

/* ── ふりがなと、長さで見ている検査 ────────────────────────
 * 子ども向けマニュアルの本文には <ruby>計算<rt>けいさん</rt></ruby> が入る。
 * 素の字は 2 字だが、文字列は 30 字ちかい。長さを素のまま見ると、
 * 書き手がふりがなを足しただけで検査の結論が変わる。
 */

test('ふりがなで水増しされた見出しでも、短ければ短いと言う', () => {
  // 「<ruby>色<rt>いろ</rt></ruby>」は 26 字あるが、読む長さは 1 字
  const found = lintManual([
    '# つかいかた',
    '## <ruby>色<rt>いろ</rt></ruby>',
    '本文。',
    '![あ](images/01-a.png)',
    '## つぎの しょう',
    '本文。',
    '## みっつめの しょう',
    '本文。',
  ].join('\n'));
  assert.ok(found.some((f) => /字と短い/.test(f.message)),
    'ふりがなの分だけ長く数えて、短い見出しを見のがしている');
});

test('ふりがなを振った説明文を「長すぎる」と言わない', () => {
  // 読む長さは 30 字ほど。ふりがな込みでは 120 字を超える
  const cap = 'ここを 見て ください。おすと <ruby>制限時間<rt>せいげんじかん</rt></ruby>の '
    + '<ruby>設定<rt>せってい</rt></ruby>が ひらき、<ruby>出題<rt>しゅつだい</rt></ruby>の '
    + '<ruby>順番<rt>じゅんばん</rt></ruby>を えらべます。';
  assert.ok(cap.length > 120, 'この試験の前提が崩れている');
  const found = lintManual([
    '# つかいかた',
    '## さいしょの しょう',
    '本文。',
    '![あ](images/01-a.png)',
    '',
    cap,
    '',
    '## つぎの しょう',
    '本文。',
    '## みっつめの しょう',
    '本文。',
  ].join('\n'));
  assert.equal(found.filter((f) => /画像の直後の 1 段落が/.test(f.message)).length, 0,
    'ふりがなの分だけ長く数えて、説明文を本文あつかいしている');
});

test('目印にふりがなが振ってあっても、【重要】の多さを数え落とさない', () => {
  // 子ども向けでは【<ruby>重要<rt>じゅうよう</rt></ruby>】と書くのが決まりどおり。
  // 素のまま探すと 0 本に見えて、この警告が永久に出なくなる
  const head = (n) => `## 【<ruby>重要<rt>じゅうよう</rt></ruby>】${n}つめの しょう\n本文。\n`;
  const found = lintManual('# つかいかた\n' + [1, 2, 3, 4, 5, 6].map(head).join(''));
  assert.ok(found.some((f) => /【重要】【！！】の付いた見出しが/.test(f.message)),
    'ふりがなの分で数え落としている');
});

/* ── 中身を見る検査は、ふりがなを外してから ────────────────────
 * ルビは語の途中に markup を挟むので、素の文字列には探している並びが残らない。
 * 直す前は「ふりがなを振った書き手だけが検査をすり抜ける」形になっていた。
 */

const R = (w, r) => `<ruby>${w}<rt>${r}</rt></ruby>`;
const CH = (n) => `## ${n}つめの しょう\n本文。\n`;

test('機械が足す節は、ふりがなを振っても見つける', () => {
  const found = lintManual(['# つかいかた',
    `## ${R('学校', 'がっこう')}で${R('使', 'つか')}うときは`, '本文。',
    CH(2), CH(3)].join('\n'));
  assert.ok(found.some((f) => /機械が足す/.test(f.message)),
    'ふりがなを振ると、手書きの「学校で使うときは」を見のがす');
});

test('中身の無い見出しは、ふりがなを振っても落とす', () => {
  const found = lintManual(['# つかいかた', `## ${R('機能', 'きのう')}`, '本文。',
    CH(2), CH(3)].join('\n'));
  assert.ok(found.some((f) => f.level === 'error' && /何の説明か分からない/.test(f.message)),
    'ふりがなを振ると、中身の無い見出しが素通りする');
});

test('用意するものの言葉は、ふりがなを振っても見つける', () => {
  const found = lintManual(['# つかいかた', '## さいしょの しょう',
    `${R('用意', 'ようい')}する ものは タブレットです。`, CH(2), CH(3)].join('\n'));
  assert.equal(found.filter((f) => /用意する ものが/.test(f.message)).length, 0);
});

test('<rp> の半角かっこを、見出しの括弧の乱れと言わない', () => {
  // format.md が通すと書いている書き方。対応ブラウザには出ない札である
  const found = lintManual(['# つかいかた',
    '## <ruby>設定<rp>(</rp><rt>せってい</rt><rp>)</rp></ruby>を かえる',
    '本文。', CH(2), CH(3)].join('\n'));
  assert.equal(found.filter((f) => /括弧を全角/.test(f.message)).length, 0);
});

/* ── 組み立てが通さない書き方は、公開ページで丸ごと字になる ──────── */

for (const [name, bad] of [
  ['属性つきの <ruby>', '<ruby lang="ja">学<rt>がく</rt></ruby>'],
  ['属性つきの <rt>', '<ruby>学<rt lang="ja">がく</rt></ruby>'],
  ['大文字', '<RUBY>学<RT>がく</RT></RUBY>'],
  ['閉じ括弧の前の空白', '<ruby >学<rt>がく</rt></ruby>'],
  ['<rb> つきの完全形', '<ruby><rb>学</rb><rt>がく</rt></ruby>'],
]) {
  test(`${name} は落とす（そのままだと字になって出る）`, () => {
    const found = lintManual(['# つかいかた', '## さいしょの しょう',
      `${bad}年で しぼりこむ。`, CH(2), CH(3)].join('\n'));
    assert.ok(found.some((f) => f.level === 'error' && /ふりがなの書き方が通りません/.test(f.message)),
      `${bad} を見のがしている`);
  });
}

test('閉じ忘れた <ruby> を落とす', () => {
  const found = lintManual(['# つかいかた', '## さいしょの しょう',
    '<ruby>学年<rt>がくねん</rt>で しぼりこむ。', CH(2), CH(3)].join('\n'));
  assert.ok(found.some((f) => f.level === 'error' && /数が合いません/.test(f.message)));
});

test('正しいふりがなには何も言わない（閉じタグの省略も含めて）', () => {
  const found = lintManual(['# つかいかた', '## さいしょの しょう',
    `${R('学年', 'がくねん')}で しぼりこむ。`,
    '<ruby>計算<rp>(</rp><rt>けいさん</rt><rp>)</rp></ruby>の れんしゅう。',
    '<ruby>時間<rt>じかん</ruby>を きめる。',
    CH(2), CH(3)].join('\n'));
  assert.equal(found.filter((f) => /ふりがなの書き方|数が合いません/.test(f.message)).length, 0);
});

/**
 * ⚠️ シンボリックリンク越しに 走らせても、CLI が ちゃんと 動くか。
 *
 * 旗艦リポジトリの `.claude/skills/giga-manual/` は正本 `standards/skills/…` への
 * シンボリックリンクで、SKILL.md はその道を案内している。main の判定に
 * `process.argv[1]` を そのまま つかっていると、`import.meta.url`（実体の道）と
 * 食い違って **CLI がまるごと動かない**。何も出さず exit 0 で終わるので、
 * 書き手からは「検査に通った」と見える。2026-08-31 に実測して直した。
 */
test('シンボリックリンク越しでも CLI が動く（無言で exit 0 にならない）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-manual-'));
  const link = join(dir, 'lint-manual.mjs');
  const md = join(dir, 'bad.md');
  symlinkSync(fileURLToPath(new URL('./lint-manual.mjs', import.meta.url)), link);
  writeFileSync(md, '章も 画面写真も 無い、題だけの マニュアル。\n');

  const run = spawnSync(process.execPath, [link, md], { encoding: 'utf8' });
  assert.equal(run.status, 1, `落ちるはずが status=${run.status}／出力「${run.stdout}」`);
  assert.match(run.stdout, /NG/);
});
