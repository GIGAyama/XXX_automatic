/**
 * PNG の検査そのものが正しく効いているかを確かめる。
 *
 * このリポジトリの流儀に従って、わざと壊したものを食わせて落ちることを見る。
 * 「真っ白を見つけられます」と言いながら何も見ていない検査は、無いより悪い。
 *
 * テスト用の PNG は node:zlib だけで自前で組み立てる（依存を増やさない）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { colorStats, inspectCard, readHeader } from '../scripts/lib/png.mjs';

/** RGB の PNG を作る。pixelAt(x, y) が [r, g, b] を返す。 */
function makePng(width, height, pixelAt) {
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0; // フィルタ種別 0（そのまま）
        for (let x = 0; x < width; x += 1) {
            const [r, g, b] = pixelAt(x, y);
            const at = y * (stride + 1) + 1 + x * 3;
            raw[at] = r;
            raw[at + 1] = g;
            raw[at + 2] = b;
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type 2 = RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0; // interlace なし

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const WHITE = makePng(40, 40, () => [255, 255, 255]);
const GRADIENT = makePng(40, 40, (x, y) => [x * 6, y * 6, 128]);

test('ヘッダから幅と高さを読める', () => {
    const header = readHeader(GRADIENT);
    assert.equal(header.width, 40);
    assert.equal(header.height, 40);
    assert.equal(header.bitDepth, 8);
    assert.equal(header.colorType, 2);
});

test('PNG でないものは null を返す', () => {
    assert.equal(readHeader(Buffer.from('これは PNG ではありません')), null);
    assert.equal(readHeader(Buffer.alloc(0)), null);
    assert.equal(readHeader('文字列'), null);
});

test('真っ白な画像を「ほぼ単色」と判定する', () => {
    const result = inspectCard(WHITE);
    assert.equal(result.blank, true);
    assert.match(result.reason, /ほぼ単色/);
});

test('ふつうのカード（グラデーション）は単色と判定しない', () => {
    // ここが落ちるようだと、正しく撮れた画像まで撮りなおしになる。
    assert.equal(inspectCard(GRADIENT).blank, false);
});

test('ほとんど単色だが1点だけ違う画像も、単色として捕まえる', () => {
    // ゴミが1画素乗っただけで見逃すようでは、検査の意味がない。
    const almost = makePng(40, 40, (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [255, 255, 255]));
    assert.equal(inspectCard(almost).blank, true);
});

test('大きさが違うものは理由つきで報告する', () => {
    const result = inspectCard(GRADIENT, { expect: { width: 1200, height: 675 } });
    assert.equal(result.blank, false);
    assert.match(result.reason, /大きさが違います/);
});

test('大きさが合っていれば理由は出ない', () => {
    const sized = makePng(12, 6, (x, y) => [x * 20, y * 40, 90]);
    const result = inspectCard(sized, { expect: { width: 12, height: 6 } });
    assert.equal(result.reason, null);
});

test('色の統計が取れる', () => {
    const stats = colorStats(GRADIENT);
    assert.ok(stats.uniqueColors > 100);
    assert.ok(stats.topRatio < 0.1);

    const white = colorStats(WHITE);
    assert.equal(white.uniqueColors, 1);
    assert.equal(white.topRatio, 1);
});

test('壊れた PNG でも例外を投げずに諦める', () => {
    // 撮影が止まるほうが、判定できないことよりずっと困る。
    const broken = Buffer.concat([GRADIENT.subarray(0, 40), Buffer.from('ごみ')]);
    assert.doesNotThrow(() => colorStats(broken));
    assert.doesNotThrow(() => inspectCard(broken));
});
