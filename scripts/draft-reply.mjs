#!/usr/bin/env node
/**
 * 返信の下書きを作る。
 *
 *   node scripts/draft-reply.mjs --issue 123
 *   node scripts/draft-reply.mjs --text "相手の投稿の本文" --dry-run
 *
 * ランチャーの［返信の下書きを頼む］が、相手の投稿を載せた Issue を立てる。
 * このスクリプトがそれを読んで返信案を3つ作り、Issue にコメントで返す。
 *
 * なぜ Issue 経由で、しかも非同期なのか:
 *   ブラウザから Gemini を呼ぶには API キーを画面に置くしかなく、それはできない
 *   （CLAUDE.md §2）。Issue を立てれば、ワークフローが受けて数十秒で返せる。
 *   返信は「いますぐ」でなくてよい種類の作業なので、この待ち時間は許容できる。
 *
 * なぜ返信を大事にするのか:
 *   X では、他人の投稿への返信が交流として評価される。
 *   自分の投稿を並べるだけのアカウントは、どれだけ数を出しても伸びない。
 *   ただし返信は相手のある行為なので、機械が勝手に出すことはしない。
 *   案を出すところまでで止め、出すかどうかと最終的な言葉は本人が決める。
 *
 * ⚠️ 外から来る入力である。Issue は誰でも立てられる。
 *    投稿者を確かめ、長さを切ってから Gemini に渡す。
 */
import {
    addIssueComment,
    listIssues,
    updateIssue,
} from './lib/github.mjs';
import { generateJson, requireApiKey } from './lib/gemini.mjs';
import { resolveGeminiModel } from './lib/gemini-models.mjs';
import { failWith, info, loadConfig, loadPolicy, parseArgs } from './lib/io.mjs';
import { jstStamp } from './lib/jst.mjs';
import { isAllowedAuthor } from './collect-feedback.mjs';

export const REPLY_LABEL = '返信の下書き';
export const REPLY_DONE_LABEL = '返信の下書きずみ';

/** 相手の投稿として受け取る本文の上限。長すぎるものは切る。 */
const MAX_SOURCE_CHARS = 1200;

const REPLY_SCHEMA = {
    type: 'object',
    properties: {
        reads: { type: 'string', description: '相手が何を言っているかを1文で。取り違えていないかを本人が確かめるため' },
        replies: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    style: { type: 'string', description: 'この案の立ち位置（共感 / 自分の経験 / 質問 / 補足 のどれか）' },
                    text: { type: 'string', description: '返信の本文。日本語で60〜100字程度。URL は入れない' },
                },
                required: ['style', 'text'],
            },
        },
        caution: { type: 'string', description: '返すときに気をつけたほうがよいこと。無ければ空文字' },
    },
    required: ['reads', 'replies', 'caution'],
};

function buildSystem(policy) {
    return [
        'あなたは日本の小学校教員です。X で、他の人の投稿に返信します。',
        '',
        policy,
        '',
        '【返信を書くときの約束】',
        '- 相手の投稿をよく読み、相手が言っていることに答えてください。自分の話にすり替えないでください。',
        '- 自分のアプリの宣伝をしないでください。相手が明確に求めているときだけ、名前を出さずに「そういうものを作っている」と触れる程度にとどめます。',
        '- URL は入れないでください。',
        '- 教えるような口調にしないでください。相手のほうが詳しいかもしれません。',
        '- 相手の意見に反対する場合も、否定から入らないでください。',
        '- 相手が困っている投稿なら、まず「それは大変ですね」ではなく、自分がどうしていたかを具体的に書いてください。',
        '- 3つの案は、立ち位置をはっきり変えてください（共感 / 自分の経験 / 質問 / 補足）。',
        '',
        '【返さないほうがよい場合】',
        '相手の投稿が、特定の個人や学校への批判、政治的な対立、児童・生徒が特定できる内容を含むときは、',
        'replies を空配列にして、caution にその理由を書いてください。無理に案を出さないでください。',
    ].join('\n');
}

