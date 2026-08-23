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
 * 待ち時間の基準（ミリ秒）。2倍・8倍・30倍して使う。
 *
 * 差し替えられるようにしてあるのは ENDPOINT と同じ理由。
 *   ・待ちを挟まずに、切り替えの筋道そのものを試せるようにするため
 *   ・混雑が長引くときに、待ちを伸ばして粘らせるため
 * 通常は設定しない。
 */
function retryUnitMs() {
    return Number(process.env.GEMINI_RETRY_WAIT_MS) || 1000;
}

/**
 * 本命が混んでいたときに、代わりに投げるモデルの並び（良い順）。
 * scripts/lib/gemini-models.mjs が、モデルを決めたときに入れる。
 *
 * ⚠️ なぜ要るのか（2026-08-16 と 08-23 に週次が2週続けて落ちた）
 *
 *   自動選択は「いま使えるいちばん新しい安定版」を選ぶ。ところが出たばかりの版は
 *   いちばん混んでいる版でもあり、503 UNAVAILABLE（high demand）が返りつづける。
 *   同じモデルに3回やり直すだけでは、待っても相手が空かないので抜けられない。
 *   一方で、1つ前の版はたいてい空いている。候補の並びは既に持っているのだから、
 *   使えないと分かった時点で次へ移る。
 *
 *   「新しい版が止まった日に週次が丸ごと落ちる」を避けるために自動選択を入れたのに、
 *   その自動選択が新しい版を掴んで落ちていた。控えを持たせて初めて筋が通る。
 */
let fallbackModels = [];

/**
 * この実行のなかで、実際に応答が返ってきたモデル。
 *
 * 1回の実行で 38 件のプロフィールを作るような使い方をするので、
 * 本命が混んでいると分かったあとも毎回そこから試すと、
 * 「混雑を確かめるだけの待ち時間」を件数ぶん払うことになる。
 * 一度通ったモデルがあれば、次の呼び出しはそこから始める。
 */
let workingModel = null;

/** 控えの並びを入れる。scripts/lib/gemini-models.mjs から呼ばれる。 */
export function setFallbackModels(models) {
    fallbackModels = (models ?? []).map(String).filter(Boolean);
    workingModel = null;
}

/** テストのために、控えと「通ったモデル」を初期化する。 */
export function resetModelState() {
    fallbackModels = [];
    workingModel = null;
}

/**
 * 実際に試す順を組む。
 *
 * @param {string} model    本命（config か自動選択で決まったもの）
 * @param {object} [options]
 * @param {boolean} [options.search]  検索を使う呼び出しか
 */
export function modelChain(model, { search = false } = {}) {
    const wanted = [];
    // 前の呼び出しで通ったモデルを先頭に。控えに載っているものだけを昇格させる
    // （呼び出し側が別のモデルを名指ししているときに、勝手に差し替えないため）。
    if (workingModel && (workingModel === model || fallbackModels.includes(workingModel))) wanted.push(workingModel);
    wanted.push(model, ...fallbackModels);

    const seen = new Set();
    const chain = wanted.filter((id) => {
        if (!id || seen.has(id)) return false;
        seen.add(id);
        // ⚠️ 検索と構造化出力を同時に使えるのは3系から。2系に落とすと 400 になるだけなので、
        //    切り替え先としてはじめから外す。ここを忘れると、混雑を避けたつもりで
        //    「毎回 400 で落ちる」という別の壊れ方に置きかわる。
        if (search && !supportsSearch(id)) return false;
        return true;
    });

    // 全部落ちることは無いはずだが、空を返すと呼び出し側が理由の無い失敗になる。
    return chain.length > 0 ? chain : [model];
}

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
export async function generateJson({ model, prompt, schema, system, temperature = 0.9, search = false, maxOutputTokens }) {
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature,
            responseMimeType: 'application/json',
            responseSchema: schema,
            // ⚠️ 長い文章を書かせるときは必ず指定する。
            //    既定の上限は 8192 トークンで、日本語 7,000〜9,000 字の記事はそこを超える。
            //    超えると応答が途中で切れ、JSON として読めなくなって
            //    「Gemini の応答が JSON として読めませんでした」という
            //    原因の分かりにくい失敗になる（長さの問題だと気づけない）。
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
        },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    // ⚠️ 検索と構造化出力を同時に使えるのは Gemini 3 系から。
    //    2系に投げると 400 で落ちる。呼び出し側が supportsSearch() で確かめること。
    if (search) body.tools = [{ google_search: {} }];

    const { text, finishReason } = await callGemini(model, body);
    try {
        return JSON.parse(text);
    } catch (error) {
        // ⚠️ 出力の上限に当たると、応答は途中で切れたまま返ってくる。
        //    そのまま JSON.parse に渡すと「読めませんでした」としか出ず、
        //    長さが原因だと気づけない。理由を名指しする。
        if (finishReason === 'MAX_TOKENS') {
            throw new Error(
                `Gemini の応答が途中で切れました（出力の上限に当たりました。${text.length} 文字で停止）。\n` +
                    '  → 呼び出し側で maxOutputTokens を増やすか、一度に書かせる量を分けてください。'
            );
        }
        throw new Error(`Gemini の応答が JSON として読めませんでした: ${error.message}\n--- 応答 ---\n${text.slice(0, 800)}`);
    }
}

/** ふつうのテキストを生成させる（note の本文など）。 */
export async function generateText({ model, prompt, system, temperature = 0.9, search = false }) {
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (search) body.tools = [{ google_search: {} }];
    return (await callGemini(model, body)).text;
}

