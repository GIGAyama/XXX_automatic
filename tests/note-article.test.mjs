/**
 * リポジトリに用意された note 記事の読み取り。
 *
 * 材料は実例そのもの（tests/fixtures/qalc-note-article.md）にしてある。
 * 自分で作った都合のよい文字列だけで確かめると、実際の記事の書き方が変わったときに
 * 「テストは通るのにランチャーには何も出ない」という壊れ方をする。
 *
 * ⚠️ 通ることだけを確かめない。
 *    候補にしてはいけないもの（入稿メモ）が落ちること、
 *    無い画像を指したときに気づけることまで見る。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    MIN_ARTICLE_CHARS,
    assetPathsFor,
    isNoteArticlePath,
    parseArticle,
    pickArticlePaths,
} from '../scripts/lib/note-article.mjs';

const ARTICLE_PATH = 'docs/note/qalc-note-article.md';
const markdown = fs.readFileSync(new URL('./fixtures/qalc-note-article.md', import.meta.url), 'utf8');

/** 実例の記事が指している画像を、リポジトリにあるものとして並べる。 */
const assetPaths = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((hit) => `docs/note/${hit[1]}`);

/* ── どのファイルを記事として拾うか ───────────────── */

test('note/ の下の Markdown を記事として拾う', () => {
    assert.equal(isNoteArticlePath('docs/note/kanji-town-note-article.md'), true);
    assert.equal(isNoteArticlePath('note/article.md'), true);
    // 置き場が違っても、名前で分かるものは拾う
    assert.equal(isNoteArticlePath('docs/qalc-note-article.md'), true);
});

test('入稿メモ・関係のない Markdown は拾わない', () => {
    // note/ の下にあっても README は本文ではない（貼る手順が書いてある側）
    assert.equal(isNoteArticlePath('docs/note/README.md'), false);
    assert.equal(isNoteArticlePath('README.md'), false);
    assert.equal(isNoteArticlePath('docs/stroke-grading.md'), false);
    assert.equal(isNoteArticlePath('docs/note/images/01-home.png'), false);
});

test('1つのリポジトリに何本あってもパスの順で並ぶ（tree の返す順に頼らない）', () => {
    const entries = [
        { path: 'docs/note/02-second.md', type: 'blob' },
        { path: 'docs/note/README.md', type: 'blob' },
        { path: 'docs/note/01-first.md', type: 'blob' },
        { path: 'docs/note', type: 'tree' },
    ];
    assert.deepEqual(pickArticlePaths(entries), ['docs/note/01-first.md', 'docs/note/02-second.md']);
});

test('記事と同じ場所にある画像だけを控える', () => {
    const entries = [
        { path: 'docs/note/images/01-home.png', type: 'blob' },
        { path: 'docs/note/images/02-drill.png', type: 'blob' },
        { path: 'docs/note/qalc-note-article.md', type: 'blob' },
        { path: 'docs/icons/icon-192.png', type: 'blob' },
        { path: 'src/assets/logo.png', type: 'blob' },
    ];
    assert.deepEqual(assetPathsFor(entries, 'docs/note/qalc-note-article.md'), [
        'docs/note/images/01-home.png',
        'docs/note/images/02-drill.png',
    ]);
});

/* ── 記事を分解する ─────────────────────────────── */

test('実例の記事から、タイトル・本文・画像・タグを取り出せる', () => {
    const article = parseArticle(markdown, { path: ARTICLE_PATH, assetPaths });

    assert.match(article.title, /^教室で使えるかもしれないもの作り/);
    assert.ok(article.charCount > MIN_ARTICLE_CHARS, `本文が短すぎます（${article.charCount}字）`);
    assert.equal(article.images.length, assetPaths.length);
    assert.deepEqual(article.problems, []);

    // タグは末尾のハッシュタグ行から。# は落として渡す（画面で付けなおす）
    assert.ok(article.tags.includes('GIGAスクール'));
    assert.ok(!article.tags.some((tag) => tag.startsWith('#')));
});

