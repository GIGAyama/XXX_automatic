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
import { buildGalleries, toLauncherPost } from './lib/launcher-post.mjs';
import { lintAlternative } from './lib/lint.mjs';
import { ARTICLES_DIR, toIndexEntry, validateArticle } from '../docs/lib/note-doc.js';

/** 「今週ぶん」として扱う週のほかに、さかのぼって載せる週の数。 */
const PAST_WEEKS = 3;

/**
 * ［つくる］でアプリを選ぶための一覧。
 *
 * アプリ一覧のページ（docs/apps.html）とは別に、ここにも要る。
 * あちらは検索と OGP のために静的な HTML として作ってあり、
 * ランチャーの JS からは中身を読めないためである。
 * 選ぶのに要るものだけにする（52件ぶん載るので、説明文まで入れると重くなる）。
 */
function appsForPicker(profiles, byName) {
    return profiles
        .map((p) => ({
            name: p.name,
            label: p.catchCopy || p.name,
            oneLine: p.oneLine ?? '',
            subject: p.subject ?? '',
            grade: p.targetGrade ?? '',
            // 公開 URL が無いアプリ（Chrome 拡張・GAS など）は、投稿にしても行き先が無い。
            // 選べなくはしない（作った話は書ける）が、印は付けておく。
            hasPages: Boolean(byName.get(p.name)?.pagesUrl ?? p.pagesUrl),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * アプリのリポジトリに用意された note 記事の一覧。
 *
 * 正は docs/note-articles/ に置いてあるファイルそのものにする（見出しだけの一覧を別に持たない）。
 * 2つ持つと、片方だけ古くなったときに「一覧には出るのに開けない」
 * 「置いてあるのに一覧に出ない」が起こり、どちらが正なのか決められなくなる。
 *
 * ⚠️ ここでも形を確かめる。配る直前が最後の関所である。
 *    壊れたものを載せると、画面には「記事を読み取れませんでした」としか出ない。
 */
function noteArticlesFor() {
    const dir = paths.docs(ARTICLES_DIR);
    if (!fs.existsSync(dir)) return { entries: [], broken: [] };

    const entries = [];
    const broken = [];

    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        const id = name.replace(/\.json$/, '');
        const { ok, errors, article } = validateArticle(readJson(paths.docs(ARTICLES_DIR, name), null), { id });
        if (!ok) {
            broken.push(`${name} — ${errors.join(' / ')}`);
            continue;
        }
        entries.push(toIndexEntry({ ...article, id }));
    }

    return { entries, broken };
}

function loadProfiles() {
    const dir = paths.data('profiles');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(paths.data('profiles', f)));
}

function main() {
    const { accounts, slots, themes, guardrails, monetization } = loadConfig();

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

    // アプリのリポジトリに用意された記事（本人が書いたもの）。週の下書きとは別に並べる。
    const { entries: noteArticles, broken: brokenArticles } = noteArticlesFor();

    if (posts.length === 0 && notes.length === 0 && noteArticles.length === 0) {
        info('⚠ 載せるものがありません。先に `npm run generate` を実行してください。');
    }

    // 画面に出るアプリのぶんだけ、添付できる画像の一覧を載せる。
    //
    // ⚠️ 52件ぜんぶを載せない。KANJI_Town だけで28枚あるので、
    //    全アプリぶんを入れるとスマホが最初に読むファイルが理由もなく重くなる。
    //    ［つくる］で注文して作った投稿は、添付候補を結果ファイルと一緒に受け取る
    //    （scripts/generate-promo.mjs）ので、ここに無くても画像を選べる。
    const usedRepos = new Set([...posts, ...stock].map((post) => post.repo).filter(Boolean));
    const galleries = buildGalleries(usedRepos, accounts.githubOwner);

    // ［つくる］でアプリと型を選ぶための材料。
    const profiles = loadProfiles();
    const reposByName = new Map(
        (readJson(paths.data('repos.json'), { repos: [] }).repos ?? []).map((r) => [r.name, r])
    );
    const apps = appsForPicker(profiles, reposByName);

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
        // 添付できる画像の一覧。アプリ単位で持つ。
        // 投稿ごとに持たせると、同じアプリが何度も出てくるぶんだけ同じ配列が並び、
        // スマホで最初に読むファイルが理由もなく重くなる。
        galleries,
        posts,
        notes,
        // アプリのリポジトリに用意ずみの記事。見出しだけを載せる
        // （本文と画像の説明は docs/note-articles/<id>.json にあり、開いたときに読みにいく）。
        noteArticles,
        // 予定に無い投稿を「いま出したい」ときの引き出し。週次で作り置きしてある。
        stock,
        // ［つくる］でアプリを選ぶための一覧と、頼める型。
        // 型は config/themes.json をそのまま写す（posts から拾うと、
        // その週にたまたま出なかった型を注文できなくなる）。
        apps,
        themes: themes.themes.map((t) => ({ id: t.id, label: t.label, intent: t.intent })),
    });

    info(`⑤ 完了 — ${rel(outPath)}`);
    info(`   投稿 ${posts.length} 件 / note 下書き ${notes.length} 本 / 予備 ${stock.length} 件（今週ぶん: ${activeWeekIds.join(', ')}）`);
    if (noteArticles.length > 0) {
        const withProblems = noteArticles.filter((a) => a.problems > 0).length;
        info(
            `   リポジトリに用意された記事: ${noteArticles.length} 本（${noteArticles.map((a) => a.repo).join(', ')}）` +
                (withProblems > 0 ? ` ※ ${withProblems} 本に気をつけることがあります` : '')
        );
    }
    for (const line of brokenArticles) {
        // 黙って落とさない。置いてあるのに画面に出ないのは、いちばん理由の追えない壊れ方である。
        console.error(`   ✖ 記事を載せられませんでした: ${line}`);
    }
    if (pastWeekIds.length > 0) info(`   過去週として ${pastWeekIds.filter((id) => posts.some((p) => p.weekId === id)).length} 週ぶんを載せました`);

    const missingMedia = posts.filter((p) => p.mediaList.length === 0).length;
    if (missingMedia > 0) {
        info(`   ※ ${missingMedia} 件は画像がありません。\`npm run media\` を実行すると付きます`);
    }
    const attachable = Object.values(galleries).reduce((sum, items) => sum + items.filter((i) => i.kind === 'repo').length, 0);
    if (attachable > 0) {
        info(`   添付できるリポジトリ内の画像: ${attachable} 枚（ランチャーで選べます）`);
    }
    const over = posts.filter((p) => p.overLimit).length;
    if (over > 0) {
        info(`   ※ ${over} 件が ${maxLength} 文字を超えています。ランチャーが共有の前に警告します`);
    }
    if (droppedAlternatives > 0) {
        info(`   ※ 別の案 ${droppedAlternatives} 件は基準を満たさないので載せませんでした（\`npm run lint:drafts\` に理由が出ます）`);
    }
    info(`   ［つくる］で選べるアプリ: ${apps.length} 件 / 頼める型: ${themes.themes.length} 種`);
    if (apps.length === 0) {
        info('   ※ アプリの一覧が空です。［つくる］でアプリを選べません（`npm run profiles`）');
    }
}

try {
    main();
} catch (error) {
    fail(error.stack ?? error.message);
}

export {};
