#!/usr/bin/env node
/**
 * lint-manual.mjs — 使い方マニュアルの書式を見る
 *
 *   node lint-manual.mjs docs/manual/manual.md
 *   node lint-manual.mjs docs/manual/manual.md --json
 *
 * 見るのは「機械が頼っているところ」だけ。文章の良し悪しは見ない。
 *
 * ── なぜ要るのか ────────────────────────────────
 *
 * このファイルは giga-school.com/apps/<slug>/manual/ に毎朝組み直される。
 * 見出しの並びから目次と検索の索引が作られ、画像の書き方から画面写真の
 * 出し先が決まる。**外しても、手元では何も起きない。** 気づくのは翌朝、
 * 公開されたページが崩れてからになる。
 *
 * ⚠️ 落とすのは「機械が拾えなくなるもの」だけにする。書き方の好みで
 *    落とすと、書き手はこの検査を通さなくなる。
 */
import { readFileSync } from 'node:fs';

/** ## の並び。references/format.md と同じもの。ここが正本。 */
export const SECTIONS = ['はじめに', 'さいしょに', '画面の見かた', 'できること', 'こまったとき'];

/** 機械が足す節。手で書かれていたら止める（/filtering/ と食い違うため） */
const MACHINE_SECTIONS = ['学校で使うときは', '学校で使うときの準備', '変わったこと', '更新履歴'];

/** キャプションと見分けられる長さ。tools/lib/article-md.mjs の CAPTION_MAX_CHARS と同じ */
const CAPTION_MAX = 120;

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const ORDERED = /^\s*\d+\.\s/;

/**
 * @param {string} md マニュアルの中身
 * @returns {{level: 'error'|'warn', line: number, message: string}[]}
 */
