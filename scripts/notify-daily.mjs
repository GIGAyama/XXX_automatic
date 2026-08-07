#!/usr/bin/env node
/**
 * ⑥ 通知 — その日に出すぶんをスマホに届ける。
 *
 *   node scripts/notify-daily.mjs
 *   node scripts/notify-daily.mjs --dry-run
 *   node scripts/notify-daily.mjs --date 2026-08-10
 *
 * この工程がいちばん効く。
 * 下書きがどれだけ良くても、開くきっかけが無ければ発信は続かない。
 *
 * 届け方は2つ。
 *   ① GitHub Issue を立てる（既定）
 *      GitHub のモバイルアプリが通知を出してくれる。追加の設定も費用もいらない。
 *   ② Discord の Webhook（任意）
 *      DISCORD_WEBHOOK を設定したときだけ。通知の見え方はこちらのほうが快適。
 *
 * LINE Notify は 2025年3月で終了したので使っていない。
 */
import { createIssue } from './lib/github.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, readJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, weekdayLabelOf } from './lib/jst.mjs';

async function main() {
    const args = parseArgs();
    const { accounts } = loadConfig();

    const date = args.date ?? jstDateString();
    const weekId = isoWeekId(date);

    const queue = readJson(paths.data('queue', `${weekId}.json`), null);
    if (!queue) {
        info(`${weekId} の下書きがありません。通知するものがないので終了します。`);
        return;
    }

    const todays = queue.posts.filter((p) => p.date === date);
    if (todays.length === 0) {
        info(`${date} に割り当てられた投稿はありません。`);
        return;
    }

    const note = readJson(paths.data('note', `${weekId}.json`), null);
    // note は週のはじめだけ案内する。毎日出すと本文に埋もれる。
    const includeNote = note && weekdayOfIsIn(date, [1, 6, 0]);

    const title = `【${formatDate(date)}（${weekdayLabelOf(date)}）】今日の投稿 ${todays.length} 件`;
    const body = buildBody({ date, todays, note: includeNote ? note : null, accounts });

    if (args['dry-run']) {
        info(`--- タイトル ---\n${title}\n\n--- 本文 ---\n${body}`);
        return;
    }

    let notified = 0;

    try {
        const issue = await createIssue(accounts.githubOwner, accounts.repoName, {
            title,
            body,
            labels: ['今日の投稿'],
        });
        info(`✓ Issue を立てました: ${issue.html_url}`);
        notified += 1;
    } catch (error) {
        // ラベルが無いリポジトリだと落ちることがある。ラベル無しでもう一度だけ試す。
        try {
            const issue = await createIssue(accounts.githubOwner, accounts.repoName, { title, body });
            info(`✓ Issue を立てました（ラベルなし）: ${issue.html_url}`);
            notified += 1;
        } catch (retryError) {
            console.error(`✖ Issue を立てられませんでした: ${retryError.message}`);
        }
    }

    if (process.env.DISCORD_WEBHOOK) {
        try {
            await notifyDiscord(process.env.DISCORD_WEBHOOK, { date, todays, accounts });
            info('✓ Discord に送りました');
            notified += 1;
        } catch (error) {
            console.error(`✖ Discord に送れませんでした: ${error.message}`);
        }
    }

    if (notified === 0) fail('どこにも通知できませんでした。');
    info(`⑥ 完了（${jstStamp()}）`);
}

function buildBody({ date, todays, note, accounts }) {
    const lines = [
        `### 👉 [投稿ランチャーをひらく](${accounts.launcherUrl})`,
        '',
        'ランチャーで［𝕏 に共有］を押すと、画像つき・本文入りの投稿画面が開きます。あとは投稿ボタンだけです。',
        '',
        '---',
        '',
    ];

    for (const post of todays) {
        lines.push(
            `#### ${post.slotLabel}（${post.hour}:00ごろ） — ${post.themeLabel} / ${post.repo}`,
            '',
            '```',
            post.text,
            '```',
            `<sub>${post.weightedLength ?? '?'}/280 文字${post.media ? ' ・ 画像あり' : ' ・ 画像なし'}</sub>`,
            ''
        );
    }

    if (note) {
        lines.push(
            '---',
            '',
            `### 📝 note の下書きもあります`,
            '',
            `**${note.title}**（約${note.charCount}字）`,
            '',
            `ランチャーの「note」タブから、本文をコピーして note のエディタを開けます。`,
            ''
        );
    }

    lines.push(
        '---',
        '',
        '<sub>出し終わったらランチャーで［投稿した］を押してください。',
        '反応がよかったものに印を付けておくと、翌週の下書きに反映されます。',
        'この Issue は閉じてしまってかまいません。</sub>'
    );

    return lines.join('\n');
}

async function notifyDiscord(webhook, { date, todays, accounts }) {
    const embeds = todays.slice(0, 10).map((post) => ({
        title: `${post.slotLabel} — ${post.themeLabel} / ${post.repo}`,
        description: post.text.slice(0, 1800),
        color: 0x1d3557,
        // 画像は GitHub Pages から配信されているので、Discord からも参照できる。
        image: post.media ? { url: `${accounts.launcherUrl}${post.media}` } : undefined,
    }));

    const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            content: `**${formatDate(date)}（${weekdayLabelOf(date)}）の投稿 ${todays.length} 件**\n${accounts.launcherUrl}`,
            embeds,
        }),
    });

    if (!response.ok) {
        throw new Error(`Discord ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }
}

function weekdayOfIsIn(dateString, weekdays) {
    const [y, m, d] = dateString.split('-').map(Number);
    return weekdays.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}

function formatDate(iso) {
    const [, m, d] = iso.split('-');
    return `${Number(m)}/${Number(d)}`;
}

main().catch(failWith);
