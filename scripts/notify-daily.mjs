#!/usr/bin/env node
/**
 * ⑥ 通知 — その日に出すぶんをスマホに届ける。
 *
 *   node scripts/notify-daily.mjs
 *   node scripts/notify-daily.mjs --dry-run
 *   node scripts/notify-daily.mjs --date 2026-08-10
 *   node scripts/notify-daily.mjs --slot evening   … その枠だけを知らせる
 *
 * この工程がいちばん効く。
 * 下書きがどれだけ良くても、開くきっかけが無ければ発信は続かない。
 *
 * ⚠️ 枠ごとに知らせる。
 *   config/slots.json は朝と夜の2枠なのに、通知は朝の1回だけで、
 *   夜のぶんは朝の Issue に一緒に載っているだけだった。
 *   つまり夜の投稿は「朝に見たことを覚えている」ことが前提になっていて、
 *   README が「ここが発信を続けるための要」と書いている通知が、枠の半分に効いていなかった。
 *   .github/workflows/daily-notify.yml が枠のぶんだけ cron を持ち、--slot で呼び分ける。
 *
 * 届け方は2つ。
 *   ① GitHub Issue を立てる（既定）
 *      GitHub のモバイルアプリが通知を出してくれる。追加の設定も費用もいらない。
 *   ② Discord の Webhook（任意）
 *      DISCORD_WEBHOOK を設定したときだけ。通知の見え方はこちらのほうが快適。
 *
 * LINE Notify は 2025年3月で終了したので使っていない。
 */
import { createIssue, listIssues, updateIssue } from './lib/github.mjs';
import { fail, failWith, info, loadConfig, parseArgs, paths, readJson } from './lib/io.mjs';
import { isoWeekId, jstDateString, jstStamp, weekdayLabelOf } from './lib/jst.mjs';

async function main() {
    const args = parseArgs();
    const { accounts, slots: slotConfig } = loadConfig();

    const date = args.date ?? jstDateString();
    const weekId = isoWeekId(date);

    // --slot が来たら、その枠だけを知らせる。省略時はその日ぶん全部（従来どおり）。
    const slotId = typeof args.slot === 'string' ? args.slot : null;
    if (slotId && !slotConfig.slots.some((s) => s.id === slotId)) {
        fail(
            `--slot ${slotId} は config/slots.json にありません。` +
                `使えるのは ${slotConfig.slots.map((s) => s.id).join(' / ')} です`
        );
    }
    const slotLabel = slotId ? (slotConfig.slots.find((s) => s.id === slotId)?.label ?? slotId) : null;

    const queue = readJson(paths.data('queue', `${weekId}.json`), null);
    const todays = (queue?.posts ?? []).filter((p) => p.date === date && (!slotId || p.slot === slotId));

    if (todays.length === 0) {
        // ここで黙って終わらない。下書きが尽きた日にこそ、出すものがあることを知らせたい。
        // 予備の引き出し（週次で作り置きしてある）から提案する。
        await notifyEmptyDay({ date, weekId, slotId, slotLabel, accounts, args, hasQueue: Boolean(queue) });
        return;
    }

    const note = readJson(paths.data('note', `${weekId}.json`), null);
    // note は週のはじめだけ案内する。毎日出すと本文に埋もれる。
    // 枠を分けて知らせるときは最初の枠にだけ添える。1日に2回同じ案内が出ると読み飛ばされる。
    const firstSlotOfDay = slotConfig.slots[0]?.id;
    const noteSlotOk = !slotId || slotId === firstSlotOfDay;
    const includeNote = note && noteSlotOk && weekdayOfIsIn(date, [1, 6, 0]);

    const scope = slotLabel ? `（${weekdayLabelOf(date)}）${slotLabel}` : `（${weekdayLabelOf(date)}）`;
    const title = `【${formatDate(date)}${scope}】${slotLabel ? 'この枠の投稿' : '今日の投稿'} ${todays.length} 件`;
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
            labels: [DAILY_LABEL],
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

    // 昨日までの知らせを閉じる。用は済んでいる。
    await closeOldNotices(accounts, date);

    if (process.env.DISCORD_WEBHOOK) {
        try {
            await notifyDiscord(process.env.DISCORD_WEBHOOK, { date, todays, accounts, slotLabel });
            info('✓ Discord に送りました');
            notified += 1;
        } catch (error) {
            console.error(`✖ Discord に送れませんでした: ${error.message}`);
        }
    }

    if (notified === 0) fail('どこにも通知できませんでした。');
    info(`⑥ 完了（${jstStamp()}）`);
}

