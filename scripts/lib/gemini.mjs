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

/**
 * API キーがあることを先に確かめる。
 *
 * ⚠️ 各スクリプトは処理の最初にこれを呼ぶこと。
 *
 *   実際に起きた事故: キーが未登録のまま週次ワークフローを回したところ、
 *   53 リポジトリぶん「1件ずつ失敗しては次へ」を繰り返し、
 *   最後に「完了 — 新規/更新 0 件」と出て次の工程へ進んでしまった。
 *   本当の原因（キーが無い）は 53 行のエラーに埋もれて見えず、
 *   画面には無関係な「プロフィールが空です」だけが残った。
 *   1件目を投げる前に、ここで止める。
 */
export function requireApiKey() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        // 設定ミスであってプログラムの異常ではない。スタックトレースを出さないための印。
        throw Object.assign(new Error(
            'GEMINI_API_KEY が設定されていません。\n\n' +
                '  キーは無料で取れます（カード登録も不要）:\n' +
                '    https://aistudio.google.com/apikey\n\n' +
                '  GitHub に登録する場合:\n' +
                '    Settings → Secrets and variables → Actions → New repository secret\n' +
                '    Name に GEMINI_API_KEY、Secret に取得したキーを貼る\n\n' +
                '  手元で動かす場合:\n' +
                '    export GEMINI_API_KEY=...'
        ), { userFacing: true });
    }
    return apiKey;
}

async function callGemini(model, body) {
    const apiKey = requireApiKey();

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
            lastError = new Error(describeApiError(response.status, detail));
            if (attempt < maxAttempts) {
                const wait = backoffMs(attempt);
                console.warn(`  ⏳ Gemini ${response.status}。${wait / 1000}秒待ってやり直します（${attempt}/${maxAttempts - 1}）`);
                await sleep(wait);
                continue;
            }
        } else {
            throw Object.assign(new Error(describeApiError(response.status, detail)), { userFacing: true });
        }
    }

    throw lastError ?? new Error('Gemini API の呼び出しに失敗しました');
}

/**
 * API のエラー応答を、1行で読める形にして原因の見当まで添える。
 *
 * ⚠️ 必ず1行に畳むこと。
 *   Google のエラーは整形済み JSON（複数行）で返る。そのまま扱うと、
 *   呼び出し側がログを1行にまとめた時点で「Gemini API 400: {」だけが残り、
 *   肝心の理由が消える。実際にそうなって原因が分からなくなった。
 */
export function describeApiError(status, detail) {
    let message = String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    let apiStatus = '';

    try {
        const json = JSON.parse(detail);
        if (json?.error?.message) {
            message = String(json.error.message).replace(/\s+/g, ' ').trim();
            apiStatus = json.error.status ?? '';
        }
    } catch {
        // JSON で返らないこともある。その場合は畳んだ生の本文をそのまま使う。
    }

    const head = `Gemini API ${status}${apiStatus ? ` (${apiStatus})` : ''}: ${message}`;
    const hint = hintFor(status, apiStatus, message);
    return hint ? `${head}\n\n${hint}` : head;
}

/** よくある失敗に、次にどこを触ればよいかを添える。 */
function hintFor(status, apiStatus, message) {
    const text = `${apiStatus} ${message}`.toLowerCase();

    if (text.includes('api key not valid') || text.includes('api_key_invalid') || status === 401) {
        return [
            '  → API キーの値が正しくないようです。',
            '     ・Secret に貼るとき、前後の空白や引用符（" や \'）が混ざっていないか',
            '     ・https://aistudio.google.com/apikey で作りなおして貼りかえる',
            '     GitHub: Settings → Secrets and variables → Actions → GEMINI_API_KEY',
        ].join('\n');
    }

    if (text.includes('permission') || status === 403) {
        return [
            '  → キーはあるが、このAPIを使う権限がありません。',
            '     Google Cloud のプロジェクトで作ったキーの場合、',
            '     Generative Language API が有効になっているか確認してください。',
            '     AI Studio（aistudio.google.com/apikey）で作りなおすのが確実です。',
        ].join('\n');
    }

    if (status === 404 || text.includes('not found') || text.includes('is not supported')) {
        return [
            '  → そのモデルは使えません。古い版が止められたときにもここに来ます。',
            '     いま選ばれているモデルは data/gemini-model.json に書いてあります。',
            '     選びなおす:  node scripts/check-gemini.mjs',
            '     何が選べるか: node scripts/check-gemini.mjs --models',
            '     版を固定している場合は config/accounts.json の geminiModel を見なおしてください',
            "     （'auto' にすると、使えるモデルのうちいちばん新しい安定版を自動で選びます）",
        ].join('\n');
    }

    if (status === 429 || text.includes('resource_exhausted') || text.includes('quota')) {
        return [
            '  → 無料枠の上限に当たりました。',
            '     1日の上限なら日付が変わるまで待ちます（太平洋時間の0時に戻ります）。',
            '     急ぐ場合は --limit で件数を分けて実行してください。',
        ].join('\n');
    }

    if (status === 400) {
        return [
            '  → リクエストが受け付けられませんでした。',
            '     キーの値が違う場合もここに来ます。まず GEMINI_API_KEY を貼りなおしてみてください。',
        ].join('\n');
    }

    return '';
}

/** 2秒 → 8秒 → 30秒。無料枠の1分あたり上限は1分待てば必ず開くので、最後は長めに待つ。 */
function backoffMs(attempt) {
    return [2000, 8000, 30000][attempt - 1] ?? 30000;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
