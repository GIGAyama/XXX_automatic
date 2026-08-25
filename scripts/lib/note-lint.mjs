/**
 * note の記事の検査。
 *
 * X の投稿（lib/lint.mjs）とは見るところが違う。
 * あちらは140字に収まるか・危ないことを書いていないかだった。
 * こちらは数千字あるので、放っておくと「機能を並べただけの文章」になる。
 * 連載として読まれるには、毎回同じ骨格で、同じ距離感で書かれている必要がある。
 *
 * 基準は config/note-style.json にある。実例（GIGAyama/Qalc の note 記事、
 * 本文約7,900字・画面21点）が通ることを確かめて決めてある。
 *
 * ⚠️ この検査も「0件でした」だけでは信用できない。
 *    実例が通り、基準を満たさない文章が落ちることを確かめてから信じること
 *    （tests/note-lint.test.mjs でやっている）。
 */

/** 画像の記法。字数を数えるときは外す。 */
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** 見出し行。 */
const HEADING_RE = /^#{1,6}\s+(.*)$/;

/** 絵文字（見出しの印に使っているもの）。 */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/**
 * 記事を検査する。
 *
 * @param {object} article       { title, sections: [{heading, body}], tags }
 * @param {string} markdown      組み上げた Markdown（見出しと画像を含む）
 * @param {object} style         config/note-style.json
 * @param {object} guardrails    config/guardrails.json
 * @param {object} monetization  config/monetization.json
 * @returns {string[]} 問題のメッセージ。空配列なら合格
 */