/** 予備の引き出しから、その日に提案する本数。多いと選べない。 */
const STOCK_SUGGESTIONS = 2;

/** 毎日の知らせに付けるラベル。 */
export const DAILY_LABEL = '今日の投稿';

/** 下書きが無いことの知らせに付けるラベル。 */
export const NO_DRAFT_LABEL = '下書きがありません';

/**
 * 本文に埋める日付の目印。
 *
 * 昨日までの知らせを閉じるのに使う。タイトル（【8/10（月）朝】…）から
 * 読み取ることもできるが、年が入っていないので年をまたぐと判定できない。
 * 機械が読むものは機械が読める形で置く（反応の記録と同じ考え方）。
 */
const STAMP = (date) => `<!-- notify-daily ${date} -->`;
const STAMP_RE = /<!-- notify-daily (\d{4}-\d{2}-\d{2}) -->/;

/**
 * その知らせを閉じてよいか。
 *
 * ⚠️ 目印を持たないものは触らない。この仕組みより前に立てた知らせや、
 *    人が手で立てた Issue に同じラベルが付いていることがある。
 *    機械が消してよいのは、機械が立てたと分かるものだけである。
 */
export function shouldClose(body, today) {
    const stamped = STAMP_RE.exec(String(body ?? ''))?.[1];
    if (!stamped) return false;
    return stamped < today;
}

/** 1回に閉じる上限。溜まっていても、1日ぶんずつ片づけば十分である。 */
const MAX_CLOSE = 20;

/**
 * 昨日までの「今日の投稿」を閉じる。
 *
 * 閉じないと、1日2枠 × 365日で年に730件たまる。
 * そうなると Issue の一覧が使いものにならなくなり、
 * 「週次の失敗」や「反応の記録」といった、開いていることに意味がある知らせが埋もれる。
 * その日の投稿を知らせるという役目は、翌日には終わっている。
 *
 * ⚠️ 同じ日のものは閉じない。朝の知らせは、夜の知らせが立ったあとも
 *    「今日まだ出していないもの」を見るために開いていてほしい。
 */
async function closeOldNotices(accounts, today) {
    let closed = 0;
    try {
        const issues = await listIssues(accounts.githubOwner, accounts.repoName, {
            labels: [DAILY_LABEL],
            state: 'open',
        });

        for (const issue of issues) {
            if (!shouldClose(issue.body, today)) continue;
            if (closed >= MAX_CLOSE) break;

            await updateIssue(accounts.githubOwner, accounts.repoName, issue.number, { state: 'closed' });
            closed += 1;
        }
    } catch (error) {
        // 片づけに失敗しても、今日の知らせは届いている。ここで止めない。
        console.error(`⚠ 古い知らせを閉じられませんでした: ${error.message}`);
        return;
    }

    if (closed > 0) info(`   きのうまでの知らせを ${closed} 件閉じました`);
}

/**
 * その日ぶんの下書きが無いときの知らせ。
 *
 * 以前はここで黙って終了していた（しかも終了コードは 0）。
 * だから「週次が落ちて今週ぶんが1件も無い」ときと「もともと予定の無い日」の区別が
 * どこにも出ず、発信が止まっていることに誰も気づけなかった。
 *
 * 予定が無いだけの日は静かにしておく。困るのは「あるはずのものが無い」ときなので、
 * その場合だけ知らせて、予備の引き出しから2件を提案する。
 *
 * ⚠️ 同じ知らせを重ねない。
 *    週次が落ちたままだと、この知らせは枠のぶんだけ毎日立つ（1日2件）。
 *    直すまで増えつづけるので、いちばん見てほしい知らせが自分で自分を埋めることになる。
 *    開いているあいだは立てず、直したら本人が閉じる（「週次の失敗」と同じ扱い）。
 */
