import test from 'node:test';
import assert from 'node:assert/strict';
import { lintManual, SECTIONS } from './lint-manual.mjs';

/** 通るマニュアルの最小形。ここを土台に 1 か所ずつ壊して試す。 */
const OK = `# たしかめアプリ の つかいかた

## はじめに

かけ算の練習ができるアプリです。

## さいしょに

準備は要りません。開いたらすぐ使えます。

## 画面の見かた

![ホーム画面](images/01-home.png)

まんなかに問題が出ます。

## できること

### 練習をはじめる

1 問ずつ出てくる問題に答えられます。

1. 「はじめる」を おします。
2. 答えを えらびます。

![練習の画面](images/02-play.png)

### 記録を見る

これまでの記録を見られます。

## こまったとき

### 画面が真っ白のまま

いちど閉じて、開き直してください。
`;

const errorsOf = (md) => lintManual(md).filter((f) => f.level === 'error').map((f) => f.message);
const warnsOf = (md) => lintManual(md).filter((f) => f.level === 'warn').map((f) => f.message);

test('ふつうのマニュアルは通る', () => {
  assert.deepEqual(errorsOf(OK), []);
  assert.deepEqual(warnsOf(OK), []);
});

test('題が無い / 2 本ある', () => {
  assert.match(errorsOf(OK.replace('# たしかめアプリ の つかいかた', '## はじめの題')).join(), /題（# ではじまる行）が無い/);
  assert.match(errorsOf(OK + '\n# もう 1 本\n').join(), /# は 1 本だけ/);
});

test('## が足りないと落ちる（空でも節ごと消させない）', () => {
  const md = OK.replace('## さいしょに\n\n準備は要りません。開いたらすぐ使えます。\n\n', '');
  assert.match(errorsOf(md).join(), /## が足りない → さいしょに/);
});

test('知らない ## を増やせない', () => {
  const md = OK.replace('## こまったとき', '## わたしの考え\n\nあれこれ。\n\n## こまったとき');
  assert.match(errorsOf(md).join(), /知らない ## 「わたしの考え」/);
});

test('## の並びが違うと落ちる（目次と索引がこの順を前提にしている）', () => {
  const md = `# あ の つかいかた

## はじめに
あ

## 画面の見かた
![絵](images/01-a.png)

## さいしょに
い

## できること
### やる
1. おす

## こまったとき
### こまる
なおす
`;
  assert.match(errorsOf(md).join(), /## の並びが違う/);
});

test('機械が足す節を手で書かせない', () => {
  for (const bad of ['学校で使うときは', '変わったこと']) {
    const md = OK.replace('## こまったとき', `## ${bad}\n\nあれこれ。\n\n## こまったとき`);
    /* 知らない ## ではなく、理由のある専用の言い方で落ちること */
    assert.match(errorsOf(md).join(), new RegExp(`「${bad}」は書かない`));
    assert.match(errorsOf(md).join(), /filtering/);
  }
});

test('「できること」が空のマニュアルは公開しない', () => {
  const md = OK.replace(/### 練習をはじめる[\s\S]*?### 記録を見る\n\nこれまでの記録を見られます。\n/,
                        'いろいろできます。\n');
  assert.match(errorsOf(md).join(), /「できること」の中に ### が 1 つも無い/);
});

test('画面写真が 1 枚も無いと落ちる', () => {
  const md = OK.replace(/^!\[.*$/gm, '');
  assert.match(errorsOf(md).join(), /画面写真が 1 枚も無い/);
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

test('番号つき手順の途中に画像を置くと落ちる（そこで番号が 1 に戻る）', () => {
  const md = OK.replace('2. 答えを えらびます。',
    '2. 答えを えらびます。\n\n![とちゅう](images/03-mid.png)\n\n3. つぎへ。');
  assert.match(errorsOf(md).join(), /番号つき手順の途中に画像を置かない/);
});

test('キャプションのつもりで少し長すぎるものは警告', () => {
  const md = OK.replace('まんなかに問題が出ます。', 'あ'.repeat(130));
  assert.match(warnsOf(md).join(), /ふつうの本文になる/);
});

test('画像のあとのふつうの本文には文句を言わない（警告を薄めない）', () => {
  /* 240 字を超えれば、もうキャプションのつもりではない */
  const md = OK.replace('まんなかに問題が出ます。', 'あ'.repeat(300));
  assert.deepEqual(warnsOf(md), []);
  /* 手順や次の見出しが続くのも、ふつうのこと */
  assert.deepEqual(warnsOf(OK.replace('まんなかに問題が出ます。', '1. つぎに おします。')), []);
});

test('組み立てが扱わない書き方', () => {
  assert.match(errorsOf(OK.replace('あ', 'あ') + '\n| a | b |\n').join(), /表は組み立てが扱わない/);
  assert.match(errorsOf(OK + '\n---\n').join(), /水平線/);
  assert.match(warnsOf(OK.replace('1 問ずつ', '**1 問ずつ**')).join(), /太字は使わない/);
});

test('囲みの中は本文として見ない（手順の例を書けるように）', () => {
  const md = OK + '\n```\n| これは表ではない |\n---\n**太字でもない**\n```\n';
  assert.deepEqual(errorsOf(md), []);
  assert.deepEqual(warnsOf(md), []);
});

test('節の名前は 1 か所で決まっている', () => {
  /* references/format.md とずれないよう、正本は SECTIONS ただ 1 つ */
  assert.deepEqual(SECTIONS, ['はじめに', 'さいしょに', '画面の見かた', 'できること', 'こまったとき']);
});
