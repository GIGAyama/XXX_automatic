#!/usr/bin/env node
/**
 * ⑤ ランチャー用のデータを組む。
 *
 *   node scripts/build-launcher-data.mjs
 *
 * data/ の中身から、投稿ランチャー（docs/）が読む1つの JSON を作る。
 *
 * なぜ docs/ に別ファイルを置くのか:
 *   ランチャーは GitHub Pages 上の素の HTML/JS で動く。
 *   data/ の中はスクリプト向けの形で、profiles や repos の全文まで入っていて重い。
 *   スマホで開く画面が、使わないデータのダウンロードを待つのは無駄である。
 *   表示に要るものだけをここで抜き出す。
 */
import fs from 'node:fs';
import { fail, info, loadConfig, paths, readJson, rel, writeJson } from './lib/io.mjs';
import { addDays, isoWeekId, jstDateString, jstStamp, nextWeekDates, weekDatesOf } from './lib/jst.mjs';
import { lintAlternative } from './lib/lint.mjs';
import { composeSteps, seedFrom, weightedLength } from './lib/x-text.mjs';

/** 「今週ぶん」として扱う週のほかに、さかのぼって載せる週の数。 */
const PAST_WEEKS = 3;

/**
 * 表示に要るものだけを抜き出す。
 *
 * steps（連投の手順）を持たない古い週の投稿は、本文1コマの連投として組み立てなおす。
 * ランチャー側に「steps がある場合とない場合」の分岐を持ち込まないためである。
 */
function toLauncherPost(post, weekId, maxLength, placement = 'reply', gate = null) {
    const mediaList = mediaPathsFor(post.repo);
    const steps = (post.steps ?? legacySteps(post, placement)).map((step) => ({
        kind: step.kind,
        label: step.label,
        text: step.text,
        weightedLength: step.weightedLength ?? weightedLength(step.text),
    }));
    const main = steps[0];

    return {
        id: post.id,
        weekId,
        date: post.date,
        weekday: post.weekday,
        slot: post.slot,
        slotLabel: post.slotLabel,
        hour: post.hour,
        theme: post.theme,
        themeLabel: post.themeLabel,
        repo: post.repo,
        steps,
        // text は本文（1コマ目）。通知や古い版の画面がここだけを見ていても壊れないように残す。
        text: main.text,
        url: post.url,
        // media は1枚目。古い Service Worker が配っている app.js が読んでも壊れないように残す。
        media: mediaList[0] ?? post.media ?? null,
        mediaList,
        weightedLength: main.weightedLength,
        overLimit: main.weightedLength > maxLength,
        // 落選案。ランチャーから差し替えられるようにする。本文だけ渡せば足りる。
        //
        // ⚠️ 配信の直前にもガードレール検査をかける。
        //    ［別の案］はワンタップで本文になるので、本文と同じ基準を通っていないものを
        //    押せる場所に置いてはいけない。生成側（generate-week.mjs）でも同じことをしているが、
        //    data/queue/ には検査が無かったころの週が残りつづける。ここが最後の関所になる。
        alternatives: (post.alternatives ?? [])
            .filter((a) => !gate || gate(a, post))
            .map((a) => ({ body: a.body, thread: a.thread ?? [] })),
        pickReason: post.pickReason ?? null,
        hook: post.hook ?? null,
    };
}

/**
 * steps を持たない古い週の投稿を、連投の形に組みなおす。
 *
 * 古い形は「本文 + URL + ハッシュタグ」を1つの文につなげてあった。
 * そのまま出すと本文に URL が入った投稿になり、X にほとんど表示されない。
 * 幸い body / url / hashtags は別々に残してあるので、正確に組みなおせる。
 *
 * これは移行のための一度きりの処理ではなく、置いたままにする。
 * data/queue/ には過去の週が残りつづけるし、
 * 画面側に「古い形」の分岐を持ち込まないための場所がここだからである。
 */
function legacySteps(post, placement) {
    if (post.body && post.url) {
        return composeSteps({
            body: post.body,
            thread: [],
            url: post.url,
            hashtags: post.hashtags ?? [],
            placement,
            seed: seedFrom(post.id),
        });
    }
    // body すら無いものは、そのまま1コマとして出すしかない。
    return [{ kind: 'main', label: '本文', text: post.text }];
}

/** その投稿に付く画像のパス（複数コマがあれば全部）。 */
function mediaPathsFor(repo) {
    const found = [];
    for (let i = 1; i <= 4; i += 1) {
        const name = i === 1 ? `${repo}-card.png` : `${repo}-card-${i}.png`;
        if (fs.existsSync(paths.media(name))) found.push(`media/${name}`);
        else if (i > 1) break;
    }
    return found;
}