test('画像は本文に出てくる順に番号がつき、相対指定が repo のパスに解ける', () => {
    const { images } = parseArticle(markdown, { path: ARTICLE_PATH, assetPaths });

    assert.equal(images[0].n, 1);
    assert.equal(images[0].path, 'docs/note/images/01-home.png');
    assert.equal(images[0].label, 'Qalcのホーム画面');
    // 画像のすぐ下の一文は、note のキャプション欄に移すもの
    assert.match(images[0].caption, /^トップページ。/);
    assert.equal(images[0].missing, false);
    assert.equal(images[0].external, false);
});

test('貼り付ける本文には Markdown の記号が残らず、画像は番号つきの目印になる', () => {
    const { plain } = parseArticle(markdown, { path: ARTICLE_PATH, assetPaths });

    assert.ok(!plain.includes('## '), 'note は ## をそのまま文字として表示してしまう');
    assert.ok(!plain.includes('!['), '画像の記法は貼り付け先で意味を持たない');
    assert.ok(plain.includes('［画像1: Qalcのホーム画面］'));
    assert.ok(plain.includes('🏫 はじめに'), '見出しの絵文字は目印なので残す');
    // 画像の下の一文は本文にも残す。ここを消すと、見立てを外したときに段落が1つ消える
    assert.ok(plain.includes('トップページ。レベルと称号'));
});

test('画像の説明が無くてもファイル名から見出しを作る', () => {
    const article = parseArticle(['# だいたい', '', '## 見出し', '', '![](images/03-drill-select.png)'].join('\n'), {
        path: 'docs/note/a.md',
    });
    assert.equal(article.images[0].label, 'drill select');
});

/* ── そのまま出すと困るところ ───────────────────── */

test('本文が指している画像がリポジトリに無ければ気づける', () => {
    const article = parseArticle(markdown, {
        path: ARTICLE_PATH,
        assetPaths: assetPaths.slice(1), // 1点だけ消えた状態を作る
    });

    assert.equal(article.images[0].missing, true);
    assert.ok(article.problems.some((p) => p.includes('リポジトリにありません')));
    // ⚠️ 欠けていても記事そのものは捨てない（本人が直すか、その画像を飛ばすかを決める）
    assert.ok(article.charCount > MIN_ARTICLE_CHARS);
});

test('よそのアドレスを指した画像は、渡せないものとして報告する', () => {
    const article = parseArticle(
        ['# だいたい', '', '## 見出し', '', '![外](https://example.com/a.png)'].join('\n'),
        { path: 'docs/note/a.md' }
    );
    assert.equal(article.images[0].external, true);
    assert.ok(article.problems.some((p) => p.includes('よそのアドレス')));
});

test('入稿メモのような短い文書は、記事として足りないと分かる', () => {
    const memo = ['# note 記事の入稿メモ', '', '本文は別のファイルにあります。'].join('\n');
    const article = parseArticle(memo, { path: 'docs/note/README.md' });

    assert.ok(article.problems.some((p) => p.includes('字しかありません')));
    assert.ok(article.problems.some((p) => p.includes('見出し')));
});

test('タイトルが無ければ言う（note のタイトル欄に貼るものが決まらない）', () => {
    const article = parseArticle(['## いきなり見出し', '', 'ほんぶん'].join('\n'), { path: 'docs/note/a.md' });
    assert.equal(article.title, '');
    assert.ok(article.problems.some((p) => p.includes('タイトル')));
});

test('本文の途中にハッシュタグの語が出てきても、タグとして拾わない', () => {
    const article = parseArticle(
        ['# だいたい', '', '## 見出し', '', '#GIGAスクール のことを書きました。', '', 'おわり。'].join('\n'),
        { path: 'docs/note/a.md' }
    );
    assert.deepEqual(article.tags, []);
});
