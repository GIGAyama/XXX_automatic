/**
 * 投稿文のガードレール検査。
 *
 * このシステムは「人が毎回読んで確認する」ことを前提にしていない。
 * 確認を前提にすると、それ自体が続かなくなって発信が止まるからである。
 * だから、読まなくても危ないものが外に出ないところを機械で担保する。
 *
 * 検査に落ちたら、ゆるめるのではなく config/guardrails.json に理由を書いて
 * 明示的に許可すること。黙って通すと、何を守っているのか誰にも分からなくなる。
 *
 * ⚠️ この検査は「0件でした」だけでは信用できない。わざと危ない文字列を
 *    混ぜて落ちることを確かめてから信じること（tests/lint.test.mjs でやっている）。
 */
import { countEmoji, extractHashtags, extractUrls, plainLength, weightedLength } from './x-text.mjs';

/**
 * どのコマにも共通で当てる検査。
 * 個人情報・根拠のない断定・煽り・収益化は、本文であれ返信であれ外に出してはいけない。
 */
function lintCommon(text, guardrails, monetization, problems, where) {
    const at = where ? `${where}: ` : '';

    for (const rule of guardrails.forbiddenPatterns ?? []) {
        const hit = new RegExp(rule.pattern, 'iu').exec(text);
        if (hit) problems.push(`${at}${rule.reason}（「${hit[0]}」）`);
    }

    for (const word of guardrails.forbiddenWords ?? []) {
        if (word && text.includes(word)) problems.push(`${at}禁止語が入っています（「${word}」）`);
    }

    // enabled が false のあいだは、収益化の導線が混ざっていないかを見る。
    // 兼業許可を確認するまでは外に出さない、という約束を機械で守るための検査。
    if (!monetization?.enabled) {
        for (const pattern of guardrails.monetizationPatterns ?? []) {
            const hit = new RegExp(pattern, 'iu').exec(text);
            if (hit) {
                problems.push(
                    `${at}収益化の表現が入っています（「${hit[0]}」）。` +
                        'config/monetization.json の enabled が false のあいだは入れられません'
                );
            }
        }
    }

    const emoji = countEmoji(text);
    if (emoji > guardrails.maxEmoji) {
        problems.push(`${at}絵文字が多すぎます（${emoji}/${guardrails.maxEmoji}）`);
    }
}

/**
 * 1件の投稿を検査して、問題のメッセージの配列を返す。空配列なら合格。
 *
 * steps（連投の手順）を持つ投稿は、コマごとに役割に応じた検査をする。
 * steps が無い古い形の投稿は、これまでどおり text を1つの本文として検査する
 * （data/queue/ に前の週のものが残っているため、読めなくなると困る）。
 *
 * @param {object} post          steps か text を持つ投稿オブジェクト（weightedLength をここで埋める）
 * @param {object} guardrails    config/guardrails.json
 * @param {object} monetization  config/monetization.json
 */