export function lintManual(md) {
  const out = [];
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const say = (level, line, message) => out.push({ level, line, message });

  /* 囲み（```）の中は本文ではない。手順の例を書けなくなるので飛ばす */
  const fenced = new Set();
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; fenced.add(i); return; }
    if (inFence) fenced.add(i);
  });

  const heads = [];
  lines.forEach((l, i) => {
    if (fenced.has(i)) return;
    const m = HEADING.exec(l);
    if (m) heads.push({ level: m[1].length, text: m[2], line: i + 1 });
  });

  /* --- 題 ------------------------------------------------------- */
  const h1 = heads.filter((h) => h.level === 1);
  if (h1.length === 0) say('error', 1, '題（# ではじまる行）が無い。ページの題になる');
  if (h1.length > 1) {
    h1.slice(1).forEach((h) => say('error', h.line, `# は 1 本だけ。2 本目は ## にする（「${h.text}」）`));
  }
  if (h1.length && h1[0].line !== heads[0]?.line) {
    say('error', h1[0].line, '# は、いちばん最初の見出しにする');
  }

  /* --- ## の並び ------------------------------------------------ */
  const h2 = heads.filter((h) => h.level === 2);
  const names = h2.map((h) => h.text);

  for (const bad of MACHINE_SECTIONS) {
    const hit = h2.find((h) => h.text.includes(bad));
    if (hit) {
      say('error', hit.line,
        `「${bad}」は書かない。data/apps.json と docs/CHANGELOG.md から機械が足す。`
        + '手で書くと giga-school.com/filtering/ と食い違う');
    }
  }

  const missing = SECTIONS.filter((s) => !names.includes(s));
  if (missing.length) {
    say('error', 1, `## が足りない → ${missing.join('・')}（空でも節ごと消さない。`
      + '「準備は要りません」と書けるので、無いことも情報になる）');
  }

  const extra = names.filter((n) => !SECTIONS.includes(n) && !MACHINE_SECTIONS.some((m) => n.includes(m)));
  extra.forEach((n) => {
    const hit = h2.find((h) => h.text === n);
    say('error', hit.line, `知らない ## 「${n}」。増やすものは ### にする`
      + `（使えるのは ${SECTIONS.join('・')}）`);
  });

  /* 並び順。目次と索引がこの順を前提にしている */
  const known = names.filter((n) => SECTIONS.includes(n));
  const wanted = SECTIONS.filter((s) => known.includes(s));
  if (known.join('>') !== wanted.join('>')) {
    say('error', h2[0]?.line ?? 1,
      `## の並びが違う。${wanted.join(' → ')} の順にする（いまは ${known.join(' → ')}）`);
  }

  /* --- ### は「できること」と「こまったとき」の中だけ ------------- */
  let current = '';
  for (const h of heads) {
    if (h.level === 2) current = h.text;
    if (h.level >= 3 && !['できること', 'こまったとき', 'さいしょに'].includes(current)) {
      say('warn', h.line, `### は「できること」「こまったとき」「さいしょに」の中で使う（いまは「${current || '題の直後'}」の中）`);
    }
  }

  /* 本体が空のマニュアルを公開しない */
  const canDo = heads.filter((h, i) => h.level >= 3
    && heads.slice(0, i).reverse().find((x) => x.level === 2)?.text === 'できること');
  if (names.includes('できること') && canDo.length === 0) {
    say('error', h2.find((h) => h.text === 'できること').line,
      '「できること」の中に ### が 1 つも無い。機能をひとつずつ並べるのがマニュアルの本体');
  }

  /* --- 画像 ----------------------------------------------------- */
  let images = 0;
  lines.forEach((l, i) => {
    if (fenced.has(i)) return;
    const at = i + 1;

    if (/!\[[^\]]*\]\([^)]*\)/.test(l) && !IMAGE_LINE.test(l)) {
      say('error', at, '画像は 1 行に 1 枚、行頭から書く。文の中に混ぜたものは拾われない');
      return;
    }
    const m = IMAGE_LINE.exec(l);
    if (!m) return;
    images++;
    const [, alt, src] = m;
    if (!alt.trim()) say('error', at, 'alt を空にしない。読み上げと、ページの説明に使う');
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) {
      say('error', at, `画像は images/ の相対指定にする（いまは ${src}）。外のアドレスは渡せない`);
    } else if (!src.startsWith('images/')) {
      say('error', at, `画像は images/ に置く（いまは ${src}）`);
    }

    /* 番号つき手順の途中に画像を置くと、article-md.mjs の解析でリストが切れて
       番号が 1 に戻る。手元の Markdown 表示では気づけない */
    const before = lines.slice(0, i).reverse().find((x) => x.trim() !== '');
    const after = lines.slice(i + 1).find((x) => x.trim() !== '');
    if (ORDERED.test(before ?? '') && ORDERED.test(after ?? '')) {
      say('error', at, '番号つき手順の途中に画像を置かない。ここで番号が 1 に戻る。'
        + '手順の前か、手順を終えてから置く');
    }

    /* キャプションは、画像の直後の「1 行だけの段落」で、120 字まで
       （tools/lib/article-md.mjs の looksLikeCaption と同じ条件）。
       ⚠️ 直後の段落すべてを見ない。画像のあとにふつうの本文が続くのは当たり前で、
          それを毎回警告すると、この検査を誰も読まなくなる。
          「キャプションのつもりで書いたのに、少しだけ長い」ところだけを言う。 */
    const nextAt = lines.findIndex((x, j) => j > i && x.trim() !== '');
    const next = nextAt === -1 ? '' : lines[nextAt].trim();
    const alone = nextAt !== -1 && (lines[nextAt + 1] ?? '').trim() === '';
    const plain = next && !HEADING.test(next) && !IMAGE_LINE.test(next)
      && !ORDERED.test(next) && !/^\s*[-*]\s/.test(next) && !/^\s*```/.test(next);
    if (plain && alone && next.length > CAPTION_MAX && next.length <= CAPTION_MAX * 2) {
      say('warn', nextAt + 1, `画像の直後の 1 段落が ${next.length} 字。`
        + `${CAPTION_MAX} 字までならキャプションとして画像に添うが、超えると`
        + 'ふつうの本文になる（写真から離れて出る）');
    }
  });
  if (images === 0) {
    say('error', 1, '画面写真が 1 枚も無い。「どのボタンを押せば何ができるか」を'
      + '伝えるのがマニュアルなので、文章だけでは公開しない');
  }

  /* --- 組み立てが扱わない書き方 ---------------------------------- */
  lines.forEach((l, i) => {
    if (fenced.has(i)) return;
    const at = i + 1;
    if (/^\s*\|.*\|\s*$/.test(l)) say('error', at, '表は組み立てが扱わない。箇条書きにする');
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) say('error', at, '水平線は組み立てが扱わない');
    if (/\*\*[^*]+\*\*/.test(l)) say('warn', at, '太字は使わない。強調は「」で足りる');
  });

  return out;
}

/* --- ここから下は道具として呼ばれたときだけ ---------------------- */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('使い方: node lint-manual.mjs docs/manual/manual.md [--json]');
    process.exit(2);
  }
  let md;
  try {
    md = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`読めない: ${file}（${e.code}）`);
    process.exit(2);
  }
  const found = lintManual(md);
  const errors = found.filter((f) => f.level === 'error');

  if (asJson) {
    console.log(JSON.stringify({ file, ok: errors.length === 0, found }, null, 1));
  } else {
    for (const f of found) {
      console.log(`${f.level === 'error' ? '  NG  ' : '  警告'} ${file}:${f.line}  ${f.message}`);
    }
    console.log(errors.length === 0
      ? `\n✅ ${file} は組み立てられる形です（警告 ${found.length - errors.length} 件）`
      : `\n❌ ${errors.length} 件 直してください`);
  }
  process.exit(errors.length === 0 ? 0 : 1);
}
