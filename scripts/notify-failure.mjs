#!/usr/bin/env node
/**
 * 週次が落ちたことを知らせる。
 *
 *   node scripts/notify-failure.mjs --workflow 週次 --run-id 123456 [--dry-run]
 *
 * なぜ要るのか:
 *   週次が落ちると data/queue/<週ID>.json が作られず、翌週ランチャーは空になる。
 *   ところが、それに気づける経路が Actions の赤いバツしか無かった。
 *   このシステムの通知は GitHub のモバイルアプリに寄せてあるのに（README「⑥ 通知」）、
 *   失敗だけはその経路に乗っていなかった。
 *
 *   さらに 60日ルールと噛み合うと悪い。リポジトリに動きが無いと GitHub は定期実行を止める。
 *   週次は毎週コミットすることで動きを作っているので、失敗が続くと
 *   「失敗しつづけた末に、定期実行そのものが黙って止まる」という終わり方をする。
 *
 * ⚠️ 同じラベルの開いた Issue があれば立てない。
 *    毎週落ちるたびに同じ Issue が増えると、通知そのものが読み飛ばされるようになる。
 *    直したかどうかは人が Issue を閉じることで示す。
 */
import { createIssue, listIssues } from './lib/github.mjs';
import { failWith, info, loadConfig, parseArgs } from './lib/io.mjs';
import { jstStamp } from './lib/jst.mjs';

export const FAILURE_LABEL = '週次の失敗';

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();
    const owner = accounts.githubOwner;
    const repo = accounts.repoName;

    const workflow = typeof args.workflow === 'string' ? args.workflow : '週次';
    const runId = typeof args['run-id'] === 'string' ? args['run-id'] : null;
    const runUrl = runId ? `https://github.com/${owner}/${repo}/actions/runs/${runId}` : `https://github.com/${owner}/${repo}/actions`;

    const title = `⚠ ${workflow}ワークフローが失敗しました`;
    const body = [
        `${workflow}のワークフローが最後まで通りませんでした（${jstStamp()}）。`,
        '',
        `**[実行ログを見る](${runUrl})**`,
        '',
        'このままだと、翌週ぶんの下書きが用意されません。',
        '',
        '---',
        '',
        '### まず見るところ',
        '',
        '1. **ログの最初の赤い行**。どの工程（①収集 / ②理解 / ③素材 / ④生成 / ⑤配信）で落ちたかが分かります。',
        '2. `GEMINI_API_KEY` が有効か … `Actions → 週次 → Run workflow` を押すと、',
        '   最初の2ステップでキーの有無と実際に使えるかを確かめます。',
        '3. 無料枠の上限（429）なら、日付が変わってから Re-run すれば通ります。',
        '',
        '### 直したら',
        '',
        '`Actions → 「週次 — 翌週の投稿を用意する」→ Run workflow` で手動実行できます。',
        'それまでのあいだは、ランチャーの[［いま出す］タブ](' + accounts.launcherUrl + '#now) に用意してある予備が使えます。',
        '',
        `<sub>この Issue は、直ったら閉じてください。開いているあいだは同じ知らせを重ねて出しません。`,
        `scripts/notify-failure.mjs — ${jstStamp()}</sub>`,
    ].join('\n');

    if (args['dry-run']) {
        info(`--- タイトル ---\n${title}\n\n--- 本文 ---\n${body}`);
        return;
    }

    // 開いたままの知らせがあれば重ねない。
    // 取れなかったときは「立てる」側に倒す。知らせが重なるより、届かないほうが困る。
    try {
        const open = await listIssues(owner, repo, { labels: [FAILURE_LABEL], state: 'open' });
        if (open.length > 0) {
            info(`すでに #${open[0].number} が開いています。重ねて立てません: ${open[0].html_url}`);
            return;
        }
    } catch (error) {
        console.error(`⚠ 既存の知らせを確かめられませんでした（そのまま立てます）: ${error.message}`);
    }

    try {
        const issue = await createIssue(owner, repo, { title, body, labels: [FAILURE_LABEL] });
        info(`✓ 失敗を知らせました: ${issue.html_url}`);
    } catch (error) {
        // ラベルが無いリポジトリだと落ちることがある。ラベル無しでもう一度だけ試す。
        try {
            const issue = await createIssue(owner, repo, { title, body });
            info(`✓ 失敗を知らせました（ラベルなし）: ${issue.html_url}`);
        } catch (retryError) {
            console.error(`✖ 失敗を知らせられませんでした: ${retryError.message}`);
            process.exitCode = 1;
        }
    }
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(failWith);
}
