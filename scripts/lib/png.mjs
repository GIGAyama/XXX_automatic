/**
 * PNG を最低限だけ読む。依存パッケージは使わない（node:zlib だけ）。
 *
 * なぜ要るのか:
 *   MANUAL に「画像が真っ白／文字が □□□ になる」が既知の症状として書いてあるのに、
 *   それを機械的に確かめる手段が1つも無かった。つまり 52 枚ぜんぶ真っ白でも、
 *   撮影は「成功」として終わる。誰も見ないまま X に出るところまで行ける。
 *
 * sharp や pngjs を入れない理由はこのリポジトリの方針そのもの（実行時依存を増やさない）。
 * ここで要るのは「幅・高さ」と「ほぼ単色か」だけなので、自前で足りる。
 *
 * 対象は Playwright が出す PNG に限る。bit depth 8 / color type 2 か 6 /
 * インターレース無し、が Playwright の出力である。それ以外は「読めなかった」と返す。
 * 無理にデコードして誤判定するより、判定しないほうが安全である。
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG のヘッダ（IHDR）を読む。PNG でなければ null。 */
export function readHeader(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
    if (!buffer.subarray(0, 8).equals(SIGNATURE)) return null;
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
        bitDepth: buffer[24],
        colorType: buffer[25],
        interlace: buffer[28],
    };
}

/** IDAT チャンクをつなげて取り出す。 */
function concatIdat(buffer) {
    const parts = [];
    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + length));
        if (type === 'IEND') break;
        offset += 12 + length; // 長さ(4) + 型(4) + データ + CRC(4)
    }
    return Buffer.concat(parts);
}

/** PNG のフィルタを解いて、ピクセルの生バイト列に戻す。 */
function unfilter(raw, { width, height, bytesPerPixel }) {
    const stride = width * bytesPerPixel;
    const out = Buffer.alloc(stride * height);

    let src = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = raw[src];
        src += 1;
        const line = raw.subarray(src, src + stride);
        src += stride;

        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

        for (let x = 0; x < stride; x += 1) {
            const a = x >= bytesPerPixel ? cur[x - bytesPerPixel] : 0;
            const b = prev ? prev[x] : 0;
            const c = prev && x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
            const v = line[x];

            switch (filter) {
                case 0: cur[x] = v; break;
                case 1: cur[x] = (v + a) & 0xff; break;
                case 2: cur[x] = (v + b) & 0xff; break;
                case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
                case 4: cur[x] = (v + paeth(a, b, c)) & 0xff; break;
                default: throw new Error(`知らないフィルタ種別です: ${filter}`);
            }
        }
    }
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/**
 * 色の散らばりを調べる。
 * @returns {{uniqueColors:number, topRatio:number, sampled:number}|null} 読めなければ null
 */
export function colorStats(buffer, { maxSamples = 40_000 } = {}) {
    const header = readHeader(buffer);
    if (!header) return null;
    // Playwright の出力以外は判定しない。誤判定して撮り直させるほうが害が大きい。
    if (header.bitDepth !== 8 || header.interlace !== 0) return null;
    if (header.colorType !== 2 && header.colorType !== 6) return null;

    const bytesPerPixel = header.colorType === 6 ? 4 : 3;
    let pixels;
    try {
        const raw = zlib.inflateSync(concatIdat(buffer));
        pixels = unfilter(raw, { width: header.width, height: header.height, bytesPerPixel });
    } catch {
        return null;
    }

    const total = header.width * header.height;
    // 1200×675 は 81 万画素。全部数えると遅いので、等間隔に間引いて見る。
    const step = Math.max(1, Math.floor(total / maxSamples));

    const counts = new Map();
    let sampled = 0;
    for (let i = 0; i < total; i += step) {
        const at = i * bytesPerPixel;
        const key = (pixels[at] << 16) | (pixels[at + 1] << 8) | pixels[at + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
        sampled += 1;
    }

    let top = 0;
    for (const n of counts.values()) if (n > top) top = n;

    return { uniqueColors: counts.size, topRatio: sampled === 0 ? 1 : top / sampled, sampled };
}

/**
 * ほぼ単色（＝真っ白、または描画される前を撮ってしまった）か。
 *
 * 紹介カードは背景がグラデーションなので、正常なら色は数百種類になる。
 * 色が3種類以下で、しかも1色が98%以上を占めるなら、中身が無いとみてよい。
 *
 * @returns {{blank:boolean, reason:string|null, stats:object|null}}
 */
export function inspectCard(buffer, { expect = null } = {}) {
    const header = readHeader(buffer);
    if (!header) return { blank: false, reason: 'PNG として読めません', stats: null, header: null };

    if (expect && (header.width !== expect.width || header.height !== expect.height)) {
        return {
            blank: false,
            reason: `大きさが違います（${header.width}×${header.height} / 期待は ${expect.width}×${expect.height}）`,
            stats: null,
            header,
        };
    }

    const stats = colorStats(buffer);
    if (!stats) return { blank: false, reason: null, stats: null, header };

    const blank = stats.uniqueColors <= 3 && stats.topRatio >= 0.98;
    return {
        blank,
        reason: blank ? `ほぼ単色です（色 ${stats.uniqueColors} 種 / 最頻色 ${Math.round(stats.topRatio * 100)}%）` : null,
        stats,
        header,
    };
}
