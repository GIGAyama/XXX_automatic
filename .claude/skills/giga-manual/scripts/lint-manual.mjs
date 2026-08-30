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

/**
 * 中身の無い見出し。これだけでは何の説明か分からないので落とす。
 *
 * ⚠️ 2026-08-29 まで、この検査は「## は はじめに／さいしょに／画面の見かた／
 *    できること／こまったとき の 5 つだけ」と決め打ちしていた。理由として
 *    「機械がこの並びを前提に目次と索引を作る」と書いてあったが、それは誤りだった。
 *    目次も索引も見出しの**位置**（s-1, s-2）しか見ておらず、名前は一度も見ていない。
 *
 *    害のほうが大きかった。5 つに押しこむと、機能がいくつあっても全部が
 *    「できること」の下にぶら下がる。週案エディタでは 16 機能がそうなっていた。
 *    いまは章立てを自由にし、代わりに**名前の質**を見る。
 */
const EMPTY_NAMES = [
  'できること', 'その他', 'そのほか', '機能', '応用', 'いろいろ', '補足', 'メモ',
  'はじめに以外', '各種機能', 'その他の設定', 'まとめ',
];

/** 見出しの短さの下限。参照マニュアルの見出しは平均 14.8 字ある。 */
const HEADING_MIN = 5;

/** 短くても意味の通る、決まりきった名前。参照マニュアルも「1. はじめに」を使っている。 */
const CONVENTIONAL = ['はじめに', 'おわりに', 'まとめ以外'];

/** 機械が足す節。手で書かれていたら止める（/filtering/ と食い違うため） */
const MACHINE_SECTIONS = ['学校で使うときは', '学校で使うときの準備', '変わったこと', '更新履歴'];

/** キャプションと見分けられる長さ。tools/lib/article-md.mjs の CAPTION_MAX_CHARS と同じ */
const CAPTION_MAX = 120;

