/**
 * 品質ゲートのつなぎ目のテスト。
 *
 * 検査そのものは正本（GIGAyama.github.io/standards/lib/giga-v5-checks.mjs）の
 * 写しが受け持ち、そのテスト99件は正本と同じ場所にある。ここで見るのは、
 * このリポジトリが自分で持っている2つだけである。
 *
 *   ① 設定の読み方と報告の形の変換（scripts/lib/giga-part1.mjs）
 *   ② 自己確認の仕掛けそのもの（scripts/lib/self-test.mjs）
 *
 * ⚠️ ②を試すのがいちばん大事である。自己確認が「壊れているのに合格」と
 *    言うようになったら、その先の 33 件はぜんぶ嘘になる。
 *    実際の検査が「0件でした」で信用できないのと同じ理由で、
 *    自己確認も「33/33 でした」だけでは信用できない。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { gigaIssuesOf, standardConfigOf } from '../scripts/lib/giga-part1.mjs';
import { BREAKS, selfTest } from '../scripts/lib/self-test.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 何も出さない、静かな console.log にすげ替えて走らせる */
function quietly(fn) {
    const log = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
    }
}

/* ── ① 設定の読み方と、報告の形 ───────────────────────── */

test('設定は quality.config.json の standard から読む', () => {
    const cfg = standardConfigOf(ROOT);
    assert.equal(cfg.repoName, 'xxx_automatic');
    assert.equal(cfg.entryHtml, 'docs/index.html');
    // このリポジトリは道具を scripts/ にまとめている。
    // ここが tools/ のままだと、版を正しく自動生成しているのに落ちる。
    assert.equal(cfg.swBuilder, 'scripts/build-sw.mjs');
});

test('設定はいま見ている木から読む（外側の値を持ちこまない）', () => {
    // ⚠️ ここが外側の定数だと、--self-test が写しの設定を壊しても効かず、
    //    「壊したのに落ちない」検査ができてしまう（100マス計算で実際に起きた）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-cfg-'));
    fs.writeFileSync(path.join(dir, 'quality.config.json'),
        JSON.stringify({ standard: { repoName: 'ちがうリポジトリ' } }));
    assert.equal(standardConfigOf(dir).repoName, 'ちがうリポジトリ');
});

test('落ちた検査だけを、error / warning に読みかえて返す', () => {
    const issues = gigaIssuesOf(ROOT);
    // いまの木は通っているはずなので、報告は空になる
    assert.deepEqual(issues, []);
    // 形そのものは、壊した木で確かめる
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-map-'));
    fs.cpSync(ROOT, dir, { recursive: true, filter: (s) => !/node_modules|\.git$|\.git\//.test(s) });
    fs.rmSync(path.join(dir, 'LICENSE'));
    const found = gigaIssuesOf(dir).find((i) => i.code === 'A_LICENSE');
    assert.equal(found.severity, 'error');
    assert.equal(found.file, 'docs/index.html');
    assert.equal(typeof found.message, 'string');
});

/* ── ② 自己確認の仕掛けそのもの ───────────────────────── */

/**
 * 「壊した木では、狙った検査がちゃんと落ちる」ふりをする検査器。
 * どの木を渡されても、いま試している壊しかたの id を落ちたことにして返す。
 * これを渡すと selfTest は本来 33/33 で合格する。
 *
 * ⚠️ この「合格するはずの土台」がないと、下のテストは何を壊しても false に
 *    なってしまい、素通りする。実際、はじめに書いたときは 3 通りの変異の
 *    うち 2 通りを取りこぼしていた（どちらも false のままだったため）。
 */
function pretendPerfect() {
    let index = -1;                       // 1回目はもとの状態の確認（0件）
    return () => (index < 0 ? (index += 1, []) : [{ code: BREAKS[index++].id, message: '' }]);
}

test('ふりをする検査器なら合格と言う（このあとの土台）', () => {
    assert.equal(quietly(() => selfTest(ROOT, pretendPerfect())), true);
});

test('壊しかたが当たらなければ、合格と言わない', () => {
    // 対象の文字列が無い＝「確かめたつもり」がいちばん危ない。
    // ⚠️ 検査器の側は「落ちた」と言ってくる。それでも赤にすること。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-miss-'));
    fs.cpSync(ROOT, dir, { recursive: true, filter: (s2) => !/node_modules|\.git$|\.git\//.test(s2) });
    // LICENSE を空にすると、A_LICENSE 以外の「置きかえ」がすべて当たらなくなる…
    // のではなく、狙いを絞って B_CSP の対象文字列だけを消す。
    const html = path.join(dir, 'docs/index.html');
    fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace("script-src 'self';", "script-src 'none';"));
    assert.equal(quietly(() => selfTest(dir, pretendPerfect())), false);
});

test('もとの状態で落ちている検査があれば、そこで止まる', () => {
    // 壊す前から落ちていると、何を確かめたのか分からなくなる。
    //
    // ⚠️ 1回目だけ落ちたことにして、2回目からは「壊したらちゃんと落ちる」に
    //    戻る検査器を渡す。止まる仕掛けが無いと、そのまま 33/33 で合格と
    //    言ってしまう。ここを pretendPerfect() の入れ子で書くと、あちらが
    //    1回目を「もとの状態」として使ってしまい、番号が1つずれて結局
    //    false になる。そうすると、止める仕掛けを外しても気づけない
    //    （実際そう書いていて、変異を1つ取りこぼした）。
    let call = 0;
    const ok = quietly(() => selfTest(ROOT, () => {
        if (call === 0) { call += 1; return [{ code: 'X', message: 'もとから落ちている' }]; }
        return [{ code: BREAKS[call++ - 1].id, message: '' }];
    }));
    assert.equal(ok, false);
});

test('壊しても落ちない検査が1件でもあれば、合格と言わない', () => {
    // 33 件のうち1件だけ「何も出ない」を返す。残り32件は落ちる。
    const perfect = pretendPerfect();
    let seen = 0;
    const ok = quietly(() => selfTest(ROOT, (root) => {
        const out = perfect(root);
        seen += 1;
        return seen === 5 ? [] : out;   // 5回目だけ、壊したのに何も出ない
    }));
    assert.equal(ok, false);
});

test('壊しかたの一覧に、同じ検査を2度以上ねらうものがあってよい', () => {
    // D_VIEWPORT は「viewport-fit が無い」と「拡大を禁止している」の
    // 2通りで落ちる。1通りだけ確かめて済ませないよう、両方を並べてある。
    const viewport = BREAKS.filter((b) => b.id === 'D_VIEWPORT');
    assert.equal(viewport.length, 2);
});

test('壊しかたの一覧が指すファイルは、すべて実在する', () => {
    // 綴りをまちがえると readFileSync が投げ、その1件だけが静かに消える。
    for (const brk of BREAKS) {
        for (const rel of brk.files ?? [brk.file]) {
            assert.ok(fs.existsSync(path.join(ROOT, rel)), `${brk.id}: ${rel} がありません`);
        }
    }
});