function buildPrompt(source) {
    return [
        '次の投稿に返信します。',
        '',
        '--- 相手の投稿 ---',
        source.slice(0, MAX_SOURCE_CHARS),
        '--- ここまで ---',
        '',
        '立ち位置の違う返信案を3つ書いてください。',
    ].join('\n');
}

/** Issue の本文から、相手の投稿として渡された部分を取り出す。 */
export function extractSource(body) {
    const text = String(body ?? '');
    // ランチャーはコードブロックに入れて渡す。人が手で書いたときのために、無ければ全文を使う。
    const fenced = /```(?:text)?\s*\n([\s\S]*?)\n```/.exec(text);
    const picked = fenced ? fenced[1] : text;
    return picked.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function renderComment({ reads, replies, caution }) {
    const lines = ['### 返信の下書き', '', `**相手が言っていること**: ${reads}`, ''];

    if (replies.length === 0) {
        lines.push('この投稿には返信案を出しませんでした。', '', `> ${caution || '理由は書かれていません'}`);
    } else {
        for (const r of replies) {
            lines.push(`#### ${r.style}`, '', '```', r.text, '```', '');
        }
        if (caution) lines.push('---', '', `⚠ ${caution}`, '');
    }

    lines.push('---', '', '<sub>そのまま使わず、自分の言葉に直してから返してください。', `scripts/draft-reply.mjs — ${jstStamp()}</sub>`);
    return lines.join('\n');
}

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();
    requireApiKey();

    const policy = loadPolicy();
    const { model } = await resolveGeminiModel(accounts);

    // ── 手元で試すとき ──
    if (args.text) {
        const result = await generateJson({
            model,
            system: buildSystem(policy),
            prompt: buildPrompt(String(args.text)),
            schema: REPLY_SCHEMA,
            temperature: 0.9,
        });
        info(renderComment(result));
        return;
    }

    // ── Issue から拾う ──
    const owner = accounts.githubOwner;
    const repo = accounts.repoName;

    const issues = args.issue
        ? (await listIssues(owner, repo, { labels: [REPLY_LABEL], state: 'all' })).filter(
              (i) => String(i.number) === String(args.issue)
          )
        : await listIssues(owner, repo, { labels: [REPLY_LABEL], state: 'open' });

    if (issues.length === 0) {
        info('返信の下書きを頼まれている Issue はありませんでした');
        return;
    }

    info(`返信の下書きを作ります（${issues.length} 件 / モデル ${model}）`);

    for (const issue of issues) {
        if (!isAllowedAuthor(issue.user?.login, accounts)) {
            info(`   #${issue.number} は ${issue.user?.login ?? '不明'} さんが立てたものなので作りません`);
            continue;
        }

        const source = extractSource(issue.body);
        if (source.length < 10) {
            await addIssueComment(owner, repo, issue.number, '相手の投稿が読み取れませんでした。本文を貼りなおしてください。');
            continue;
        }

        try {
            const result = await generateJson({
                model,
                system: buildSystem(policy),
                prompt: buildPrompt(source),
                schema: REPLY_SCHEMA,
                temperature: 0.9,
            });

            if (args['dry-run']) {
                info(renderComment(result));
                continue;
            }

            await addIssueComment(owner, repo, issue.number, renderComment(result));
            await updateIssue(owner, repo, issue.number, { state: 'closed', labels: [REPLY_LABEL, REPLY_DONE_LABEL] });
            info(`   ✓ #${issue.number} に ${result.replies.length} 案を返しました`);
        } catch (error) {
            console.error(`⚠ #${issue.number} の下書きを作れませんでした: ${String(error.message).split('\n')[0]}`);
            await addIssueComment(
                owner,
                repo,
                issue.number,
                `返信の下書きを作れませんでした。\n\n> ${String(error.message).split('\n')[0]}\n\n時間をおいて、もう一度頼んでください。`
            ).catch(() => {});
        }
    }

}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(failWith);
}