function main() {
    const { accounts, slots, guardrails, monetization } = loadConfig();

    // 落選案が本文と同じ基準を満たしているか。満たさないものは配信物に載せない。
    // 何件外したかを数えて最後に出す（黙って減ると、案が3つのはずが2つでも気づけない）。
    let droppedAlternatives = 0;
    const altGate = (alt, post) => {
        const ok = lintAlternative(alt, post, guardrails, monetization).length === 0;
        if (!ok) droppedAlternatives += 1;
        return ok;
    };

    // 今週と翌週を載せる。日曜の夜に翌週分ができるので、
    // 週末は「今週の残り」と「来週の分」が両方見える状態になる。
    const activeWeekIds = [...new Set([isoWeekId(jstDateString()), isoWeekId(nextWeekDates()[0])])];

    // さらに過去数週も載せる。反応を記録するには「先週なにを出したか」が見える必要があるし、
    // 反応がよかったものを日を置いて出しなおす、という使い方もできる。
    // ここに載っていない週は、ランチャーが「過去」タブに回す。
    const today = jstDateString();
    const pastWeekIds = [];
    for (let i = 1; i <= PAST_WEEKS; i += 1) {
        const id = isoWeekId(addDays(weekDatesOf(today)[0], -7 * i));
        if (!activeWeekIds.includes(id)) pastWeekIds.push(id);
    }

    const maxLength = guardrails.maxWeightedLength ?? 280;
    const placement = guardrails.urlPlacement ?? 'reply';
    const posts = [];
    const notes = [];

    for (const weekId of [...pastWeekIds, ...activeWeekIds]) {
        const queue = readJson(paths.data('queue', `${weekId}.json`), null);
        if (queue) {
            for (const post of queue.posts) {
                posts.push(toLauncherPost(post, weekId, maxLength, placement, altGate));
            }
        }

        // note の下書きは今週・翌週ぶんだけ。過去のものは出しても押すものが無い。
        if (!activeWeekIds.includes(weekId)) continue;
        const note = readJson(paths.data('note', `${weekId}.json`), null);
        if (note) {
            notes.push({
                weekId,
                title: note.title,
                tags: note.tags,
                featured: note.featured,
                plain: note.plain,
                charCount: note.charCount,
            });
        }
    }

    posts.sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date < b.date ? -1 : 1));

    // 予備の引き出し。日付を持たないので、週の投稿とは別に置く。
    const stock = (readJson(paths.data('stock.json'), { posts: [] }).posts ?? []).map((post) =>
        toLauncherPost(post, '', maxLength, placement, altGate)
    );

    if (posts.length === 0 && notes.length === 0) {
        info('⚠ 載せるものがありません。先に `npm run generate` を実行してください。');
    }

    const outPath = paths.docs('launcher.json');
    writeJson(outPath, {
        generatedAt: new Date().toISOString(),
        generatedAtJst: jstStamp(),
        // ここに入っている週が「今週ぶん」。入っていない週はランチャーが過去扱いにする。
        weekIds: activeWeekIds,
        pastWeekIds,
        launcherUrl: accounts.launcherUrl,
        noteEditorUrl: accounts.noteEditorUrl,
        xHandle: accounts.xHandle,
        maxWeightedLength: maxLength,
        urlPlacement: placement,
        // 「反応がよかった」の記録と「返信の下書き」を Issue にして送り返すために使う。
        // トークンを画面に持たせずに書き戻せる唯一の方法がこれ。
        repoUrl: `https://github.com/${accounts.githubOwner}/${accounts.repoName}`,
        slots: slots.slots.map((s) => ({ id: s.id, label: s.label, hour: s.hour })),
        posts,
        notes,
        // 予定に無い投稿を「いま出したい」ときの引き出し。週次で作り置きしてある。
        stock,
    });

    info(`⑤ 完了 — ${rel(outPath)}`);
    info(`   投稿 ${posts.length} 件 / note 下書き ${notes.length} 本 / 予備 ${stock.length} 件（今週ぶん: ${activeWeekIds.join(', ')}）`);
    if (pastWeekIds.length > 0) info(`   過去週として ${pastWeekIds.filter((id) => posts.some((p) => p.weekId === id)).length} 週ぶんを載せました`);

    const missingMedia = posts.filter((p) => p.mediaList.length === 0).length;
    if (missingMedia > 0) {
        info(`   ※ ${missingMedia} 件は画像がありません。\`npm run media\` を実行すると付きます`);
    }
    const over = posts.filter((p) => p.overLimit).length;
    if (over > 0) {
        info(`   ※ ${over} 件が ${maxLength} 文字を超えています。ランチャーが共有の前に警告します`);
    }
    if (droppedAlternatives > 0) {
        info(`   ※ 別の案 ${droppedAlternatives} 件は基準を満たさないので載せませんでした（\`npm run lint:drafts\` に理由が出ます）`);
    }
}

try {
    main();
} catch (error) {
    fail(error.stack ?? error.message);
}

export {};