export function lintPost(post, guardrails, monetization) {
    const problems = [];
    const steps = Array.isArray(post?.steps) && post.steps.length > 0 ? post.steps : null;

    if (!steps) return lintSingle(post, guardrails, monetization);

    const placement = guardrails.urlPlacement ?? 'reply';
    const maxWeighted = guardrails.maxWeightedLength ?? 280;

    const main = steps.find((s) => s.kind === 'main');
    if (!main || !String(main.text ?? '').trim()) return ['本文が空です'];

    const threads = steps.filter((s) => s.kind === 'thread');
    if (threads.length > (guardrails.threadMaxSteps ?? 3)) {
        problems.push(`つづきが多すぎます（${threads.length}/${guardrails.threadMaxSteps ?? 3}）。最後まで読まれません`);
    }

    let totalUrls = 0;

    for (const step of steps) {
        const text = String(step.text ?? '');
        const label = step.label ?? step.kind;

        if (!text.trim()) {
            problems.push(`${label}が空です`);
            continue;
        }

        const weighted = weightedLength(text, guardrails.urlWeight);
        step.weightedLength = weighted; // ランチャーの表示に使うので書き戻す

        const limit = step.kind === 'link' ? (guardrails.replyMaxWeightedLength ?? maxWeighted) : maxWeighted;
        if (weighted > limit) {
            problems.push(
                `${label}が長すぎます（${weighted}/${limit}）。` +
                    `日本語は1字=2でカウントされ、URLは一律${guardrails.urlWeight}字ぶんになります。` +
                    `${Math.ceil((weighted - limit) / 2)}字ほど削ってください`
            );
        }

        const urls = extractUrls(text);
        totalUrls += urls.length;

        if (step.kind === 'main') {
            const plain = plainLength(text);
            if (plain < guardrails.minPlainChars) {
                problems.push(`本文が短すぎます（URL・タグを除いて${plain}字）。${guardrails.minPlainChars}字以上にしてください`);
            }
            // ⚠️ ここが今回いちばん効く検査。
            //    本文に外部リンクがあると X はリーチを大きく下げる。
            //    「うっかり本文に URL が混ざる」のは生成でいちばん起きやすい形なので、機械で止める。
            if (placement === 'reply' && urls.length > 0) {
                problems.push(
                    `本文に URL が入っています（${urls[0]}）。` +
                        'X は本文に外部リンクがある投稿のリーチを大きく下げます。リンクは返信に回してください'
                );
            }
            const hashtags = extractHashtags(text);
            if (hashtags.length > guardrails.maxHashtags) {
                problems.push(`ハッシュタグが多すぎます（${hashtags.length}/${guardrails.maxHashtags}）`);
            }
        }

        if (step.kind === 'thread') {
            const plain = plainLength(text);
            if (plain < (guardrails.minThreadChars ?? 25)) {
                problems.push(`${label}が短すぎます（${plain}字）。ぶつ切りにして数を増やさないでください`);
            }
            if (placement === 'reply' && urls.length > 0) {
                problems.push(`${label}に URL が入っています。リンクは最後の返信にまとめてください`);
            }
        }

        if (step.kind === 'link' && urls.length !== 1) {
            problems.push(`リンクの返信に URL が ${urls.length} 本あります。1本にしてください`);
        }

        lintCommon(text, guardrails, monetization, problems, step.kind === 'main' ? '' : label);
    }

    if (guardrails.requireUrl && totalUrls === 0) {
        problems.push('どこにもアプリの URL が入っていません');
    }
    if (totalUrls > 1) {
        problems.push(`URL が ${totalUrls} 本あります。1本にしてください`);
    }

    // ランチャーとこれまでの表示が本文の長さを見ているので、そろえて書き戻す。
    post.weightedLength = weightedLength(main.text, guardrails.urlWeight);

    return problems;
}

/** steps を持たない古い形の投稿を、これまでどおり1つの本文として検査する。 */
function lintSingle(post, guardrails, monetization) {
    const problems = [];
    const text = post?.text ?? '';

    if (!text.trim()) return ['本文が空です'];

    const weighted = weightedLength(text, guardrails.urlWeight);
    post.weightedLength = weighted;

    if (weighted > guardrails.maxWeightedLength) {
        problems.push(
            `長すぎます（${weighted}/${guardrails.maxWeightedLength}）。` +
                `日本語は1字=2でカウントされ、URLは一律${guardrails.urlWeight}字ぶんになります。${Math.ceil((weighted - guardrails.maxWeightedLength) / 2)}字ほど削ってください`
        );
    }

    const plain = plainLength(text);
    if (plain < guardrails.minPlainChars) {
        problems.push(`短すぎます（URL・タグを除いて${plain}字）。${guardrails.minPlainChars}字以上にしてください`);
    }

    const urls = extractUrls(text);
    if (guardrails.requireUrl && urls.length === 0) problems.push('アプリの URL が入っていません');
    if (urls.length > 1) problems.push(`URL が ${urls.length} 本あります。1本にしてください`);

    const hashtags = extractHashtags(text);
    if (hashtags.length > guardrails.maxHashtags) {
        problems.push(`ハッシュタグが多すぎます（${hashtags.length}/${guardrails.maxHashtags}）`);
    }

    lintCommon(text, guardrails, monetization, problems, '');
    return problems;
}

/** 週分をまとめて検査する。 */
export function lintPosts(posts, guardrails, monetization) {
    return posts.map((post) => ({ id: post.id, problems: lintPost(post, guardrails, monetization) }));
}
