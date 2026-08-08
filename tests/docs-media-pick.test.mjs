/**
 * 投稿に添える画像を選ぶところ（ランチャー側）。
 *
 * ここが崩れると「選んだはずの画像が付かないまま投稿された」という、
 * 出したあとにしか気づけない失敗になる。ブラウザを立てずに確かめられる形にしてある。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_MEDIA,
    defaultSelection,
    fileNameFor,
    galleryOf,
    isAllowedMediaSrc,
    normalizeSelection,
    selectedItems,
    toggleSelection,
} from '../docs/lib/media-pick.js';

const GALLERIES = {
    KANJI_Town: [
        { id: 'card:0', src: 'media/KANJI_Town-card.png', kind: 'card', label: '紹介カード' },
        {
            id: 'repo:docs/note/images/01-home.png',
            src: 'https://raw.githubusercontent.com/GIGAyama/KANJI_Town/abc/docs/note/images/01-home.png',
            kind: 'repo',
            label: 'トップページ',
        },
        {
            id: 'repo:docs/note/images/02-read-aloud.png',
            src: 'https://raw.githubusercontent.com/GIGAyama/KANJI_Town/abc/docs/note/images/02-read-aloud.png',
            kind: 'repo',
            label: '音読の画面',
        },
        {
            id: 'repo:docs/note/images/05-stroke-order.png',
            src: 'https://raw.githubusercontent.com/GIGAyama/KANJI_Town/abc/docs/note/images/05-stroke-order.png',
            kind: 'repo',
            label: '書き順のアニメーション',
        },
        {
            id: 'repo:docs/note/images/10-test-graded.png',
            src: 'https://raw.githubusercontent.com/GIGAyama/KANJI_Town/abc/docs/note/images/10-test-graded.png',
            kind: 'repo',
            label: 'テストの採点',
        },
        {
            id: 'repo:docs/note/images/12-home-after.png',
            src: 'https://raw.githubusercontent.com/GIGAyama/KANJI_Town/abc/docs/note/images/12-home-after.png',
            kind: 'repo',
            label: '学習のあとのトップページ',
        },
    ],
};

const POST = { id: '2026-08-10-morning', repo: 'KANJI_Town', mediaList: ['media/KANJI_Town-card.png'] };
const ids = (items) => items.map((i) => i.id);

test('候補は紹介カードとリポジトリの画像が並ぶ', () => {
    const gallery = galleryOf(POST, GALLERIES);
    assert.equal(gallery.length, 6);
    assert.equal(gallery[0].kind, 'card');
    assert.equal(gallery[1].label, 'トップページ');
});

test('galleries が無い古いデータでも、紹介カードだけで動く', () => {
    // Service Worker が古い app.js を配っている最中に新しい launcher.json を読む、
    // という組み合わせは普通に起きる。そこで画面が空になると原因が分からない。
    const gallery = galleryOf(POST, {});
    assert.deepEqual(ids(gallery), ['card:0']);
    assert.deepEqual(defaultSelection(gallery), ['card:0']);
});

test('既定では紹介カードだけが選ばれている（今までと同じ結果になる）', () => {
    const gallery = galleryOf(POST, GALLERIES);
    assert.deepEqual(normalizeSelection(undefined, gallery), ['card:0']);
});

test('選んだ順にならぶ', () => {
    const gallery = galleryOf(POST, GALLERIES);
    let selected = defaultSelection(gallery);
    selected = toggleSelection(selected, 'repo:docs/note/images/05-stroke-order.png', gallery).selected;
    selected = toggleSelection(selected, 'repo:docs/note/images/01-home.png', gallery).selected;
    assert.deepEqual(
        selectedItems(gallery, selected).map((i) => i.label),
        ['紹介カード', '書き順のアニメーション', 'トップページ']
    );
});

test('もう一度押すと外れる', () => {
    const gallery = galleryOf(POST, GALLERIES);
    const on = toggleSelection(['card:0'], 'repo:docs/note/images/01-home.png', gallery).selected;
    const off = toggleSelection(on, 'repo:docs/note/images/01-home.png', gallery).selected;
    assert.deepEqual(off, ['card:0']);
});

test('5枚目は選べない（X の上限）', () => {
    const gallery = galleryOf(POST, GALLERIES);
    let selected = ['card:0'];
    for (const id of [
        'repo:docs/note/images/01-home.png',
        'repo:docs/note/images/02-read-aloud.png',
        'repo:docs/note/images/05-stroke-order.png',
    ]) {
        selected = toggleSelection(selected, id, gallery).selected;
    }
    assert.equal(selected.length, MAX_MEDIA);

    const result = toggleSelection(selected, 'repo:docs/note/images/10-test-graded.png', gallery);
    assert.equal(result.reason, 'max');
    assert.deepEqual(result.selected, selected, '上限に当たったのに選択が変わっています');
});

test('全部はずした状態は、既定に戻らずそのまま残る', () => {
    // 本文だけで出したいときに、押すたび勝手にカードが戻ると外せなくなる。
    const gallery = galleryOf(POST, GALLERIES);
    assert.deepEqual(normalizeSelection([], gallery), []);
});

test('アプリ側で消された画像は、選択から静かに落ちる', () => {
    const gallery = galleryOf(POST, GALLERIES);
    const saved = ['card:0', 'repo:docs/note/images/99-deleted.png'];
    assert.deepEqual(normalizeSelection(saved, gallery), ['card:0']);
});

test('同じ画像を二重に持っていても1枚として扱う', () => {
    const gallery = galleryOf(POST, GALLERIES);
    assert.deepEqual(normalizeSelection(['card:0', 'card:0'], gallery), ['card:0']);
});

test('端末に残った選択が5枚以上でも4枚に切る', () => {
    const gallery = galleryOf(POST, GALLERIES);
    const saved = gallery.map((i) => i.id); // 6枚
    assert.equal(normalizeSelection(saved, gallery).length, MAX_MEDIA);
});

test('知らない画像は候補にしても選べない', () => {
    const gallery = galleryOf(POST, GALLERIES);
    const result = toggleSelection(['card:0'], 'repo:どこにも無い.png', gallery);
    assert.equal(result.reason, 'unknown');
    assert.deepEqual(result.selected, ['card:0']);
});

test('許可した先の画像しか読みにいかない', () => {
    assert.ok(isAllowedMediaSrc('media/KANJI_Town-card.png'));
    assert.ok(isAllowedMediaSrc('https://raw.githubusercontent.com/GIGAyama/KANJI_Town/abc/docs/x.png'));

    // ここが通ると、launcher.json に何か仕込まれたときに任意の先へ取りにいく。
    assert.ok(!isAllowedMediaSrc('https://example.com/x.png'));
    assert.ok(!isAllowedMediaSrc('http://raw.githubusercontent.com/GIGAyama/x/abc/x.png'));
    assert.ok(!isAllowedMediaSrc('//example.com/x.png'));
    assert.ok(!isAllowedMediaSrc('javascript:alert(1)'));
    assert.ok(!isAllowedMediaSrc('data:image/png;base64,AAAA'));
    assert.ok(!isAllowedMediaSrc(''));
});

test('許可していない先の画像は候補にも出さない', () => {
    const gallery = galleryOf(
        { repo: 'X', mediaList: [] },
        { X: [{ id: 'repo:evil', src: 'https://example.com/x.png', kind: 'repo', label: '罠' }] }
    );
    assert.deepEqual(gallery, []);
});

test('共有するときのファイル名は、元の名前を残す', () => {
    const gallery = galleryOf(POST, GALLERIES);
    assert.equal(fileNameFor('KANJI_Town', gallery[0], 0), 'KANJI_Town-card-1.png');
    assert.equal(fileNameFor('KANJI_Town', gallery[1], 1), 'KANJI_Town-01-home.png');
});
