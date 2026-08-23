/**
 * 本命のモデルが混んでいたとき、控えに乗りかえられるか。
 *
 * 2026-08-16 と 08-23、週次が2週続けて落ちた。どちらも同じ形である。
 *
 *   自動選択が「いま使えるいちばん新しい安定版」を掴む
 *   → その版がいちばん混んでいて 503 UNAVAILABLE（high demand）を返しつづける
 *   → 同じ版に3回やり直して、諦めて exit 1
 *
 * 待っても相手が空かない以上、やり直す回数を増やしても抜けられない。
 * 抜け道は「1つ前の版に投げる」しかなく、候補の並びは既に持っていた。
 *
 * ⚠️ ここで大事なのは「乗りかえられる」ことと同じくらい、
 *    「乗りかえてはいけないときに乗りかえない」ことである。
 *    キーが違うのに版を変えながら投げつづければ、同じ 400 が候補の数だけ並び、
 *    本当の理由がその繰り返しに埋もれる。以前それで原因が分からなくなっている。
 *    両方向を確かめる。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { generateText, modelChain, resetModelState, setFallbackModels } from '../scripts/lib/gemini.mjs';

const NEW = 'gemini-3.7-flash'; // 本命（出たばかりで混んでいる版）
const OLD = 'gemini-3.6-flash'; // 控え
const OLDER = 'gemini-2.5-flash'; // 控えの控え。2系なので検索は使えない

/** 「この応答を順に返す」偽の fetch。何番目に何を投げたかも記録する。 */
function fakeFetch(replies) {
    const calls = [];
    const queue = [...replies];
    globalThis.fetch = async (url, init) => {
        const model = decodeURIComponent(String(url).split('/').pop().split(':')[0]);
        calls.push({ model, body: JSON.parse(init.body) });
        const reply = queue.shift() ?? { status: 503 };
        if (reply.status === 200) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ candidates: [{ content: { parts: [{ text: reply.text }] }, finishReason: 'STOP' }] }),
            };
        }
        return { ok: false, status: reply.status, text: async () => JSON.stringify({ error: { message: reply.message ?? 'ng' } }) };
    };
    return calls;
}

/** 応答を無限に返す偽の fetch（全部混んでいる、を作るため）。 */
function alwaysFetch(reply) {
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(decodeURIComponent(String(url).split('/').pop().split(':')[0]));
        return { ok: false, status: reply.status, text: async () => JSON.stringify({ error: { message: reply.message ?? 'ng' } }) };
    };
    return calls;
}

const realFetch = globalThis.fetch;
let savedKey;
let savedWait;

beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    savedWait = process.env.GEMINI_RETRY_WAIT_MS;
    process.env.GEMINI_API_KEY = 'test-key';
    // 待ちを潰す。ここで確かめたいのは待ち時間ではなく、乗りかえの筋道である。
    process.env.GEMINI_RETRY_WAIT_MS = '1';
    resetModelState();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    if (savedWait === undefined) delete process.env.GEMINI_RETRY_WAIT_MS;
    else process.env.GEMINI_RETRY_WAIT_MS = savedWait;
    resetModelState();
});

/* ── 試す順 ────────────────────────────────── */

test('控えが無ければ、本命だけを試す（これまでと同じ動き）', () => {
    assert.deepEqual(modelChain(NEW), [NEW]);
});

test('控えがあれば、本命 → 控えの順になる', () => {
    setFallbackModels([OLD, OLDER]);
    assert.deepEqual(modelChain(NEW), [NEW, OLD, OLDER]);
});

test('本命が控えにも入っていたら、二度は試さない', () => {
    setFallbackModels([NEW, OLD]);
    assert.deepEqual(modelChain(NEW), [NEW, OLD]);
});

test('検索を使う呼び出しでは、検索に対応しない版を切り替え先から外す', () => {
    // 検索と構造化出力の併用は3系から。2系に落とすと 400 になるだけで、
    // 「混雑を避けたつもりが毎回 400」という別の壊れ方に置きかわる。
    setFallbackModels([OLD, OLDER]);
    assert.deepEqual(modelChain(NEW, { search: true }), [NEW, OLD]);
});

/* ── 混んでいたら乗りかえる ────────────────────── */