/**
 * そのモデルが「検索しながら構造化出力する」ことに対応しているか。
 *
 * 検索グラウンディングと responseSchema の併用は Gemini 3 系から。
 * 2系に投げると 400 INVALID_ARGUMENT で落ちる。
 * モデルは自動で選ばれる（config/accounts.json の geminiModel: auto）ので、
 * 使う側が毎回ここで確かめる。対応していなければ検索なしで動かす。
 */
export function supportsSearch(model) {
    const major = Number(/^gemini-(\d+)/.exec(String(model ?? ''))?.[1] ?? 0);
    return major >= 3;
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

/**
 * 本命 → 控え の順に投げる。
 *
 * 1つのモデルのなかでのやり直し（待って投げなおす）と、
 * モデルを乗りかえる判断を、ここで分けて扱う。
 * 待って開くのは自分側の上限（429）で、相手が混んでいる（503）のは待っても開かない。
 */
async function callGemini(model, body) {
    const apiKey = requireApiKey();
    const chain = modelChain(model, { search: Boolean(body.tools) });
    let lastError;

    for (const [index, candidate] of chain.entries()) {
        const isLast = index === chain.length - 1;
        const outcome = await callOneModel(apiKey, candidate, body, isLast);

        if (outcome.ok) {
            // 次の呼び出しはここから始める。38 件ぶん「混雑を確かめるだけの待ち時間」を
            // 払わないようにするためで、この実行のあいだだけ覚えておけばよい。
            workingModel = candidate;
            if (index > 0) console.warn(`  ↪ ${candidate} で書けました`);
            return outcome.value;
        }

        lastError = outcome.error;

        // キーや権限の間違いは、どのモデルに投げても同じことが起きる。
        // 乗りかえると同じエラーが並ぶだけで、本当の理由が埋もれる。
        if (outcome.fatal) throw outcome.error;

        if (!isLast) {
            console.warn(`  ↪ ${candidate} は使えません（${outcome.reason}）。${chain[index + 1]} に切り替えます`);
        }
    }

    // ⚠️ 何を試したかを必ず添える。控えを持たせた以上、
    //    「503 でした」だけでは、控えが働いたのか、そもそも並んでいなかったのかが分からない。
    const tried = chain.join(' → ');
    const error = lastError ?? new Error('Gemini API の呼び出しに失敗しました');
    error.message = `${error.message}\n\n  → 試したモデル: ${tried}（すべて使えませんでした）`;
    throw error;
}

/**
 * 1つのモデルに投げる。待ってやり直すのはここまで。
 *
 * @param {boolean} isLast  これが最後の候補か（次が無いときだけ、長い待ちまで粘る）
 * @returns {Promise<{ok:true, value:object}|{ok:false, fatal:boolean, reason:string, error:Error}>}
 */
async function callOneModel(apiKey, model, body, isLast) {
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
    // 次に行き先があるなら、30秒の待ちは省く。混んでいる相手を待つより、空いている相手に投げるほうが早い。
    const waits = (isLast ? [2, 8, 30] : [2, 8]).map((sec) => sec * retryUnitMs());
    let lastError;
    let reason = '不明';

    for (let attempt = 1; attempt <= waits.length + 1; attempt += 1) {
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
            reason = '通信できません';
            if (attempt <= waits.length) {
                await sleep(waits[attempt - 1]);
                continue;
            }
            break;
        }

        if (response.ok) {
            const json = await response.json();
            const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
            const finishReason = json?.candidates?.[0]?.finishReason ?? null;
            if (!text.trim()) {
                // 安全フィルタで止められた場合はここに来る。理由を出さないと直しようがない。
                // モデルを変えても同じ文章は同じように止められるので、乗りかえない。
                const blocked = finishReason ?? json?.promptFeedback?.blockReason ?? '不明';
                return {
                    ok: false,
                    fatal: true,
                    reason: `空の応答（${blocked}）`,
                    error: new Error(`Gemini が空の応答を返しました（finishReason: ${blocked}）`),
                };
            }
            return { ok: true, value: { text, finishReason } };
        }

        const detail = await response.text().catch(() => '');
        lastError = new Error(describeApiError(response.status, detail));
        reason = `${response.status}`;

        // 404 は「その版がもう無い」。何度投げても同じなので、待たずに次の候補へ渡す。
        // 自動選択が古い版を掴んだまま止まる、という壊れ方をここで受け止める。
        // 候補が全部 404 だったときは設定を見なおす話なので、
        // スタックトレースではなく案内が出るように印をつけておく。
        if (response.status === 404) {
            lastError.userFacing = true;
            break;
        }

        // 429（レート上限）と 5xx（一時的な障害）だけやり直す。
        // 400 や 403 は何度投げても同じで、モデルを変えても同じなので、すぐ止めて原因を出す。
        if (response.status !== 429 && response.status < 500) {
            return { ok: false, fatal: true, reason, error: Object.assign(lastError, { userFacing: true }) };
        }

        if (attempt <= waits.length) {
            const wait = waits[attempt - 1];
            console.warn(`  ⏳ Gemini ${response.status}。${wait / 1000}秒待ってやり直します（${attempt}/${waits.length}）`);
            await sleep(wait);
        }
    }

    return { ok: false, fatal: false, reason, error: lastError ?? new Error('Gemini API の呼び出しに失敗しました') };
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

    if (status === 503 || text.includes('unavailable') || text.includes('high demand')) {
        return [
            '  → そのモデルが混みあっています（キーや設定の問題ではありません）。',
            '     出たばかりの版はいちばん混んでいる版でもあるので、控えの版へ自動で切り替えます。',
            '     控えが1つも無い状態でここに来た場合は、config/accounts.json の geminiModel を',
            "     'auto' にして、node scripts/check-gemini.mjs --models で候補を確かめてください。",
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

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
