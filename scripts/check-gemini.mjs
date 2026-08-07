#!/usr/bin/env node
/**
 * Gemini API に1回だけ小さく投げて、本当に使えるかを確かめる。
 *
 *   node scripts/check-gemini.mjs
 *
 * なぜ要るか:
 *   キーが「登録されているが正しくない」場合、シークレットの有無チェックは通ってしまう。
 *   そのまま進むと 52 リポジトリぶん同じ 400 が並び、
 *   本当の理由（キーが違う／モデル名が違う／権限が無い）は
 *   同じ行の繰り返しに埋もれる。実際にそうなった。
 *
 *   ここで1回だけ投げれば、2秒で「使える／使えない」が分かる。
 *   使えない場合は理由と、次にどこを触ればよいかまで出す。
 */
import { generateText } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { failWith, info, loadConfig, parseArgs } from './lib/io.mjs';

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();

    // ここで決めて data/gemini-model.json に書く。
    // 以降の工程（②理解・④生成・④'note）は、その結果を読むだけになる。
    // 週次のいちばん最初に走るステップなので、ここが「今週どのモデルを使うか」を決める場所である。
    const { model, source, candidates } = await resolveGeminiModel(accounts, { refresh: true });

    info(`Gemini API を確かめます（モデル: ${model} — ${source}）`);
    if (candidates.length > 1) {
        info(`   ほかの候補: ${candidates.slice(1, 5).join(', ')}`);
    }

    if (args['models']) {
        // 何が選べる状態なのかを見たいときのための出口。
        info('\n選べるモデル（良い順）:');
        for (const [i, id] of candidates.entries()) info(`  ${i === 0 ? '→' : ' '} ${id}`);
        return;
    }

    // 中身はどうでもよい。通信と認証とモデル名が通ることだけを見る。
    // 短くしているのは、無料枠のトークンを確認のために使いたくないため。
    const text = await generateText({
        model,
        prompt: 'こんにちは、と一言だけ返してください。',
        temperature: 0,
    });

    info(`✓ Gemini API は使えます（応答: ${text.replace(/\s+/g, ' ').trim().slice(0, 40)}）`);
}

main().catch((error) => {
    console.error('\n────────────────────────────────────────');
    console.error('Gemini API を呼べませんでした。');
    console.error('この状態では投稿文を作れないので、ここで止めます。');
    console.error('────────────────────────────────────────');
    failWith(error);
});
