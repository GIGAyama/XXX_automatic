#!/usr/bin/env node
/**
 * ⓪ 反応の記録を取り込む。
 *
 *   node scripts/collect-feedback.mjs [--dry-run]
 *
 * ランチャーの「反応よかった／いまいち」は、labels:feedback の Issue として送られてくる。
 * それを読んで data/feedback.json にまとめ、取り込んだ Issue を閉じる。
 * まとめた結果は generate-week.mjs → plan-week.mjs が読み、翌週の型の重みに効く。
 *
 * ここが無かったあいだ、README の「⑦ 記録」も MANUAL の「翌週の生成に効きます」も、
 * 書いてあるだけで実際には何も起きていなかった（読む側だけがあって、書く側が無かった）。
 *
 * ⚠️ 公開リポジトリなので Issue は誰でも立てられる。
 *    投稿者を確かめずに取り込むと、第三者が翌週の生成の重み付けを動かせてしまう。
 *    許可した人以外の Issue は取り込まない。
 */
import {
    ISSUE_LABEL,
    MERGED_LABEL,
    extractPayload,
    mergeFeedback,
    validatePayload,
} from '../docs/lib/feedback-payload.js';
import { addIssueComment, listIssues, updateIssue } from './lib/github.mjs';
import { failWith, info, loadConfig, parseArgs, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { jstStamp } from './lib/jst.mjs';
import fs from 'node:fs';

const EMPTY = {
    version: 1,
    posts: {},
    themes: {},
    repos: {},
    hooks: {},
    posted: { total: 0, bySlot: {}, byWeekday: {} },
    seen: { submissionIds: [], issueNumbers: [] },
};

/** 取り込んでよい投稿者か。既定はリポジトリの持ち主だけ。 */
export function isAllowedAuthor(login, accounts) {
    if (!login) return false;
    const allowed = new Set([accounts.githubOwner, ...(accounts.feedbackAuthors ?? [])].filter(Boolean));
    return allowed.has(login);
}

/** data/profiles/ にあるアプリ名。取り込む前の照合に使う。 */
function knownRepoNames() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return new Set();
    return new Set(
        fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
    );
}

async function main() {
    const args = parseArgs();
    const { accounts, themes } = loadConfig();
    const owner = accounts.githubOwner;
    const repo = accounts.repoName;

    info(`⓪ 反応の記録を取り込みます（${jstStamp()}）`);

    const issues = await listIssues(owner, repo, { labels: [ISSUE_LABEL], state: 'open' });
    if (issues.length === 0) {
        info('   未取り込みの記録はありませんでした');
        // 何も無いのは正常。ファイルが無いままだと generate-week 側が毎回フォールバックするので、
        // 空の形だけは作っておく（「まだ誰も押していない」と「壊れている」を区別できるようにする）。
        ensureFile();
        return;
    }

    const themeIds = new Set(themes.themes.map((t) => t.id));
    const repoNames = knownRepoNames();
    // フックの型も照合する。外から来る入力なので、知らない値は受け取らない。
    const audience = readJson(paths.config('audience.json'), { hooks: [] });
    const hookIds = new Set((audience.hooks ?? []).map((h) => h.id));

    const accepted = [];
    const rejected = [];

    for (const issue of issues) {
        const at = `#${issue.number}`;

        if (!isAllowedAuthor(issue.user?.login, accounts)) {
            info(`   ${at} は ${issue.user?.login ?? '不明'} さんが立てたものなので取り込みません`);
            continue;
        }

        const payload = extractPayload(issue.body);
        if (!payload) {
            rejected.push({ issue, errors: ['本文に機械向けのブロック（```json feedback-v1）がありません'] });
            continue;
        }

        const { ok, errors } = validatePayload(payload, { themeIds, repoNames, hookIds });
        if (!ok) {
            // 一部だけ採り、残りを黙って捨てるのがいちばん悪い。Issue ごと拒否して開いたまま残す。
            rejected.push({ issue, errors });
            continue;
        }

        accepted.push({ payload, issueNumber: issue.number, issue });
    }

    const current = readJson(paths.data('feedback.json'), EMPTY);
    const { merged, applied, skipped } = mergeFeedback(current, accepted);
    merged.updatedAtJst = jstStamp();

    const entryCount = accepted.reduce((n, a) => n + a.payload.entries.length, 0);
    info(`   Issue ${issues.length} 件 → 取り込み ${applied} 件 / 取り込みずみ ${skipped} 件 / 拒否 ${rejected.length} 件`);
    info(`   記録された投稿は合計 ${Object.keys(merged.posts).length} 件（今回 ${entryCount} 件ぶんを反映）`);

    if (args['dry-run']) {
        info('\n--dry-run なので保存も Issue のクローズもしません。');
        info(JSON.stringify(merged.themes, null, 2));
        return;
    }

    writeJson(paths.data('feedback.json'), merged);
    info(`   ${rel(paths.data('feedback.json'))} を更新しました`);

    // ── 取り込んだ Issue を閉じる ──
    // 閉じないと次回また読む。冪等性は submissionId でも守っているが、
    // 開いたままだと「送ったのに反映されていないのでは」と本人が不安になる。返事を返す。
    for (const { issue, payload } of accepted) {
        try {
            await addIssueComment(
                owner,
                repo,
                issue.number,
                `${payload.entries.length} 件を取り込みました。翌週の下書きに反映されます。\n\n<sub>scripts/collect-feedback.mjs — ${jstStamp()}</sub>`
            );
            await updateIssue(owner, repo, issue.number, {
                state: 'closed',
                labels: [ISSUE_LABEL, MERGED_LABEL],
            });
        } catch (error) {
            // ここで落ちても取り込み自体は終わっている。次回は submissionId で二重計上を避ける。
            console.error(`⚠ #${issue.number} のクローズに失敗しました: ${error.message}`);
        }
    }

    for (const { issue, errors } of rejected) {
        console.error(`⚠ #${issue.number} は取り込めませんでした:\n   - ${errors.join('\n   - ')}`);
        try {
            await addIssueComment(
                owner,
                repo,
                issue.number,
                'この記録は取り込めませんでした。\n\n' +
                    errors.map((e) => `- ${e}`).join('\n') +
                    '\n\n一部だけ取り込むと数がずれるので、まるごと見送っています。' +
                    'ランチャーからもう一度送りなおしてください。\n\n' +
                    `<sub>scripts/collect-feedback.mjs — ${jstStamp()}</sub>`
            );
        } catch (error) {
            console.error(`⚠ #${issue.number} へのコメントにも失敗しました: ${error.message}`);
        }
    }
}

function ensureFile() {
    const path = paths.data('feedback.json');
    if (fs.existsSync(path)) return;
    writeJson(path, { ...EMPTY, updatedAtJst: jstStamp() });
    info(`   ${rel(path)} を新しく作りました`);
}

// テストから import されたときは実行しない（isAllowedAuthor だけを借りに来ることがある）。
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(failWith);
}
