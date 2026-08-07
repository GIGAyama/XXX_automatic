/**
 * 使う Gemini のモデルを決める。
 *
 * なぜ要るのか:
 *   モデル名を config に直書きしていると、新しい版が出ても書き換えるまで古いままになる。
 *   Google は数か月おきに新しい版を出し、古い版はいずれ止まる（そのとき 404 になって
 *   週次が丸ごと落ちる）。名前を追いかけつづけるのは人の仕事として続かない。
 *
 * どうするか:
 *   API に「いま使えるモデル」を聞いて、そのなかから選ぶ。
 *   gemini-3-flash が出れば、こちらは何もしなくてもそれが選ばれる。
 *
 * 選び方の方針:
 *   ・既定は「安定版のうちいちばん新しいもの」。preview や exp は既定では使わない。
 *     途中で挙動が変わったり、予告なく消えたりするものに毎週の生成を預けない。
 *   ・系統（flash / pro / flash-lite）は config で選ぶ。既定は flash。
 *     無料枠で1週間14本ぶんを1回にまとめて投げるので、速くて安いものが合っている。
 *   ・問い合わせに失敗したら、config に書いてある控えの名前を使う。
 *     モデル一覧が引けないことを理由に、その週の投稿を作れなくするのは本末転倒である。
 *     ただし黙って落ちない。何が起きて何を使ったかを必ず標準エラーに出す。
 *
 * 選んだ結果は data/gemini-model.json に残してコミットする。
 * 「いつ、どの版から、どの版に切り替わったか」が git の履歴に残るようにするためである。
 */
import fs from 'node:fs';
import { paths, readJson, writeJson } from './io.mjs';
import { jstStamp } from './jst.mjs';
import { requireApiKey } from './gemini.mjs';

const ENDPOINT = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models';

/** 文章を書かせる用途に使えないモデル。名前で落とす。 */
const NOT_FOR_TEXT = [
    'embedding',
    'aqa',
    'imagen',
    'veo',
    'tts',
    'native-audio',
    'live-',
    'image-generation',
    '-image',
    'computer-use',
    'gemma',
    'learnlm',
    'robotics',
];

/** 安定版ではない印。既定ではこれらを避ける。 */
const UNSTABLE = ['preview', 'exp', 'experimental', 'thinking'];

/** 系統の判定順（flash-lite を flash より先に見ないと、flash に吸われる）。 */
const FAMILIES = ['flash-lite', 'flash', 'pro'];

/** 'models/gemini-2.5-flash' → 'gemini-2.5-flash' */
export function shortName(name) {
    return String(name ?? '').replace(/^models\//, '');
}

/**
 * モデル名から素性を読み取る。
 * @returns {{id:string, family:string|null, major:number, minor:number, stable:boolean, rolling:boolean, dated:boolean}}
 */
export function describeModel(nameOrModel) {
    const id = shortName(typeof nameOrModel === 'string' ? nameOrModel : nameOrModel?.name);
    const lower = id.toLowerCase();

    const version = /^gemini-(\d+)(?:[.-](\d+))?/.exec(lower);
    return {
        id,
        family: FAMILIES.find((f) => lower.includes(f)) ?? null,
        major: version ? Number(version[1]) : 0,
        minor: version?.[2] ? Number(version[2]) : 0,
        // gemini-flash-latest のような、中身が入れかわりつづける別名
        rolling: lower.endsWith('-latest'),
        // gemini-2.5-flash-preview-05-20 のような日付つきの断面
        dated: /-\d{2}-\d{2}$/.test(lower) || /-\d{3,4}$/.test(lower),
        stable: !UNSTABLE.some((word) => lower.includes(word)),
    };
}

/** 文章生成に使えるモデルだけを残す。 */
export function usableModels(models) {
    return (models ?? []).filter((model) => {
        const id = shortName(model?.name).toLowerCase();
        if (!id.startsWith('gemini-')) return false;
        if (NOT_FOR_TEXT.some((word) => id.includes(word))) return false;
        // supportedGenerationMethods が無い応答もあるので、あるときだけ見る
        const methods = model?.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes('generateContent')) return false;
        return true;
    });
}

/**
 * 候補を「良い順」に並べる。
 *
 * ⚠️ 並べるだけで、選ぶのは呼び出し側。
 *    どういう順で並んだのかをログに出したいので、1件だけ返す形にしていない。
 *
 * @param {object[]} models        API が返したモデル一覧
 * @param {object} [options]
 * @param {string} [options.prefer='flash']       欲しい系統
 * @param {boolean} [options.allowPreview=false]  preview / exp も候補に入れるか
 */
export function rankModels(models, { prefer = 'flash', allowPreview = false } = {}) {
    const candidates = usableModels(models)
        .map((model) => ({ ...describeModel(model), raw: model }))
        .filter((m) => allowPreview || m.stable)
        // 中身が入れかわる別名は、指名されたときだけ使う。
        // 「いちばん新しい」を名乗りながら preview を指していることがあり、
        // 既定で掴むと、こちらが何もしていないのに生成の質が変わる。
        .filter((m) => !m.rolling);

    // 桁を大きく離してあるのは、上の条件が下の条件に覆されないようにするため。
    // 「新しさ」より「系統」を優先し、「安定しているか」より「新しさ」を優先する。
    //
    // 安定より新しさを上に置いているのは、preview を候補に入れるのが
    // allowPreview を立てたときだけだからである。立てた人は新しいものを試したい。
    // 立てていなければ preview はそもそもここに来ない（上で外してある）ので、
    // この順番が既定の安全性を損なうことはない。
    const score = (m) => {
        let s = 0;
        if (m.family === prefer) s += 1_000_000;
        else if (m.family) s += 500_000; // 系統が違っても、使えるなら候補には残す
        s += m.major * 10_000 + m.minor * 100;
        if (m.stable) s += 1_000; // 同じ版なら安定版
        if (!m.dated) s += 100; // gemini-2.5-flash を gemini-2.5-flash-001 より優先する
        return s;
    };

    return candidates
        .sort((a, b) => score(b) - score(a) || a.id.length - b.id.length || a.id.localeCompare(b.id))
        .map((m) => m.id);
}

