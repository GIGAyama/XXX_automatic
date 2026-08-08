/**
 * アプリのリポジトリに置いてある画像から、投稿に添えられそうなものを選ぶところ。
 *
 * ここが緩いとアイコンが候補に並び、厳しいと記事用に撮った画像が拾えない。
 * 実際のリポジトリ（KANJI_Town / SchoolPlan_Editor / Shiritori_fighter / Reversi）の
 * 並びをそのまま材料にしてある。作り話で通しても、次に repo が増えたときに意味がない。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    captionSourcePaths,
    compareImagePath,
    isIconLike,
    labelFromPath,
    parseCaptions,
    pickRepoImages,
    rawUrl,
} from '../scripts/lib/repo-images.mjs';

/** SchoolPlan_Editor（週案エディタ）の実際の並び。アイコンが docs/ の下にある。 */
const SCHOOL_PLAN = [
    { path: 'docs/icons/apple-touch-icon.png', size: 5184, type: 'blob' },
    { path: 'docs/icons/icon-192.png', size: 6884, type: 'blob' },
    { path: 'docs/icons/icon-512.png', size: 18383, type: 'blob' },
    { path: 'docs/icons/icon-maskable-512.png', size: 7667, type: 'blob' },
    { path: 'docs/note/images/01-week-plan.png', size: 764340, type: 'blob' },
    { path: 'docs/note/images/02-edit-mode.png', size: 842053, type: 'blob' },
    { path: 'docs/note/images/10-print-page2.png', size: 211854, type: 'blob' },
    { path: 'docs/note/README.md', size: 4000, type: 'blob' },
    { path: 'docs/note/schoolplan-editor-note-article.md', size: 20000, type: 'blob' },
    { path: 'docs/QUALITY_ASSURANCE.md', size: 3000, type: 'blob' },
];

test('記事用に撮った画像だけが候補になる', () => {
    const picked = pickRepoImages(SCHOOL_PLAN).map((i) => i.path);
    assert.deepEqual(picked, [
        'docs/note/images/01-week-plan.png',
        'docs/note/images/02-edit-mode.png',
        'docs/note/images/10-print-page2.png',
    ]);
});

test('アイコンは置き場所が repo ごとに違っても落ちる', () => {
    // 実際にある4通り。docs/icons/・icons/・public/・assets/ に散らばっている。
    assert.ok(isIconLike('docs/icons/icon-512.png'));
    assert.ok(isIconLike('icons/apple-touch-icon.png'));
    assert.ok(isIconLike('public/pwa-192x192.png'));
    assert.ok(isIconLike('assets/icon-master.png'));
    assert.ok(isIconLike('public/favicon.png'));
    assert.ok(!isIconLike('docs/note/images/01-home.png'));
    assert.ok(!isIconLike('docs/screenshot-battle.png'));
});

test('連番のある名前は数の順に並ぶ（01, 02, 10 が 01, 10, 02 にならない）', () => {
    const entries = ['a/10-x.png', 'a/02-y.png', 'a/01-z.png'].map((path) => ({ path, size: 100000 }));
    assert.deepEqual(
        pickRepoImages(entries).map((i) => i.path),
        ['a/01-z.png', 'a/02-y.png', 'a/10-x.png']
    );
    // 連番の無いものは後ろ。
    assert.equal(compareImagePath('a/01-z.png', 'a/zzz.png'), -1);
});

test('小さすぎる画像と大きすぎる画像は候補にしない', () => {
    const entries = [
        { path: 'docs/tiny.png', size: 1200 },
        { path: 'docs/huge.png', size: 9_000_000 },
        { path: 'docs/ok.png', size: 240_000 },
    ];
    assert.deepEqual(
        pickRepoImages(entries).map((i) => i.path),
        ['docs/ok.png']
    );
});

test('大きさが分からないものは落とさない', () => {
    // tree が size を返さないことがある。判定できないことを理由に捨てると、
    // そのとき候補が全部消える。捨てるより出すほうがまし。
    const picked = pickRepoImages([{ path: 'docs/shot.png' }]);
    assert.deepEqual(picked.map((i) => i.path), ['docs/shot.png']);
});

