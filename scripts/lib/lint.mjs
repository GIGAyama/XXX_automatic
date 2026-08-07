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
 * 1件の投稿を検査して、問題のメッセージの配列を返す。空配列なら合格。
 *
 * @param {object} post          text を持つ投稿オブジェクト（weightedLength をここで埋める）
 * @param {object} guardrails    config/guardrails.json
 * @param {object} monetization  config/monetization.json
 */
export function lintPost(post, guardrails, monetization) {
    const problems = [];
    const text = post?.text ?? '';

    if (!text.trim()) return ['本文が空です'];

    // ── 長さ ──────────────────────────────────
    const weighted = weightedLength(text, guardrails.urlWeight);
    post.weightedLength = weighted; // ランチャーの表示にも使うので書き戻す

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

    // ── URL ──────────────────────────────────
    const urls = extractUrls(text);
    if (guardrails.requireUrl && urls.length === 0) {
        problems.push('アプリの URL が入っていません');
    }
    if (urls.length > 1) {
        problems.push(`URL が ${urls.length} 本あります。1本にしてください`);
    }

    // ── ハッシュタグ・絵文字 ─────────────────────────
    const hashtags = extractHashtags(text);
    if (hashtags.length > guardrails.maxHashtags) {
        problems.push(`ハッシュタグが多すぎます（${hashtags.length}/${guardrails.maxHashtags}）`);
    }

    const emoji = countEmoji(text);
    if (emoji > guardrails.maxEmoji) {
        problems.push(`絵文字が多すぎます（${emoji}/${guardrails.maxEmoji}）`);
    }

    // ── 禁止表現 ───────────────────────────────
    for (const rule of guardrails.forbiddenPatterns ?? []) {
        const re = new RegExp(rule.pattern, 'iu');
        const hit = re.exec(text);
        if (hit) problems.push(`${rule.reason}（「${hit[0]}」）`);
    }

    for (const word of guardrails.forbiddenWords ?? []) {
        if (word && text.includes(word)) problems.push(`禁止語が入っています（「${word}」）`);
    }

    // ── 収益化 ────────────────────────────────
    // enabled が false のあいだは、収益化の導線が混ざっていないかを見る。
    // 兼業許可を確認するまでは外に出さない、という約束を機械で守るための検査。
    if (!monetization?.enabled) {
        for (const pattern of guardrails.monetizationPatterns ?? []) {
            const hit = new RegExp(pattern, 'iu').exec(text);
            if (hit) {
                problems.push(
                    `収益化の表現が入っています（「${hit[0]}」）。` +
                        'config/monetization.json の enabled が false のあいだは入れられません'
                );
            }
        }
    }

    return problems;
}

/** 週分をまとめて検査する。 */
export function lintPosts(posts, guardrails, monetization) {
    return posts.map((post) => ({ id: post.id, problems: lintPost(post, guardrails, monetization) }));
}
