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
import { requireApiKey } from '../scripts/lib/gemini.mjs';

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