/** ここまでなら、本当に写真の説明。これを超えるものは本文の可能性が高い。 */
const CAPTION_SHORT = 45;

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

  /* 章が少なすぎる。機能ごとに章を立てていない形になっている */
  if (h2.length < 3) {
    say('error', h2[0]?.line ?? 1,
      `章（##）が ${h2.length} つしかない。機能のまとまりごとに章を立てる`
      + '（基準にした実物のマニュアルは 10 章 25 節）');
  }

  /* 見出しの名前の質。「見出しだけを並べて、何の説明か分かる」が唯一の基準 */
  for (const h of heads) {
    if (h.level < 2) continue;
    const name = h.text.replace(/^[【（(]?[!！重要①-⑳\s]*[】）)]?\s*/, '').trim();
    if (EMPTY_NAMES.includes(name)) {
      say('error', h.line,
        `「${h.text}」だけでは何の説明か分からない。`
        + '何を・どうするのかが分かる名前にする（例「週案のセルから単元を選ぶ」）');
      continue;
    }
    if (name.length < HEADING_MIN && !CONVENTIONAL.includes(name)) {
      say('warn', h.line,
        `見出し「${h.text}」が ${name.length} 字と短い。`
        + '目次に並べたときに中身が分かるか確かめる');
    }
  }

  /* 括弧は全角にそろえる。見出しの括弧は目次にも検索結果にも並ぶので、
     本文の中の揺れより目につく。基準にした実物のマニュアルは、目次の
     1 ページの中で「（週案の表示）」と「(メニュー操作)」が混ざっていた。 */
  for (const h of heads) {
    if (h.level >= 2 && /[()]/.test(h.text)) {
      say('warn', h.line,
        `見出しの括弧を全角（）にする（「${h.text}」）。`
        + '見出しは目次と検索結果に並ぶので、半角と混ざると目につく');
    }
  }

  /* 目印を乱発しない。全部に付けると、どれも目に入らなくなる。
     基準にした実物のマニュアルは 35 見出しのうち【重要】2 本・【！！】1 本だけ。 */
  const marked = heads.filter((h) => h.level >= 2 && /【(?:重要|！！)】/.test(h.text));
  if (marked.length > Math.max(3, Math.round(heads.length * 0.15))) {
    say('warn', marked[0].line,
      `【重要】【！！】の付いた見出しが ${marked.length} 本ある（見出しは全 ${heads.length} 本）。`
      + 'ページ側で色が付くのは、少ないから効く。本当に飛ばすと困るものだけに残す');
  }

  /* 見出しの中でルビ（ふりがな）を使わない。
     本文では使える（組み立てが <ruby> <rt> <rp> だけを通す）が、目次は
     ページの HTML からタグを落として文字だけを取るので
     （tools/lib/article-toc.mjs の textOf）、見出しに振ると目次と検索結果で
     「学年」が「学がく年ねん」になる。本文とちがって、書いた本人の画面では
     正しく見えるため、公開ページの目次を見るまで気づけない。 */
  for (const h of heads) {
    if (h.level >= 2 && /<ruby>/i.test(h.text)) {
      say('warn', h.line,
        `見出しの中でルビを使わない（「${h.text}」）。`
        + '目次はタグを落として文字だけにするので、「学年」が「学がく年ねん」になる。'
        + '本文では使ってよい');
    }
  }

  /* 見出しに自分で番号を振らない。ページ側の目次が振るので二重になる */
  for (const h of heads) {
    /* 「1. 」「1、」と「3.1 」「3.1. 」を拾う。
       ⚠️ ただの数字ではじまる見出し（「2 学期のはじめにすること」）は通す。
          点が無ければ、それは番号ではなく言葉の一部である。 */
    const NUMBERED = /^\s*(?:\d+[.、][ \u3000]|\d+(?:\.\d+)+[.、]?[ \u3000])/;
    if (h.level >= 2 && NUMBERED.test(h.text)) {
      say('error', h.line,
        `見出しに番号を書かない（「${h.text}」）。ページの目次が自動で振るので二重になる`);
    }
  }

  /* 読む前に用意するものが書かれているか。ここが抜けていると、
     読み手は最初の 1 行で止まる（参照マニュアル 1.3 にあたる） */
  const body = lines.filter((l, i) => !fenced.has(i)).join('\n');
  if (!/用意|準備|お手元|必要なもの|そろえ/.test(body)) {
    say('warn', 1,
      '読む前に用意するもの（端末・アカウント・URL・権限）が見あたらない。'
      + '手元に何が要るかが分からないと、最初の 1 行で止まる');
  }

  /* 章が大きくなりすぎていないか。節が多すぎる章は、章を割るべき形になっている */
  const perChapter = new Map();
  let cur = null;
  for (const h of heads) {
    if (h.level === 2) { cur = h; perChapter.set(h, []); continue; }
    if (h.level >= 3 && cur) perChapter.get(cur).push(h);
  }
  for (const [chapter, subs] of perChapter) {
    /* ⚠️ しきい値をきつくしない。「こまったとき」のように、同じ種類のものが
       9 つ並ぶ章は正しい形である（症状ごとに引けるほうがよい）。
       止めたいのは「機能を 16 個ぶら下げた 1 章」のほうなので、そこだけ鳴る値にする。 */
    if (subs.length > 10) {
      say('warn', chapter.line,
        `「${chapter.text}」に節が ${subs.length} つある。`
        + '同じ種類のものが並んでいるなら、このままでよい。'
        + '別々の機能が並んでいるなら、機能のまとまりで章を割る');
    }
  }

  /* 目次の総量。article-toc.mjs は章と節を全部並べ、開いた状態で出す。
     基準にした実物のマニュアルは 10 章 25 節 = 35 行で、ちょうど 1 ページだった。

     ⚠️ 狭い画面で目次が本文の前に積まれる件は、ページ側で高さを止めて解いてある
        （assets/style.css の .manual .article__rail .toc__list）。
        だからここで見ているのは**目で追えるか**だけになる。

     ⚠️ しきい値を 35 に寄せないこと。基準にした実物のマニュアルが 35 行なのは、
        相手が単純なアプリだったからで、機能を 16 個持つアプリなら 60 行を超える。
        「細かく節に割ってほしい」というのが、そもそもこの書式の出発点だった。
        その倍（70）を、明らかに割りすぎている線として置く。 */
  const tocLines = heads.filter((h) => h.level === 2 || h.level === 3).length;
  if (tocLines > 70) {
    say('warn', 1,
      `目次に並ぶ行が ${tocLines} 行ある（章 ${h2.length}・節 ${tocLines - h2.length}）。`
      + '目で追いきれる量を超えている。同じ話の節を 1 つにまとめられないか見直す');
  }

  /* 章の重さ。印刷すると章の頭で必ず改ページする
     （assets/style.css の .manual .prose--article h2 { break-before: page }）。
     薄い章が並ぶと、刷ったときに半分白いページがその数だけ出る。
     ⚠️ 1 つだけなら正しい形なので鳴らさない（実物のマニュアルの 8 章は節が 1 つ）。 */
  const h2Lines = new Map();
  let curH2 = null;
  lines.forEach((l, i) => {
    const m = fenced.has(i) ? null : HEADING.exec(l);
    if (m && m[1].length === 2) { curH2 = { text: m[2], line: i + 1 }; h2Lines.set(curH2, 0); return; }
    if (curH2 && l.trim() !== '') h2Lines.set(curH2, h2Lines.get(curH2) + 1);
  });
  /* ⚠️ 短いマニュアルでは鳴らさない。全体が紙 2〜3 枚なら、章が薄いのは
     当たり前で、直しようもない。冊子として刷る大きさになってから言う。 */
  const bodyLines = [...h2Lines.values()].reduce((a, b) => a + b, 0);
  const thin = bodyLines < 150 ? [] : [...h2Lines].filter(([, n]) => n < 15);
  if (thin.length >= 3) {
    say('warn', thin[0][0].line,
      `中身が 15 行に満たない章が ${thin.length} つある（「${thin.map(([c]) => c.text).join('」「')}」）。`
      + '印刷すると章の頭で改ページするので、そのぶん半分白いページが出る。'
      + '隣の章に畳むか、足りていないもの（前提・つまずき・押した結果）を書く');
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
    /* ⚠️ alt に ] を書くと、この検査も組み立ても揃って**黙って見落とす**。
       どちらの正規表現も alt を [^\]]* で取るので、行そのものが画像として
       拾われず、`![…](images/…)` という字がそのまま本文に印字される。
       検査が何も言わないのがいちばん悪いので、ここで拾う。 */
    if (!IMAGE_LINE.test(l) && /^\s*!\[/.test(l)) {
      say('error', at, '画像の書き方が壊れている。alt に ] を入れない、字下げしない、'
        + '行頭から `![説明](images/01-home.png)` の形で書く');
      return;
    }
    const m = IMAGE_LINE.exec(l);
    if (!m) return;
    images++;
    const [, alt, src] = m;
    if (!alt.trim()) say('error', at, 'alt を空にしない。読み上げと、ページの説明に使う');
    /* ⚠️ 空白の入ったファイル名は、この検査だけが通してしまう形だった。
       組み立て（tools/lib/article-md.mjs の IMAGE_RE）は宛先を [^)\s]+ で取るので、
       `![あ](images/03 input.png)` は `images/03` を指す。残りは捨てられる。
       検査は ([^)]+) で取っていたため通り、公開ページで画像だけが割れていた。 */
    if (/\s/.test(src)) {
      say('error', at, `画像の名前に空白を入れない（いまは ${src}）。`
        + `組み立ては空白の手前（${src.split(/\s/)[0]}）までしか読まないので、画像が割れる`);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) {
      say('error', at, `画像は images/ の相対指定にする（いまは ${src}）。外のアドレスは渡せない`);
    } else if (!src.startsWith('images/')) {
      say('error', at, `画像は images/ に置く（いまは ${src}）`);
    }

    /* ⚠️ 2026-08-29 まで、ここは「番号つき手順の途中に画像を置かない」を
       落としていた。組み立てがそこで番号を切っていたためだが、押す場所の写真は
       手順のあいだにあるのがいちばん自然なので、組み立ての側を直した
       （tools/lib/article-md.mjs が <ol start="N"> で続ける）。検査からは外す。

       ただし続くのは「画像と、その説明文だけ」をはさんだときに限るので、
       手順のあいだにふつうの段落を置いたときだけ、番号が戻ることを知らせる。 */
    const before = lines.slice(0, i).reverse().find((x) => x.trim() !== '');
    if (ORDERED.test(before ?? '')) {
      const rest = lines.slice(i + 1);
      const nextAt2 = rest.findIndex((x) => x.trim() !== '');
      const next2 = nextAt2 === -1 ? '' : rest[nextAt2].trim();
      const isCaption = next2 && !HEADING.test(next2) && !IMAGE_LINE.test(next2)
        && !ORDERED.test(next2) && next2.length <= CAPTION_MAX;
      const after2 = isCaption
        ? rest.slice(nextAt2 + 1).find((x) => x.trim() !== '') ?? ''
        : next2;
      const breaks = after2 && !ORDERED.test(after2) && !HEADING.test(after2)
        && !IMAGE_LINE.test(after2) && after2.trim().length > CAPTION_MAX;
      /* ⚠️ 手順がそこで終わっているなら、何も壊れていない。
         この先に続きの手順があるときだけ言う。終わった手順のあとに
         ふつうの段落を書くのは当たり前のことなので、そこで鳴らすと
         警告が薄まって、本物のほうを読み飛ばされる。 */
      const continues = breaks && rest.slice(nextAt2 + 1)
        .slice(0, rest.slice(nextAt2 + 1).findIndex((x) => HEADING.test(x.trim())) + 1 || undefined)
        .some((x) => ORDERED.test(x));
      if (continues) {
        say('warn', at, '手順のあいだに置けるのは、画像と 120 字までの説明文だけ。'
          + 'それより長い段落を置いたので、この先の手順の番号が 1 に戻る');
      }
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

    /* ⚠️ 裏返しの事故。画像の直後の 1 行 120 字までの段落は、組み立てが
       説明文とみなして**本文から外す**（article-md.mjs の looksLikeCaption）。
       そこに節の中身を書くと、一段落まるごと写真の下の添え字に降格する。

       2026-08-29 に週案エディタのマニュアルで 6 か所起きた。
       「15 時を過ぎてからアプリを開くと…」というその節の中身が添え字になり、
       見出しの直後がいきなり写真になっていた。公開ページを見るまで気づけない。

       45 字を境にしているのは、それより短いものは実際に写真の説明だから。 */
    /* ⚠️ 短くても本文のものがある。手順を開くラベル行（「印刷の手順:」）と、
       箱の見出し（「【！】覚えておいていただきたいこと:」）がそれで、
       どちらも 20 字ほどしかないので上の 45 字では拾えない。
       2026-08-29、週案エディタのマニュアルで実際に添え字へ降格していた。 */
    const LABEL = /[:：]\s*$|^【/;
    if (plain && alone && LABEL.test(next)) {
      say('warn', nextAt + 1,
        `画像の直後の「${next}」は、写真の説明とみなされて本文から外れる。`
        + 'ラベル行や箱の見出しなら、画像より前に移すか、あいだに写真を見るための一言を置く');
    }
    if (plain && alone && !LABEL.test(next)
      && next.length > CAPTION_SHORT && next.length <= CAPTION_MAX) {
      say('warn', nextAt + 1, `画像の直後の 1 段落が ${next.length} 字。`
        + 'ここに書いたものは写真の説明とみなされ、本文から外れて添え字になる。'
        + '節の中身なら、画像より前に移すこと');
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
