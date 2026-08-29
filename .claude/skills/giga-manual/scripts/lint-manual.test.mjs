import test from 'node:test';
import assert from 'node:assert/strict';
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
