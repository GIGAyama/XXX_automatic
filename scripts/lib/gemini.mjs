/**
 * Gemini API を fetch で直接叩く薄い層。
 *
 * SDK を入れないのは、依存が増えるとバージョン差分で静かに壊れ、
 * 非エンジニアが原因を追えなくなるからである。ここでやることは
 * 「JSON を投げて JSON を受け取る」だけなので、fetch で足りる。
 *
 * 無料枠には 1分あたり・1日あたりのリクエスト数上限がある。
 * 429 が返ったら待って数回だけやり直す。永遠に粘らないのは、
 * GitHub Actions の実行時間を食いつぶしても得るものがないためである。
 */

/**
 * 差し替えられるようにしてあるのは2つの理由から。
 *   ・API キーを使わずに、生成の前後（割り当て・検査・書き出し）を通しで試せるようにするため
 *   ・社内プロキシ経由でしか外に出られない環境でも動かせるようにするため
 * 通常は設定しない。
 */
const ENDPOINT = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 構造化された JSON を生成させる。
 *
 * @param {object} options
 * @param {string} options.model      使うモデル名（config/accounts.json の geminiModel）
 * @param {string} options.prompt     プロンプト本文
 * @param {object} options.schema     期待する JSON の形（Gemini の responseSchema）
 * @param {string} [options.system]   システム指示
 * @param {number} [options.temperature]
 * @returns {Promise<object>} パース済みの JSON
 */
export async function generateJson({ model, prompt, schema, system, temperature = 0.9 }) {
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature,
            responseMimeType: 'application/json',
            responseSchema: schema,
        },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const text = await callGemini(model, body);
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`Gemini の応答が JSON として読めませんでした: ${error.message}\n--- 応答 ---\n${text.slice(0, 800)}`);
    }
}

/** ふつうのテキストを生成させる（note の本文など）。 */
export async function generateText({ model, prompt, system, temperature = 0.9 }) {
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return callGemini(model, body);
}

async function callGemini(model, body) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error(
            'GEMINI_API_KEY が設定されていません。\n' +
                '  ローカル: export GEMINI_API_KEY=... （キーは https://aistudio.google.com/apikey で無料で取れます）\n' +
                '  GitHub:   Settings → Secrets and variables → Actions → New repository secret'
        );
    }

    const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
    const maxAttempts = 4;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify(body),
            });
        } catch (error) {
            // ネットワーク断。待ってやり直す価値がある。
            lastError = error;
            await sleep(backoffMs(attempt));
            continue;
        }

        if (response.ok) {
            const json = await response.json();
            const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
            if (!text.trim()) {
                // 安全フィルタで止められた場合はここに来る。理由を出さないと直しようがない。
                const reason = json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? '不明';
                throw new Error(`Gemini が空の応答を返しました（finishReason: ${reason}）`);
            }
            return text;
        }

        const detail = await response.text().catch(() => '');

        // 429（レート上限）と 5xx（一時的な障害）だけやり直す。
        // 400 や 403 は何度投げても同じなので、すぐ止めて原因を出す。
        if (response.status === 429 || response.status >= 500) {
            lastError = new Error(`Gemini API ${response.status}: ${detail.slice(0, 300)}`);
            if (attempt < maxAttempts) {
                const wait = backoffMs(attempt);
                console.warn(`  ⏳ Gemini ${response.status}。${wait / 1000}秒待ってやり直します（${attempt}/${maxAttempts - 1}）`);
                await sleep(wait);
                continue;
            }
        } else {
            throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 500)}`);
        }
    }

    throw lastError ?? new Error('Gemini API の呼び出しに失敗しました');
}

/** 2秒 → 8秒 → 30秒。無料枠の1分あたり上限は1分待てば必ず開くので、最後は長めに待つ。 */
function backoffMs(attempt) {
    return [2000, 8000, 30000][attempt - 1] ?? 30000;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