test('上限を超えたぶんは切る', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
        path: `docs/note/images/${String(i + 1).padStart(2, '0')}-x.png`,
        size: 200000,
    }));
    assert.equal(pickRepoImages(entries, { maxPerRepo: 24 }).length, 24);
    assert.equal(pickRepoImages(entries, { maxPerRepo: 4 })[3].path, 'docs/note/images/04-x.png');
});

test('画像でないものは候補にならない', () => {
    const picked = pickRepoImages([
        { path: 'docs/note/README.md', size: 4000 },
        { path: 'App.html', size: 900000 },
        { path: 'docs/note/images/01-home.png', size: 200000 },
    ]);
    assert.deepEqual(picked.map((i) => i.path), ['docs/note/images/01-home.png']);
});

test('説明文を探す Markdown は、画像の近くのものだけ', () => {
    const found = captionSourcePaths(SCHOOL_PLAN, ['docs/note/images/01-week-plan.png'], 3);
    assert.ok(found.includes('docs/note/README.md'));
    assert.ok(found.includes('docs/note/schoolplan-editor-note-article.md'));
    // docs/ 直下の QA 文書まで読みにいくと、repo あたりのリクエストが跳ね上がる。
    assert.ok(!found.includes('docs/QUALITY_ASSURANCE.md'));
});

test('記事の本文から「何の画面か」を拾う', () => {
    const captions = parseCaptions(
        [
            {
                path: 'docs/note/schoolplan-editor-note-article.md',
                text: '![週案の画面](images/01-week-plan.png)\n本文\n![編集モード](images/02-edit-mode.png)',
            },
        ],
        ['docs/note/images/01-week-plan.png', 'docs/note/images/02-edit-mode.png']
    );
    assert.equal(captions.get('docs/note/images/01-week-plan.png'), '週案の画面');
    assert.equal(captions.get('docs/note/images/02-edit-mode.png'), '編集モード');
});

test('README の一覧表からも拾える', () => {
    const captions = parseCaptions(
        [
            {
                path: 'docs/note/README.md',
                text: [
                    '| ファイル | 何の画面か | 本文のどこで使うか |',
                    '|---|---|---|',
                    '| 01-week-plan.png | 週案グリッド全体 | 先頭 |',
                ].join('\n'),
            },
        ],
        ['docs/note/images/01-week-plan.png']
    );
    assert.equal(captions.get('docs/note/images/01-week-plan.png'), '週案グリッド全体');
});

test('書き方の例（![...](images/xx-....png)）を説明文にしない', () => {
    const captions = parseCaptions(
        [{ path: 'docs/note/README.md', text: '本文中の ![...](images/01-home.png) を目印に' }],
        ['docs/note/images/01-home.png']
    );
    assert.equal(captions.has('docs/note/images/01-home.png'), false);
});

test('リポジトリのルートにある README からも拾える（画像が docs/ 直下のとき）', () => {
    // Shiritori_fighter がこの形。README に docs/screenshot-*.png を貼っている。
    const captions = parseCaptions(
        [{ path: 'README.md', text: '![対戦の画面](docs/screenshot-battle.png)' }],
        ['docs/screenshot-battle.png']
    );
    assert.equal(captions.get('docs/screenshot-battle.png'), '対戦の画面');
});

test('説明が無ければファイル名から作る', () => {
    assert.equal(labelFromPath('docs/note/images/01-week-plan.png'), 'week plan');
    assert.equal(labelFromPath('docs/screenshot-battle.png'), 'screenshot battle');
});

test('raw の URL はコミット SHA で固定する', () => {
    assert.equal(
        rawUrl('GIGAyama', 'KANJI_Town', 'abc123', 'docs/note/images/01-home.png'),
        'https://raw.githubusercontent.com/GIGAyama/KANJI_Town/abc123/docs/note/images/01-home.png'
    );
});

test('名前に空白や記号があっても URL が壊れない', () => {
    assert.equal(
        rawUrl('GIGAyama', 'App', 'sha', 'docs/note/images/01 home (1).png'),
        'https://raw.githubusercontent.com/GIGAyama/App/sha/docs/note/images/01%20home%20(1).png'
    );
});
