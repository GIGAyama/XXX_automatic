/**
 * ランチャーが読む「用意された記事」の形。
 *
 * ここは画面が外の文字列（アプリのリポジトリ名・リポジトリに置かれた文章）に触れる場所である。
 * だから確かめるのは2つ。
 *   ・正しいものが通ること
 *   ・パスを組む文字列と、画像の行き先が、決めた形の外に出られないこと
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ARTICLE_SCHEMA_ID,
    articlePathOf,
    markerFor,
    toIndexEntry,
    validateArticle,
} from '../docs/lib/note-doc.js';

const RAW = 'https://raw.githubusercontent.com/GIGAyama/KANJI_Town/f5bb5e5/docs/note/images/01-home.png';

function sample(patch = {}) {
    return {
        schema: ARTICLE_SCHEMA_ID,
        id: 'KANJI_Town',
        repo: 'KANJI_Town',
        title: 'タイトル',
        plain: '本文です。\n\n［画像1: トップページ］',
        charCount: 20,
        tags: ['#GIGAスクール'],
        images: [{ n: 1, path: 'docs/note/images/01-home.png', src: RAW, label: 'トップページ', caption: '説明' }],
        imagesInText: 1,
        problems: [],
        styleWarnings: [],
        ...patch,
    };
}

/* ── ファイル名になる id ───────────────────────── */

test('id から記事の場所が決まる', () => {
    assert.equal(articlePathOf('KANJI_Town'), 'note-articles/KANJI_Town.json');
    // 同じリポジトリに2本目があるときの枝番
    assert.equal(articlePathOf('KANJI_Town--2'), 'note-articles/KANJI_Town--2.json');
});

test('パスを外れる id は受けつけない（外から来た文字列でパスを組む場所だから）', () => {
    for (const bad of ['../secret', 'a/b', '.hidden', '', 'a b', 'かんじ/../..']) {
        assert.throws(() => articlePathOf(bad), /形が違います/, `通ってはいけない id: ${bad}`);
    }
});

/* ── 記事の形 ─────────────────────────────── */

test('正しい記事は通り、画面が読む形にそろう', () => {
    const { ok, article } = validateArticle(sample(), { id: 'KANJI_Town' });
    assert.equal(ok, true);
    assert.equal(article.images.length, 1);
    // タグの # は落として渡す（画面で付けなおす）
    assert.deepEqual(article.tags, ['GIGAスクール']);
});

test('schema が違う・別の記事・本文が無いものは通さない', () => {
    assert.equal(validateArticle(sample({ schema: 'other' })).ok, false);
    assert.equal(validateArticle(sample(), { id: 'Qalc' }).ok, false);
    assert.equal(validateArticle(sample({ plain: '   ' })).ok, false);
    assert.equal(validateArticle(sample({ title: '' })).ok, false);
    assert.equal(validateArticle(null).ok, false);
    assert.equal(validateArticle('文字列').ok, false);
});

test('よその場所を指した画像は並べない（押しても何も起きないボタンを作らない）', () => {
    const { article } = validateArticle(
        sample({
            images: [
                { n: 1, src: 'https://example.com/a.png', label: 'よそ' },
                { n: 2, src: 'media/KANJI_Town-card.png', label: '相対' },
                { n: 3, src: RAW, label: '正しい' },
            ],
            imagesInText: 3,
        })
    );

    assert.deepEqual(article.images.map((i) => i.label), ['正しい']);
    // 減ったことを画面で言えるように、本文にあった数は残す
    assert.equal(article.imagesInText, 3);
});

test('本文の目印と、画像に出す見出しがそろっている', () => {
    const { article } = validateArticle(sample());
    const marker = markerFor(article.images[0]);
    assert.equal(marker, '［画像1: トップページ］');
    assert.ok(article.plain.includes(marker), '本文の目印と画面の表示がずれると、どこに入れるか分からなくなる');
});

/* ── launcher.json に載せる見出し ─────────────── */

test('一覧に載せる見出しには本文を入れない（起動のたびに読むファイルだから）', () => {
    const entry = toIndexEntry(sample());
    assert.deepEqual(Object.keys(entry).sort(), [
        'charCount',
        'id',
        'imageCount',
        'problems',
        'repo',
        'src',
        'styleWarnings',
        'title',
    ]);
    assert.equal(entry.src, 'note-articles/KANJI_Town.json');
    assert.equal(entry.imageCount, 1);
});