export function lintArticle({ article, markdown, style, guardrails, monetization }) {
    const problems = [];
    const text = String(markdown ?? '');
    const bodyOnly = text.replace(IMAGE_RE, '');
    // 言葉づかいの検査からハッシュタグの行を外す。あそこは文章ではないし、
    // 「#個別最適な学び」のような学習指導要領の言葉がそのまま入る
    //（実例の記事がそうだった。抽象語として弾くと、正しい記事が落ちる）。
    const proseOnly = bodyOnly
        .split('\n')
        .filter((l) => !/^\s*#[^\s#]/.test(l.trim()))
        .join('\n');

    problems.push(...lintShape(text, bodyOnly, style));
    problems.push(...lintStructure(text, style));
    problems.push(...lintWords(proseOnly, style));
    problems.push(...lintSafety(proseOnly, guardrails, monetization));
    problems.push(...lintTitle(article?.title ?? '', style));

    return problems;
}

/* ── 形（装飾を使っていないか・分量） ────────────────── */

function lintShape(text, bodyOnly, style) {
    const problems = [];
    const forbidden = style?.forbidden ?? {};

    if (forbidden.bold && text.includes('**')) {
        const n = Math.floor((text.match(/\*\*/g) ?? []).length / 2);
        problems.push(`太字を ${n} か所で使っています。装飾ではなく文章の力で強調してください`);
    }

    if (forbidden.table) {
        const rows = text.split('\n').filter((l) => l.trimStart().startsWith('|')).length;
        if (rows > 0) problems.push(`表を使っています（${rows}行）。note では表示されないので、文章にしてください`);
    }

    for (const symbol of forbidden.symbols ?? []) {
        if (text.includes(symbol)) {
            problems.push(`区切り記号「${symbol}」を使っています。記号でつながず、文章にしてください`);
        }
    }

    // 字数は画像の記法を除いて数える。実例は約7,900字。
    const [min, max] = style?.charRange ?? [7000, 9000];
    const length = bodyOnly.replace(/\s/g, '').length;
    if (length < min) {
        problems.push(`本文が ${length} 字です。${min}〜${max} 字にしてください（あと ${min - length} 字ほど）`);
    } else if (length > max) {
        problems.push(`本文が ${length} 字です。${min}〜${max} 字にしてください（${length - max} 字ほど多い）`);
    }

    return problems;
}

/* ── 骨格（見出しの並び・箇条書き・絵文字） ───────────── */

function lintStructure(text, style) {
    const problems = [];
    const forbidden = style?.forbidden ?? {};
    const want = style?.sections ?? [];

    const lines = text.split('\n');
    const headings = lines.filter((l) => HEADING_RE.test(l)).map((l) => HEADING_RE.exec(l)[1].trim());
    // 記事タイトル（# 見出し1つ目）は骨格の判定から外す
    const sectionHeadings = lines
        .filter((l) => /^##\s+/.test(l))
        .map((l) => l.replace(/^##\s+/, '').trim());

    // 決まった見出しが、決まった順で出てくるか。
    // note は見出しから目次を作るので、ここが骨格そのものになる。
    let at = 0;
    for (const section of want) {
        const found = sectionHeadings.indexOf(section.heading, at);
        if (found === -1) {
            problems.push(`見出し「${section.heading}」がありません`);
        } else {
            at = found + 1;
        }
    }

    const known = new Set(want.map((s) => s.heading));
    const extras = sectionHeadings.filter((h) => !known.has(h));
    const maxExtra = style?.maxExtraSections ?? 2;
    if (extras.length > maxExtra) {
        problems.push(
            `決まった見出し以外が ${extras.length} 本あります（${maxExtra} 本まで）。目次が散らかります: ${extras.join(' / ')}`
        );
    }

    // 箇条書きは手順の節だけ。並べれば伝わるわけではない。
    if (forbidden.listOutsideGuide) {
        const allowed = new Set(want.filter((s) => s.allowList).map((s) => s.heading));
        let current = '';
        for (const line of lines) {
            if (/^##\s+/.test(line)) {
                current = line.replace(/^##\s+/, '').trim();
                continue;
            }
            if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) continue;
            if (allowed.has(current)) continue;
            problems.push(`「${current || '見出しの前'}」で箇条書きを使っています。手順の節以外は文章で書いてください`);
            break; // 1件だけ言えば直せる。同じ指摘を並べない
        }
    }

    // 絵文字は見出しだけ。
    if (forbidden.emojiInBody) {
        for (const line of lines) {
            if (HEADING_RE.test(line)) continue;
            if (line.trimStart().startsWith('#')) continue;
            if (EMOJI_RE.test(line.replace(IMAGE_RE, ''))) {
                problems.push(`本文に絵文字が入っています（「${line.trim().slice(0, 30)}」）。絵文字は見出しだけです`);
                break;
            }
        }
    }

    void headings;
    return problems;
}

/* ── 言葉（専門用語・前置き・抽象語・呼びかた） ────────── */

function lintWords(bodyOnly, style) {
    const problems = [];
    const forbidden = style?.forbidden ?? {};

    for (const [term, replacement] of forbidden.jargon ?? []) {
        if (!term || !bodyOnly.includes(term)) continue;
        problems.push(
            `専門用語「${term}」が入っています。` + (replacement ? `「${replacement}」のように言いかえてください` : '日常の言葉にしてください')
        );
    }

    for (const opener of forbidden.openers ?? []) {
        if (opener && bodyOnly.includes(opener)) {
            problems.push(`定型の前置き「${opener}」が入っています。そこは読み飛ばされます`);
        }
    }

    for (const word of forbidden.abstract ?? []) {
        if (word && bodyOnly.includes(word)) {
            problems.push(`抽象語「${word}」が入っています。何がどう変わるかで書いてください`);
        }
    }

    // 子どもの呼びかた。「児童」は硬いので連載では使わない。
    for (const word of style?.naming?.avoidForChildren ?? []) {
        if (word && bodyOnly.includes(word)) {
            problems.push(`「${word}」を使っています。この連載では「${style?.naming?.children ?? '子どもたち'}」と呼びます`);
        }
    }

    return problems;
}

/* ── 安全（X の投稿と同じ基準を当てる） ───────────────── */

function lintSafety(bodyOnly, guardrails, monetization) {
    const problems = [];

    for (const rule of guardrails?.forbiddenPatterns ?? []) {
        const hit = new RegExp(rule.pattern, 'iu').exec(bodyOnly);
        if (hit) problems.push(`${rule.reason}（「${hit[0]}」）`);
    }

    // 教室での出来事を、実際に見たこととして書いていないか。
    // 記事は数千字あるぶん、X より書いてしまいやすい（実際に書いていた）。
    for (const rule of guardrails?.experiencePatterns ?? []) {
        const hit = new RegExp(rule.pattern, 'iu').exec(bodyOnly);
        if (hit) {
            problems.push(`${rule.reason}（「${hit[0]}」）。実際の授業の様子は、出す前にご自身で足してください`);
        }
    }

    for (const word of guardrails?.forbiddenWords ?? []) {
        if (word && bodyOnly.includes(word)) problems.push(`禁止語が入っています（「${word}」）`);
    }

    if (!monetization?.enabled) {
        for (const pattern of guardrails?.monetizationPatterns ?? []) {
            const hit = new RegExp(pattern, 'iu').exec(bodyOnly);
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

/* ── タイトル ─────────────────────────────────── */

function lintTitle(rawTitle, style) {
    const problems = [];
    // 連載名と番号は機械が前に付ける。長さの判定はタイトル本体だけを見る。
    const series = style?.series ?? '';
    const title = String(rawTitle ?? '')
        .replace(/^#\s*/, '')
        .replace(series ? new RegExp(`^${escapeRe(series)}\\s*#\\S*\\s*`) : /(?!)/, '')
        .trim();
    if (!title) return ['タイトルがありません'];

    // 型は「（困っていること）」（持ち味）アプリ「名前」。
    // 鉤かっこが2組あることだけを見る。中身の良し悪しは編集者役が見る。
    const quotes = (title.match(/[「」]/g) ?? []).length;
    if (quotes < 4) {
        problems.push(
            `タイトルの型に合っていません（${style?.titleShape ?? ''}）。` +
                `読み手が困っていることと、アプリ名を鉤かっこで置いてください: 「${title}」`
        );
    }
    // 実例は連載名を除いて44字。50字あれば型どおり書ける。
    if (title.length > 50) {
        problems.push(`タイトルが長すぎます（連載名を除いて${title.length}字）。50字までにしてください`);
    }
    return problems;
}

function escapeRe(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 資料に無い数字を書いていないか。
 *
 * 「約11,800問」のような数字は、README が古いままだと平気で嘘になる。
 * 実例の書き手は、アプリを開いて数えなおして 12,796 問に直していた。
 * ここでは「渡した資料に出てこない数字」を挙げるところまでやる。
 * 落とすかどうかは呼び出し側が決める（年号や『三つ』のような言葉まで
 * 拾ってしまうので、機械の判断を最終決定にしない）。
 *
 * @param {string} markdown
 * @param {string} sourceText  プロフィールなど、渡した資料をつないだもの
 * @returns {string[]} 資料に見つからなかった数字
 */
/**
 * 数量が漢数字で書かれていないか（A10）。
 *
 * 連載は note でも giga-school.com でも横書きで読まれる。数えた値は算用数字の
 * ほうが目に入る。公開ずみ 32 本を数えたところ「四桁」12 件と「3桁」6 件、
 * 「十秒」6 件と「10秒」44 件が混ざっていた。決まりが無かったためである。
 *
 * ⚠️ lintArticle には入れない。あそこの返り値は generate-note.mjs が
 *    「書きなおさせる理由」に使うので、表記の指摘で節ごと書きかえさせてしまう。
 *    unsourcedNumbers と同じで、落とさずに知らせるだけにする。
 *
 * ⚠️ 一・二で始まる単独の数は見ない。「一度」「一人」「一つ」「一覧」「一歩」
 *    「二人」と、数を数えていない言葉がそこに集まっていて、拾うと嘘の警告の
 *    ほうが多くなる。そのぶん「二手先」のような本物も素通りする。
 *    「二十五種類」のように 2 文字以上つながるものは拾う。
 *
 * @param {string} markdown
 * @param {object} style  config/note-style.json
 * @returns {string[]} 算用数字にしたほうがよい語（重複は 1 つにまとめる）
 */
export function kanjiQuantities(markdown, style) {
    const rule = style?.forbidden?.kanjiNumerals;
    const counters = rule?.counters ?? [];
    if (counters.length === 0) return [];

    const KN = '[一二三四五六七八九十百千万]';
    const keep = rule?.keep ?? [];
    const keepRe = keep.length ? new RegExp(`^(?:${keep.join('|')})`) : null;
    const re = new RegExp(
        `(?<![一二三四五六七八九十百千万何])(?:[一二]${KN}+|[三四五六七八九十百千万]${KN}*)(?:${counters.join('|')})`,
        'g'
    );

    const text = String(markdown ?? '').replace(IMAGE_RE, '');
    const seen = new Set();
    const out = [];
    for (const hit of text.matchAll(re)) {
        if (keepRe && keepRe.test(text.slice(hit.index))) continue;
        if (seen.has(hit[0])) continue;
        seen.add(hit[0]);
        out.push(hit[0]);
    }
    return out;
}

export function unsourcedNumbers(markdown, sourceText) {
    const source = String(sourceText ?? '').replace(/[,，]/g, '');
    const seen = new Set();
    const out = [];

    for (const hit of String(markdown ?? '').replace(IMAGE_RE, '').matchAll(/\d[\d,，]*/g)) {
        const raw = hit[0];
        const plain = raw.replace(/[,，]/g, '');
        // 1桁は「三つのいいこと」「一つ目」のような言い回しに紛れる。見ない。
        if (plain.length < 2 || seen.has(plain)) continue;
        seen.add(plain);
        if (!source.includes(plain)) out.push(raw);
    }
    return out;
}
