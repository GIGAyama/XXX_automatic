/**
 * API キーの確認と、失敗の出し方のテスト。
 *
 * ここが効いていないと、キーの登録忘れが「投稿が作れない」という
 * まったく別の症状になって現れる。実際に一度そうなった:
 *   キー未登録 → 53リポジトリぶん失敗を繰り返す → 「完了 0 件」と表示
 *   → 次の工程が「プロフィールが空です」で落ちる
 * 本当の原因がどこにも見えない状態だったので、テストで固定しておく。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeApiError, requireApiKey } from '../scripts/lib/gemini.mjs';

function withEnv(value, fn) {
    const saved = process.env.GEMINI_API_KEY;
    if (value === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = value;
    try {
        return fn();
    } finally {
        if (saved === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = saved;
    }
}

test('キーが無ければ投げる', () => {
    withEnv(undefined, () => {
        assert.throws(() => requireApiKey(), /GEMINI_API_KEY が設定されていません/);
    });
});

test('空文字も「無い」として扱う', () => {
    // GitHub Actions は未登録のシークレットを空文字で渡してくる。
    // ここを通してしまうと、キーが無いまま API を叩きにいって
    // リポジトリの数だけ 400 が並ぶことになる。
    withEnv('', () => {
        assert.throws(() => requireApiKey(), /GEMINI_API_KEY が設定されていません/);
    });
});

test('エラーには取得先と登録手順が入っている', () => {
    withEnv(undefined, () => {
        try {
            requireApiKey();
            assert.fail('投げるはずが投げませんでした');
        } catch (error) {
            assert.match(error.message, /aistudio\.google\.com\/apikey/, 'キーの取得先');
            assert.match(error.message, /Secrets and variables/, 'GitHub への登録手順');
        }
    });
});

test('設定ミスには userFacing が立つ（スタックトレースを出さないため）', () => {
    withEnv(undefined, () => {
        try {
            requireApiKey();
            assert.fail('投げるはずが投げませんでした');
        } catch (error) {
            assert.equal(error.userFacing, true);
        }
    });
});

test('キーがあれば、その値を返す', () => {
    withEnv('test-key-123', () => {
        assert.equal(requireApiKey(), 'test-key-123');
    });
});

/* ── API エラーの読める化 ──────────────────────────
 * Google のエラーは整形済み JSON（複数行）で返る。
 * ここを1行に畳んでおかないと、呼び出し側がログを1行にまとめた時点で
 * 「Gemini API 400: {」だけが残り、理由が消える。実際にそうなった。 */

test('整形済みJSONのエラーから message を1行で取り出す', () => {
    const body = JSON.stringify(
        { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
        null,
        2
    );
    const out = describeApiError(400, body);
    const head = out.split('\n')[0];

    assert.match(head, /INVALID_ARGUMENT/);
    assert.match(head, /API key not valid/);
    assert.ok(!head.endsWith('{'), `1行目が「{」で終わっています: ${head}`);
});

test('キーが不正なら貼りなおし先まで案内する', () => {
    const body = JSON.stringify({ error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } });
    assert.match(describeApiError(400, body), /GEMINI_API_KEY/);
});

test('モデル名が違うなら設定ファイルの場所を案内する', () => {
    const body = JSON.stringify({ error: { message: 'models/foo is not found', status: 'NOT_FOUND' } });
    assert.match(describeApiError(404, body), /config\/accounts\.json/);
});

test('権限エラーなら API の有効化を案内する', () => {
    const body = JSON.stringify({ error: { message: 'disabled', status: 'PERMISSION_DENIED' } });
    assert.match(describeApiError(403, body), /Generative Language API/);
});

test('JSON でない応答でも1行に畳む', () => {
    const out = describeApiError(400, '<html>\n<body>\nBad Request\n</body>\n</html>');
    assert.ok(!out.split('\n')[0].includes('\n'));
    assert.match(out, /Bad Request/);
});