/** API に「いま使えるモデル」を聞く。 */
export async function listModels() {
    const apiKey = requireApiKey();
    const models = [];
    let pageToken = '';

    // 一覧は数十件で収まるが、増えたときに黙って切り捨てないようページをたどる。
    for (let page = 0; page < 10; page += 1) {
        const url = `${ENDPOINT}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`モデル一覧を取れませんでした（${response.status}）: ${detail.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        const json = await response.json();
        models.push(...(json.models ?? []));
        pageToken = json.nextPageToken ?? '';
        if (!pageToken) break;
    }
    return models;
}

/** config/accounts.json の書き方を、扱いやすい形にそろえる。 */
export function readPolicy(accounts) {
    const raw = accounts?.geminiModel;
    const auto = raw === 'auto' || raw === undefined || raw === null || raw === '';
    return {
        auto,
        // auto でないときは、書かれた名前をそのまま使う（版を固定したい場合）
        pinned: auto ? null : String(raw),
        fallback: accounts?.geminiModelFallback || 'gemini-2.5-flash',
        prefer: accounts?.geminiModelPrefer || 'flash',
        allowPreview: accounts?.geminiAllowPreview === true,
        maxAgeHours: Number(accounts?.geminiModelMaxAgeHours ?? 24),
    };
}

const CACHE_PATH = () => paths.data('gemini-model.json');

function cacheAgeHours(cache) {
    if (!cache?.resolvedAt) return Infinity;
    const at = Date.parse(cache.resolvedAt);
    if (Number.isNaN(at)) return Infinity;
    return (Date.now() - at) / 3_600_000;
}

/**
 * 使うモデル名を1つ決める。
 *
 * @param {object} accounts   config/accounts.json
 * @param {object} [options]
 * @param {boolean} [options.refresh]  キャッシュを無視して聞きなおす
 * @param {boolean} [options.quiet]    選んだ結果を出力しない
 * @returns {Promise<{model:string, source:string, candidates:string[]}>}
 */
export async function resolveGeminiModel(accounts, { refresh = false, quiet = false } = {}) {
    const policy = readPolicy(accounts);

    if (!policy.auto) {
        return { model: policy.pinned, source: 'config（固定）', candidates: [] };
    }

    const cache = readJson(CACHE_PATH(), null);
    if (!refresh && cache?.model && cacheAgeHours(cache) < policy.maxAgeHours) {
        return { model: cache.model, source: `キャッシュ（${cache.resolvedAtJst ?? '時刻不明'}）`, candidates: cache.candidates ?? [] };
    }

    let candidates;
    try {
        candidates = rankModels(await listModels(), policy);
    } catch (error) {
        // ここで止めない。モデル一覧が引けないことを理由に、
        // その週の投稿を作れなくするのは本末転倒である。ただし黙らない。
        const fallback = cache?.model || policy.fallback;
        console.error(
            `⚠ Gemini のモデル一覧を取れませんでした。${fallback} を使って続けます。\n` +
                `   理由: ${error.message}\n` +
                '   （このまま生成に失敗する場合は、config/accounts.json の geminiModelFallback を見なおしてください）'
        );
        return { model: fallback, source: '控え（一覧を取れず）', candidates: [] };
    }

    if (candidates.length === 0) {
        const fallback = cache?.model || policy.fallback;
        console.error(
            `⚠ 条件に合うモデルが1つも見つかりませんでした。${fallback} を使って続けます。\n` +
                `   条件: 系統=${policy.prefer} / preview を使う=${policy.allowPreview}\n` +
                '   （config/accounts.json の geminiModelPrefer を見なおしてください）'
        );
        return { model: fallback, source: '控え（候補なし）', candidates: [] };
    }

    const model = candidates[0];
    const previous = cache?.model ?? null;

    writeJson(CACHE_PATH(), {
        _comment:
            'scripts/lib/gemini-models.mjs が書く。使っている Gemini のモデルと、そのとき選べた候補。' +
            '手で直す必要はない。版が切り替わったことを git の履歴で追えるようにコミットしている。',
        model,
        previous: previous !== model ? previous : (cache?.previous ?? null),
        prefer: policy.prefer,
        allowPreview: policy.allowPreview,
        resolvedAt: new Date().toISOString(),
        resolvedAtJst: jstStamp(),
        candidates: candidates.slice(0, 12),
    });

    if (!quiet && previous && previous !== model) {
        console.log(`   モデルが切り替わりました: ${previous} → ${model}`);
    }

    return { model, source: '自動選択', candidates };
}

/** キャッシュが無くても落ちないように、素の読み出しも公開しておく（検査用）。 */
export function readCachedModel() {
    return fs.existsSync(CACHE_PATH()) ? readJson(CACHE_PATH(), null) : null;
}