async function notifyEmptyDay({ date, weekId, slotId, slotLabel, accounts, args, hasQueue }) {
    const stock = (readJson(paths.data('stock.json'), { posts: [] }).posts ?? []).slice(0, STOCK_SUGGESTIONS);

    if (hasQueue) {
        // 今週ぶんはあるが、この日（この枠）には割り当てが無い。設定どおりなので静かにしておく。
        info(`${date}${slotLabel ? `（${slotLabel}）` : ''} に割り当てられた投稿はありません。`);
        return;
    }

    if (!args['dry-run']) {
        // 取れなかったときは「立てる」側に倒す。知らせが重なるより、届かないほうが困る。
        try {
            const open = await listIssues(accounts.githubOwner, accounts.repoName, {
                labels: [NO_DRAFT_LABEL],
                state: 'open',
            });
            if (open.length > 0) {
                info(`   すでに #${open[0].number} で知らせています。重ねて立てません: ${open[0].html_url}`);
                return;
            }
        } catch (error) {
            console.error(`⚠ 既存の知らせを確かめられませんでした（そのまま立てます）: ${error.message}`);
        }
    }

    const where = slotLabel ? `${formatDate(date)}（${weekdayLabelOf(date)}）${slotLabel}` : `${formatDate(date)}（${weekdayLabelOf(date)}）`;
    const title = `【${where}】今週ぶんの下書きがありません`;

    const lines = [
        `${weekId} の下書き（\`data/queue/${weekId}.json\`）がありません。`,
        '日曜の夜の週次ワークフローが失敗した可能性があります。',
        '',
        `- [Actions を見る](https://github.com/${accounts.githubOwner}/${accounts.repoName}/actions)`,
        `- 手で動かす: Actions → 「週次 — 翌週の投稿を用意する」→ Run workflow`,
        '',
    ];

    if (stock.length > 0) {
        lines.push(
            '---',
            '',
            '### 今日はこれを出せます',
            '',
            `[［出す］→［予備］](${accounts.launcherUrl}#now) に用意してあるものです。そのまま共有できます。`,
            ''
        );
        for (const post of stock) {
            lines.push(`#### ${post.themeLabel} / ${post.repo}`, '', '```', post.text, '```', '');
        }
    } else {
        lines.push('予備の引き出しも空です。復旧するまで、この日は出せるものがありません。', '');
    }

    lines.push('<sub>直ったら、この Issue を閉じてください。開いているあいだは同じ知らせを重ねて出しません。</sub>');

    if (args['dry-run']) {
        info(`--- タイトル ---\n${title}\n\n--- 本文 ---\n${lines.join('\n')}`);
        return;
    }

    try {
        const issue = await createIssue(accounts.githubOwner, accounts.repoName, {
            title,
            body: lines.join('\n'),
            labels: [NO_DRAFT_LABEL],
        });
        info(`✓ 下書きが無いことを知らせました: ${issue.html_url}`);
    } catch (error) {
        // ラベルが無いリポジトリだと落ちることがある。ラベル無しでもう一度だけ試す。
        try {
            const issue = await createIssue(accounts.githubOwner, accounts.repoName, { title, body: lines.join('\n') });
            info(`✓ 下書きが無いことを知らせました（ラベルなし）: ${issue.html_url}`);
        } catch (retryError) {
            console.error(`✖ 知らせられませんでした: ${retryError.message}`);
        }
    }
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
        '### 反応を翌週にいかす',
        '',
        `出し終わったら [［記録］タブ](${accounts.launcherUrl}#done) で［投稿した］を押し、`,
        '伸びたものに［反応よかった］、手応えがなかったものに［いまいち］を付けてください。',
        '',
        'そのあと **［反応をまとめて送る］** を押すと、記録を載せた Issue の作成画面が開きます。',
        '緑の［Create］を押せば送信完了です。日曜の週次が読み取って、翌週の下書きに反映します。',
        '',
        '<sub>この Issue は、あすの知らせが立つときに自動で閉じます。</sub>',
        '',
        STAMP(date)
    );

    return lines.join('\n');
}

async function notifyDiscord(webhook, { date, todays, accounts, slotLabel = null }) {
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
            content:
                `**${formatDate(date)}（${weekdayLabelOf(date)}）${slotLabel ?? ''}の投稿 ${todays.length} 件**\n` +
                `${accounts.launcherUrl}`,
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