test('本命が 503 でも、控えで書ければ成功する', async () => {
    setFallbackModels([OLD]);
    const calls = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200, text: 'できました' }]);

    assert.equal(await generateText({ model: NEW, prompt: 'x' }), 'できました');
    assert.deepEqual(
        calls.map((c) => c.model),
        [NEW, NEW, NEW, OLD]
    );
});

test('版が消えていたら（404）、待たずに次の版へ渡す', async () => {
    // 自動選択が古い版を掴んだまま止まる、という壊れ方をここで受け止める。
    setFallbackModels([OLD]);
    const calls = fakeFetch([{ status: 404, message: 'is not found' }, { status: 200, text: 'できました' }]);

    assert.equal(await generateText({ model: NEW, prompt: 'x' }), 'できました');
    assert.deepEqual(
        calls.map((c) => c.model),
        [NEW, OLD],
        '404 は何度投げても同じなので、同じ版にやり直してはいけない'
    );
});

test('一度通った版を覚えて、次の呼び出しはそこから始める', async () => {
    // 週次はプロフィールだけで 38 件投げる。毎回「本命が混んでいること」を
    // 確かめなおすと、確かめるためだけの待ち時間を 38 回払うことになる。
    setFallbackModels([OLD]);
    fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200, text: '1回目' }]);
    await generateText({ model: NEW, prompt: 'x' });

    const calls = fakeFetch([{ status: 200, text: '2回目' }]);
    assert.equal(await generateText({ model: NEW, prompt: 'x' }), '2回目');
    assert.deepEqual(
        calls.map((c) => c.model),
        [OLD],
        '2回目も本命から始めています'
    );
});

test('控えを入れなおしたら、覚えていた版は忘れる', async () => {
    setFallbackModels([OLD]);
    fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200, text: 'ok' }]);
    await generateText({ model: NEW, prompt: 'x' });

    // 週が変わってモデルを選びなおした、という状況。
    setFallbackModels([OLD]);
    const calls = fakeFetch([{ status: 200, text: 'ok' }]);
    await generateText({ model: NEW, prompt: 'x' });
    assert.deepEqual(
        calls.map((c) => c.model),
        [NEW]
    );
});

/* ── 乗りかえてはいけないとき ──────────────────── */

test('キーが違う（400）なら、控えを試さずにそこで止める', async () => {
    setFallbackModels([OLD, OLDER]);
    const calls = fakeFetch([{ status: 400, message: 'API key not valid' }]);

    await assert.rejects(() => generateText({ model: NEW, prompt: 'x' }), /API key not valid/);
    assert.deepEqual(calls.map((c) => c.model), [NEW], '版を変えながら同じ 400 を並べてはいけない');
});

test('権限が無い（403）なら、控えを試さずにそこで止める', async () => {
    setFallbackModels([OLD, OLDER]);
    const calls = fakeFetch([{ status: 403, message: 'permission denied' }]);

    await assert.rejects(() => generateText({ model: NEW, prompt: 'x' }));
    assert.deepEqual(calls.map((c) => c.model), [NEW]);
});

/* ── 全部だめだったとき ────────────────────────── */

test('全部混んでいたら、何を試したかを添えて落ちる', async () => {
    setFallbackModels([OLD, OLDER]);
    const calls = alwaysFetch({ status: 503, message: 'This model is currently experiencing high demand.' });

    await assert.rejects(
        () => generateText({ model: NEW, prompt: 'x' }),
        (error) => {
            // 控えを持たせた以上、「503 でした」だけでは
            // 控えが働いたのか、そもそも並んでいなかったのかが分からない。
            assert.match(error.message, /試したモデル/);
            for (const id of [NEW, OLD, OLDER]) assert.ok(error.message.includes(id), `${id} が出ていません`);
            return true;
        }
    );
    assert.ok(calls.includes(OLDER), '最後の候補まで試していません');
});

test('503 の説明に、キーの問題ではないと書いてある', async () => {
    // 「混んでいる」を「設定を間違えた」と読み違えると、
    // 直しようのないところを触りつづけることになる。
    alwaysFetch({ status: 503, message: 'This model is currently experiencing high demand.' });
    await assert.rejects(
        () => generateText({ model: NEW, prompt: 'x' }),
        /キーや設定の問題ではありません/
    );
});
