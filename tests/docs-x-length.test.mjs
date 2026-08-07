/**
 * ブラウザ側の文字数計算が、生成側の判定とずれていないことを確かめる。
 *
 * 本文をその場で直せるようにした以上、画面の「268/280」と
 * X の実際の判定が食い違うと、直した意味が無くなる。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { weightedLength as server } from '../scripts/lib/x-text.mjs';
import { MAX_WEIGHTED_LENGTH, URL_WEIGHT, weightedLength as client } from '../docs/lib/x-length.js';

const SAMPLES = [
    '',
    'abc',
    'こんにちは',
    '漢字とひらがなとカタカナ',
    'https://gigayama.github.io/KANJI_Town/',
    '本文です。\n\nhttps://gigayama.github.io/Typa/\n\n#小学校 #GIGA',
    'URL が2本 https://example.com/a https://example.com/b あります',
    '絵文字も数える 🧩📐',
    'ﾊﾝｶｸｶﾅ と全角カナ',
    '記号 ！？「」（）〜・',
    'a'.repeat(279),
    'あ'.repeat(139),
];

test('生成側と同じ長さを返す', () => {
    for (const text of SAMPLES) {
        assert.equal(client(text), server(text), JSON.stringify(text));
    }
});

test('日本語は1文字2カウント', () => {
    assert.equal(client('あ'), 2);
    assert.equal(client('あい'), 4);
});

test('URL は長さに関係なく23カウント', () => {
    assert.equal(client('https://a.io/x'), URL_WEIGHT);
    assert.equal(client(`https://example.com/${'y'.repeat(200)}`), URL_WEIGHT);
});

test('空文字と null は 0', () => {
    assert.equal(client(''), 0);
    assert.equal(client(null), 0);
    assert.equal(client(undefined), 0);
});

test('上限は生成側の既定と同じ 280', () => {
    assert.equal(MAX_WEIGHTED_LENGTH, 280);
});

test('日本語140字がちょうど上限になる', () => {
    assert.equal(client('あ'.repeat(140)), MAX_WEIGHTED_LENGTH);
    assert.ok(client('あ'.repeat(141)) > MAX_WEIGHTED_LENGTH);
});
