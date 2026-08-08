/*
 * 投稿ランチャー。
 *
 * このシステムでいちばん大事な部分。
 * 用意された投稿を、スマホから最小の手数で X と note に出すためだけの画面である。
 *
 * ── X に画像つきで出すしくみ ──────────────────────────
 *
 * X の Web Intent（x.com/intent/post）は本文を入れられるが、画像を添付できない。
 * X API は 2026年2月に無料枠が廃止されていて、使うと投稿ごとに課金される。
 *
 * 残った道が Web Share API である。
 *   navigator.share({ files: [画像], text: 本文 })
 * を呼ぶと OS の共有シートが開き、そこで X を選ぶと
 * 「画像が添付され、本文が入った状態」の投稿画面が立ち上がる。
 * あとは投稿ボタンを押すだけ。API も課金も要らない。
 *
 * 添付する画像は選べる。紹介カード（このリポジトリで作ったもの）のほかに、
 * アプリのリポジトリに置いてある画像 — note の記事のために実際に操作して撮ったもの —
 * が候補に出る。実物は raw.githubusercontent.com から直接読む（リポジトリに取り込むと
 * 毎週のコミットが重くなるため）。選んだ結果は端末の localStorage に残る。
 *
 * ただし3つ気をつける点がある。
 *
 * 1. ユーザー操作の直後でないと share() は拒否される。
 *    ボタンを押してから画像を fetch していると、その待ち時間で
 *    「操作の直後」ではなくなり、iOS で失敗することがある。
 *    そのため画像は表示した時点で先に読みこんでおく（prefetchMedia）。
 *
 * 2. iOS では files と text を一緒に渡すと text が落ちることがある。
 *    そのため share() を呼ぶ前に必ずクリップボードにも本文を入れておく。
 *    落ちても貼り付けで復旧できる。
 *
 * 3. 同じ理由が window.open にも当てはまる。
 *    await のあとに window.open を呼ぶと、iOS Safari のポップアップブロックに
 *    引っかかる。開くのを先、待つのを後、の順は崩さないこと。
 *
 * 表示の選択・状態の手入れ・反応の記録の形は lib/ に切り出してある。
 * ブラウザを立てずに node --test から検証できるようにするためである。
 */

import { jstDateString, jstStamp } from './lib/jst-client.js';
import { overLimitMessage, slotLabelMap, stepGuide, themeLabelMap, truncate } from './lib/format.js';
import { activeWeekIds, emptyMessageFor, selectPosts, summaryOf, unsentRatings, unsentRecords } from './lib/select.js';
import { STORAGE_KEY, applyPatch, pruneState, traceOf } from './lib/state.js';
import { MAX_WEIGHTED_LENGTH, weightedLength } from './lib/x-length.js';
import { buildIssueUrl, buildPayload, chunkEntries, newSubmissionId } from './lib/feedback-payload.js';
import {
  MAX_MEDIA,
  defaultSelection,
  fileNameFor,
  galleryOf,
  normalizeSelection,
  selectedItems,
  toggleSelection,
} from './lib/media-pick.js';

const DATA_URL = 'launcher.json';

/** @type {{posts: any[], notes: any[], weekIds?: string[], slots?: any[], repoUrl?: string, noteEditorUrl?: string, galleries?: object}} */
let data = { posts: [], notes: [] };
let view = 'today';

/**
 * 画像の URL → File。共有の直前に読みにいかないための先読み置き場。
 *
 * 投稿IDではなく URL で持つ。同じアプリの画像は別の投稿でも同じものを使うので、
 * 投稿ごとに持つと同じ絵を何度も読むことになる。
 */
const fileCache = new Map();
/** いま読んでいる最中のもの。共有のときに「まだ準備中」と「読めなかった」を分けるために要る。 */
const filePending = new Map();
/** 読めなかった画像。共有のときに「本文だけになります」と伝えるために覚えておく。 */
const mediaFailed = new Set();
/** 280字を超えたまま共有しようとした投稿。1度目は止めて、2度目で通す。 */
const overLimitWarned = new Set();

/* ────────────────────────────────────────────
 *  保存（この端末のなかだけ）
 * ──────────────────────────────────────────── */

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    // 壊れていても画面が出ないより、記録を捨てて動くほうがよい。
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    toast('この端末に記録できませんでした（プライベートモード？）');
  }
}

function patchState(id, patch) {
  const next = applyPatch(loadState(), id, patch);
  saveState(next);
  return next;
}

/* ────────────────────────────────────────────
 *  画面
 * ──────────────────────────────────────────── */

function todayJst() {
  return jstDateString();
}

function visiblePosts() {
  return selectPosts({
    posts: data.posts ?? [],
    state: loadState(),
    view,
    today: todayJst(),
    activeWeeks: activeWeekIds(data),
  });
}

/** その投稿の本文。手で直してあれば直したほうを使う。 */
function textOf(post, saved) {
  return typeof saved?.editedText === 'string' && saved.editedText.trim() ? saved.editedText : post.text;
}

/**
 * その投稿の連投の手順。手で直した本文があれば1コマ目に反映する。
 *
 * launcher.json が古くて steps を持たないときは、本文1コマとして扱う。
 * 画面側に「steps がある場合とない場合」の分岐を持ち込まないため。
 */
function stepsOf(post, saved) {
  const base = Array.isArray(post.steps) && post.steps.length > 0
    ? post.steps
    : [{ kind: 'main', label: '本文', text: post.text, weightedLength: post.weightedLength }];

  const edited = textOf(post, saved);
  return base.map((step, i) =>
    i === 0 && edited !== post.text
      ? { ...step, text: edited, weightedLength: weightedLength(edited) }
      : { ...step, weightedLength: step.weightedLength ?? weightedLength(step.text) }
  );
}

function render() {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (view === 'note') {
    renderNotes(list);
    updateSummary();
    return;
  }

  if (view === 'now') {
    renderNow(list);
    updateSummary();
    return;
  }

  const posts = visiblePosts();

  if (view === 'done') renderSendBar(list);

  if (posts.length === 0) {
    list.append(
      emptyBox(
        emptyMessageFor({
          view,
          posts: data.posts ?? [],
          state: loadState(),
          today: todayJst(),
          activeWeeks: activeWeekIds(data),
        })
      )
    );
    updateSummary();
    return;
  }

  const state = loadState();
  const today = todayJst();
  for (const post of posts) list.append(postCard(post, state[post.id] || {}, today));

  updateSummary();
  prefetchMedia(posts);
}

/**
 * 添付する画像を選ぶところ。
 *
 * アプリのリポジトリには、note の記事のために実際に操作して撮った画像が入っている。
 * 機械が撮りなおしたカードより中身が濃いので、そこから選べるようにする。
 *
 * 選んだ順に並べて渡す。X は4枚まで。上限に当たったときは黙って無視せず理由を出す
 * （反応が無いと「押せていないのか、壊れているのか」が区別できない）。
 */
function mediaPicker(post, gallery, chosen) {
  const box = document.createElement('div');
  box.className = 'picker';

  const head = document.createElement('p');
  head.className = 'picker__head';
  head.textContent = `添付する画像（${chosen.length}/${MAX_MEDIA}）`;
  box.append(head);

  const strip = document.createElement('div');
  strip.className = 'picker__strip';

  const order = new Map(chosen.map((item, i) => [item.id, i + 1]));

  for (const item of gallery) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'picker__cell' + (order.has(item.id) ? ' is-on' : '');
    cell.setAttribute('aria-pressed', order.has(item.id) ? 'true' : 'false');
    cell.setAttribute('aria-label', `${item.label}を${order.has(item.id) ? '外す' : '添付する'}`);

    const img = document.createElement('img');
    img.src = item.src;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      mediaFailed.add(item.src);
      cell.classList.add('is-broken');
      cell.title = '読み込めませんでした';
    });
    cell.append(img);

    const badge = document.createElement('span');
    badge.className = 'picker__badge';
    badge.textContent = order.get(item.id) ?? '';
    cell.append(badge);

    const caption = document.createElement('span');
    caption.className = 'picker__label';
    caption.textContent = item.label;
    cell.append(caption);

    cell.addEventListener('click', () => {
      const saved = loadState()[post.id] || {};
      const result = toggleSelection(saved.media, item.id, gallery);
      if (result.reason === 'max') {
        toast(`画像は${MAX_MEDIA}枚までです。どれかを外してから選んでください`);
        return;
      }
      patchState(post.id, { media: result.selected, ...traceOf(post) });
      // 選んだ瞬間に読みはじめる。共有ボタンを押してから読むと、
      // その待ち時間で「操作の直後」ではなくなり iOS で share() が拒否される。
      if (result.selected.includes(item.id)) loadMediaFile(post, item, result.selected.indexOf(item.id));
      render();
    });

    strip.append(cell);
  }

  box.append(strip);

  // 既定（紹介カードだけ）に戻す道を残す。選びなおすうちに分からなくなったとき、
  // 元に戻せないと「とりあえず全部外す」しかなくなる。
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'picker__reset';
  reset.textContent = '紹介カードだけに戻す';
  reset.addEventListener('click', () => {
    patchState(post.id, { media: defaultSelection(gallery), ...traceOf(post) });
    render();
  });
  box.append(reset);

  return box;
}

function emptyBox(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function postCard(post, saved, today) {
  const card = document.createElement('article');
  card.className = 'card' + (saved.done ? ' is-done' : '');

  const text = textOf(post, saved);
  const length = weightedLength(text);

  // ── 見出し（日付・枠・型・文字数）──
  const meta = document.createElement('div');
  meta.className = 'card__meta';
  meta.append(
    post.date
      ? chip(`${formatDate(post.date)}（${post.weekday}）${post.slotLabel}`, post.date === today ? 'chip--today' : '')
      : chip('予備'),
    chip(post.themeLabel),
    chip(post.repo)
  );
  const lenChip = chip(`${length}/${MAX_WEIGHTED_LENGTH}`, 'chip--len' + (length > MAX_WEIGHTED_LENGTH ? ' is-over' : ''));
  meta.append(lenChip);
  // 出しなおしだと分かるようにする。黙って出すと「前も見た気がする」が
  // 「同じものを二度出してしまったのでは」という不安になる。
  if (post.reprise) meta.append(chip(`出しなおし（${formatDate(post.reprise.ofDate)}）`, 'chip--reprise'));
  if (saved.editedText) meta.append(chip('手直しずみ', 'chip--edited'));
  card.append(meta);

  // ── 画像 ──
  // 上に「いま添付されるもの」、下に「選べるもの」。
  // 選んだ結果がそのまま大きく出ていないと、投稿してから気づくことになる。
  const gallery = galleryFor(post);
  const shots = selectedItems(gallery, saved.media);
  if (shots.length > 0) {
    const figure = document.createElement('div');
    figure.className = 'card__shots' + (shots.length > 1 ? ' is-multi' : '');
    for (const [i, item] of shots.entries()) {
      const img = document.createElement('img');
      img.className = 'card__img';
      img.src = item.src;
      img.alt = shots.length > 1 ? `${item.label}（${i + 1}枚目）` : item.label;
      img.loading = 'lazy';
      img.decoding = 'async';
      // 画像が欠けていると壊れたアイコンだけが出て、原因が分からない。
      // 何が起きたのかを画面に書く。共有そのものは本文だけで続けられる。
      img.addEventListener('error', () => {
        mediaFailed.add(item.src);
        const box = document.createElement('div');
        box.className = 'card__img card__img--missing';
        box.textContent = '画像を読み込めませんでした（本文だけで共有できます）';
        img.replaceWith(box);
      });
      figure.append(img);
    }
    card.append(figure);
  }

  // 候補が紹介カード1枚しか無いなら、選ぶところは出さない（押すものが増えるだけになる）。
  if (gallery.length > 1) card.append(mediaPicker(post, gallery, shots));

  // ── 連投の手順 ──
  // ①本文 → ②つづき → ③リンクの返信、の順に1コマずつ出す。
  // 全部いっぺんに並べると、どれをいま貼るのかが分からなくなる。
  const steps = stepsOf(post, saved);
  const at = Math.min(saved.step ?? 0, steps.length - 1);
  const step = steps[at];

  if (steps.length > 1) {
    const nav = document.createElement('div');
    nav.className = 'steps';
    for (const [i, s] of steps.entries()) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'steps__dot' + (i === at ? ' is-on' : '') + (i < at ? ' is-done' : '');
      dot.textContent = `${i + 1}. ${s.label}`;
      dot.setAttribute('aria-label', `${i + 1}コマ目 ${s.label}へ`);
      dot.addEventListener('click', () => {
        patchState(post.id, { step: i, ...traceOf(post) });
        render();
      });
      nav.append(dot);
    }
    card.append(nav);

    const guide = document.createElement('p');
    guide.className = 'steps__guide';
    guide.textContent = stepGuide(step, at, steps.length);
    card.append(guide);
  }

  // ── 本文（その場で直せる）──
  const body = document.createElement('p');
  body.className = 'card__text';
  body.textContent = step.text;
  card.append(body);

  // ── ボタン ──
  const actions = document.createElement('div');
  actions.className = 'card__actions';

  if (step.kind === 'main') {
    const shareBtn = button(shots.length > 0 ? '𝕏 に共有（画像つき）' : '𝕏 に共有', 'btn btn--x');
    shareBtn.addEventListener('click', () => shareToX(post, shareBtn, step, steps.length));
    actions.append(shareBtn);

    const copyBtn = button('コピーして X を開く', 'btn btn--sub');
    copyBtn.addEventListener('click', () => openIntent(post, step));
    actions.append(copyBtn);
  } else {
    // 返信は共有シートからは出せない（共有すると新しい投稿になってしまう）。
    // 本文をクリップボードに入れて、X で「返信」を押してから貼ってもらう。
    const copyBtn = button('この文をコピーする', 'btn btn--x');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(step.text);
      toast(ok ? 'コピーしました。X で返信を押して貼り付けてください' : 'コピーできませんでした。長押しで選んでください');
    });
    actions.append(copyBtn);

    const openBtn = button('X で自分の投稿を開く', 'btn btn--sub');
    openBtn.addEventListener('click', () => {
      // ⚠️ window.open を同期で先に。await のあとだと iOS で開かない。
      window.open(myTimelineUrl(), '_blank', 'noopener');
      copyText(step.text);
    });
    actions.append(openBtn);
  }

  if (at < steps.length - 1) {
    const nextBtn = button(`次へ（${steps[at + 1].label}）`, 'btn btn--sub btn--next');
    nextBtn.addEventListener('click', () => {
      patchState(post.id, { step: at + 1, ...traceOf(post) });
      render();
    });
    actions.append(nextBtn);
  }

  if (step.kind === 'main') {
    const editBtn = button(saved.editedText ? '本文を直す（手直しずみ）' : '本文を直す', 'btn btn--sub');
    editBtn.addEventListener('click', () => openEditor(card, post, body, lenChip));
    actions.append(editBtn);

    if ((post.alternatives ?? []).length > 0) {
      const altBtn = button(`別の案（${post.alternatives.length}）`, 'btn btn--sub');
      altBtn.addEventListener('click', () => openAlternatives(card, post, body));
      actions.append(altBtn);
    }
  }

  if (shots.length > 0 && step.kind === 'main') {
    const saveBtn = button('画像を保存', 'btn btn--sub');
    saveBtn.addEventListener('click', () => saveMedia(post));
    actions.append(saveBtn);
  }

  const doneBtn = button(saved.done ? '投稿ずみに戻す' : '投稿した', 'btn btn--sub' + (saved.done ? '' : ' btn--done'));
  doneBtn.addEventListener('click', () => {
    const nowDone = !saved.done;
    patchState(post.id, { done: nowDone, ...traceOf(post) });
    render();
    // 「投稿した」を押すとカードが一覧から消える。
    // 何も出ないと消えたことに驚くので、どこへ行ったのかを必ず伝える。
    toast(nowDone ? '［投稿ずみ］に移しました。反応はあとで記録できます' : '一覧に戻しました');
  });
  actions.append(doneBtn);
  card.append(actions);

  // ── 反応の記録（翌週の生成に効く）──
  if (saved.done) {
    const rate = document.createElement('div');
    rate.className = 'rate';
    for (const [value, label] of [['good', '反応よかった'], ['bad', 'いまいち']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.type = 'button';
      if (saved.rating === value) b.classList.add('is-on');
      b.addEventListener('click', () => {
        const off = saved.rating === value;
        // 押し直したら「まだ送っていない」状態に戻す。
        // 送信ずみのまま値だけ変わると、翌週に届くのは古いほうになる。
        patchState(post.id, { rating: off ? null : value, sent: null, sentAtJst: null, ...traceOf(post) });
        render();
      });
      rate.append(b);
    }
    if (saved.rating && saved.sent) rate.append(chip('送信ずみ', 'chip--sent'));
    card.append(rate);
  }

  return card;
}

/**
 * 本文をその場で直す。
 *
 * 生成した文がだいたい良くて一言だけ直したい、というのが実際にはいちばん多い。
 * そのために PC を開いてリポジトリを直して週次を回しなおすのは現実的でない。
 * 直した内容はこの端末にだけ残る（生成には戻さない。戻す経路を作ると
 * 「AI が書いた文」と「人が直した文」の境界が消えて、次の生成の材料が濁る）。
 */
function openEditor(card, post, bodyEl, lenChip) {
  if (card.querySelector('.editor')) return;

  const saved = loadState()[post.id] || {};
  const editor = document.createElement('div');
  editor.className = 'editor';

  const area = document.createElement('textarea');
  area.className = 'editor__area';
  area.value = textOf(post, saved);
  area.rows = 8;
  area.setAttribute('aria-label', '投稿の本文');

  const count = document.createElement('p');
  count.className = 'editor__count';

  const refresh = () => {
    const length = weightedLength(area.value);
    count.textContent = `${length}/${MAX_WEIGHTED_LENGTH}`;
    count.classList.toggle('is-over', length > MAX_WEIGHTED_LENGTH);
  };
  area.addEventListener('input', refresh);
  refresh();

  const row = document.createElement('div');
  row.className = 'card__actions';

  const save = button('この内容にする', 'btn btn--done');
  save.addEventListener('click', () => {
    const value = area.value.trim();
    // 元の文に戻したときは、直した記録ごと消す。「手直しずみ」の印が残ると紛らわしい。
    patchState(post.id, { editedText: value && value !== post.text ? value : null, ...traceOf(post) });
    overLimitWarned.delete(post.id);
    render();
    toast(value && value !== post.text ? '本文を直しました（この端末にだけ残ります）' : '元の本文に戻しました');
  });

  const reset = button('元に戻す', 'btn btn--sub');
  reset.addEventListener('click', () => {
    area.value = post.text;
    refresh();
  });

  const cancel = button('やめる', 'btn btn--sub');
  cancel.addEventListener('click', () => editor.remove());

  row.append(save, reset, cancel);
  editor.append(area, count, row);
  bodyEl.after(editor);
  area.focus();
  void lenChip;
}

/**
 * 落選した案に差し替える。
 *
 * 生成のときに3案書かせて、編集者役が1つ選んでいる。
 * 選ばれなかった案も持っているので、読み比べて選び直せるようにする。
 * 選ぶ目は本人のほうが確かなので、機械の判断を最終決定にしない。
 */
function openAlternatives(card, post, bodyEl) {
  if (card.querySelector('.alts')) {
    card.querySelector('.alts').remove();
    return;
  }

  const box = document.createElement('div');
  box.className = 'alts';

  if (post.pickReason) {
    const why = document.createElement('p');
    why.className = 'alts__why';
    why.textContent = `いま出ている案が選ばれた理由: ${post.pickReason}`;
    box.append(why);
  }

  for (const [i, alt] of post.alternatives.entries()) {
    const item = document.createElement('div');
    item.className = 'alts__item';

    const p = document.createElement('p');
    p.className = 'alts__text';
    p.textContent = alt.body;
    item.append(p);

    const meta = document.createElement('p');
    meta.className = 'alts__meta';
    meta.textContent = `${weightedLength(alt.body)}/${MAX_WEIGHTED_LENGTH}` + (alt.thread?.length ? ` ・ つづき${alt.thread.length}コマ` : '');
    item.append(meta);

    const use = button(`この案にする（${i + 1}）`, 'btn btn--sub');
    use.addEventListener('click', () => {
      patchState(post.id, { editedText: alt.body, step: 0, ...traceOf(post) });
      overLimitWarned.delete(post.id);
      render();
      toast('別の案に差し替えました');
    });
    item.append(use);
    box.append(item);
  }

  const close = button('閉じる', 'btn btn--sub');
  close.addEventListener('click', () => box.remove());
  box.append(close);

  bodyEl.after(box);
}

/** 自分のタイムライン。返信を付けたい投稿を探すために開く。 */
function myTimelineUrl() {
  const handle = String(data.xHandle ?? '').replace(/^@/, '').trim();
  return handle ? `https://x.com/${encodeURIComponent(handle)}` : 'https://x.com/home';
}

/* ────────────────────────────────────────────
 *  反応の記録を送る
 * ──────────────────────────────────────────── */

/**
 * 未送信の評価をまとめて GitHub の Issue にする。
 *
 * X API も GitHub の書き込み API も、画面から直接叩くにはトークンが要る。
 * スマホのブラウザに書き込み権限のトークンを置くのは重すぎるので、
 * 本文を載せた Issue 作成画面を開いて、送信ボタンだけ本人に押してもらう。
 * 週次ワークフローが labels:feedback の Issue を読んで、翌週の生成に混ぜる。
 */
function renderSendBar(list) {
  const state = loadState();
  const pending = unsentRecords({ posts: data.posts ?? [], state });
  if (pending.length === 0) return;

  // 評価を押していない「出しただけ」の記録も一緒に送る。
  // 出せた枠・出せなかった枠が分かるのは、この記録だけである。
  const rated = unsentRatings({ posts: data.posts ?? [], state }).length;
  const postedOnly = pending.length - rated;

  const bar = document.createElement('div');
  bar.className = 'sendbar';

  const text = document.createElement('p');
  text.className = 'sendbar__text';
  text.textContent =
    rated > 0
      ? `まだ送っていない記録が ${pending.length} 件あります（反応 ${rated} 件${postedOnly > 0 ? ` / 出したぶん ${postedOnly} 件` : ''}）。送ると翌週の下書きに効きます。`
      : `出したぶんの記録が ${pending.length} 件あります。評価を付けなくても、送ると出せた枠が翌週にいきます。`;
  bar.append(text);

  const row = document.createElement('div');
  row.className = 'card__actions';

  const send = button(`まとめて送る（${pending.length}件）`, 'btn btn--x');
  send.addEventListener('click', () => sendFeedback(pending));
  row.append(send);

  const later = button('あとにする', 'btn btn--sub');
  later.addEventListener('click', () => bar.remove());
  row.append(later);

  bar.append(row);
  list.append(bar);
}

function sendFeedback(pending) {
  const repoUrl = data.repoUrl;
  if (!repoUrl) {
    toast('送り先が分かりません（launcher.json が古い可能性があります）');
    return;
  }

  const themeLabels = themeLabelMap(data);
  const slotLabels = slotLabelMap(data);
  const chunks = chunkEntries(pending, { repoUrl, themeLabels, slotLabels });

  // ⚠️ window.open は同期で、いちばん先に呼ぶ。
  //    ここより前に await を挟むと「ユーザー操作の直後」の資格が切れて、
  //    iOS Safari のポップアップブロックに落ちる。
  const first = chunks[0];
  const payload = buildPayload(first, { submissionId: newSubmissionId(), sentAtJst: jstStamp() });
  const url = buildIssueUrl(repoUrl, payload, { themeLabels, slotLabels, part: 1, parts: chunks.length });
  window.open(url, '_blank', 'noopener');

  // 実際に送信ボタンを押したかは取れない。開いたところまでを「送った」とみなし、
  // 押し忘れたときのために取り消せるようにしておく。
  for (const entry of first) patchState(entry.id, { sent: true, sentAtJst: jstStamp() });
  render();

  if (chunks.length > 1) {
    toast(`GitHub の画面を開きました。件数が多いので ${chunks.length} 通に分けます。送信したら、もう一度このボタンを押してください`);
  } else {
    toast('GitHub の画面を開きました。緑の［Create］を押すと送信できます');
  }
}

/* ────────────────────────────────────────────
 *  いま1本出す ／ 返信の下書き
 * ──────────────────────────────────────────── */

/**
 * 予定に無い投稿をその場で出す。
 *
 * その場で文章を作るには、ブラウザから Gemini を呼ぶことになる。
 * それには API キーを画面に置くしかなく、公開されるファイルに秘密情報は置けない。
 * だから週次のときに作り置きしてある（data/stock.json）。押した瞬間に出せる。
 */
function renderNow(list) {
  // ── 返信の下書きを頼む ──
  list.append(replyBox());

  const stock = data.stock ?? [];
  if (stock.length === 0) {
    list.append(
      emptyBox('予備の下書きがまだありません。\n日曜の夜に、その週の予定に出ていないアプリぶんが用意されます。')
    );
    return;
  }

  const state = loadState();
  const themes = [...new Set(stock.map((p) => p.themeLabel).filter(Boolean))];

  const filter = document.createElement('div');
  filter.className = 'jump';
  const current = nowFilter;
  for (const label of ['すべて', ...themes]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (label === current ? ' is-on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      nowFilter = label;
      render();
    });
    filter.append(b);
  }
  list.append(filter);

  const shown = stock.filter((p) => current === 'すべて' || p.themeLabel === current);
  for (const post of shown) list.append(postCard(post, state[post.id] || {}, todayJst()));
  prefetchMedia(shown);
}

let nowFilter = 'すべて';

/**
 * 返信の下書きを頼む。
 *
 * X では、他人の投稿への返信が交流として評価される。
 * 自分の投稿を並べるだけでは伸びない。ただし返信は相手のある行為なので、
 * 機械が勝手に出すことはしない。案を作るところまでで止める。
 *
 * ここも Issue 経由。ブラウザに書き込み権限のトークンを持たせないため。
 */
function replyBox() {
  const box = document.createElement('div');
  box.className = 'card replybox';

  const title = document.createElement('p');
  title.className = 'sendbar__text';
  title.textContent = '返信の下書きを頼む';
  box.append(title);

  const help = document.createElement('p');
  help.className = 'steps__guide';
  help.textContent =
    '返したい相手の投稿を貼ってください。立ち位置の違う返信案を3つ作って、GitHub のコメントで返します（数十秒かかります）。';
  box.append(help);

  const area = document.createElement('textarea');
  area.className = 'editor__area';
  area.rows = 5;
  area.placeholder = '相手の投稿の本文を貼り付けてください';
  area.setAttribute('aria-label', '返信したい相手の投稿');
  box.append(area);

  const row = document.createElement('div');
  row.className = 'card__actions';

  const ask = button('下書きを頼む', 'btn btn--x');
  ask.addEventListener('click', () => {
    const source = area.value.trim();
    if (source.length < 10) {
      toast('相手の投稿を貼り付けてください');
      return;
    }
    if (!data.repoUrl) {
      toast('送り先が分かりません（launcher.json が古い可能性があります）');
      return;
    }
    // ⚠️ window.open を同期で先に。await のあとだと iOS で開かない。
    window.open(replyIssueUrl(source), '_blank', 'noopener');
    area.value = '';
    toast('GitHub の画面を開きました。緑の［Create］を押すと下書きが届きます');
  });
  row.append(ask);
  box.append(row);

  return box;
}

function replyIssueUrl(source) {
  const base = String(data.repoUrl).replace(/\/+$/, '');
  const params = new URLSearchParams({
    title: `[返信] ${source.replace(/\s+/g, ' ').slice(0, 30)}…`,
    body: ['返したい投稿です。返信案をお願いします。', '', '```text', source.slice(0, 1200), '```'].join('\n'),
    labels: '返信の下書き',
  });
  return `${base}/issues/new?${params.toString()}`;
}

/* ────────────────────────────────────────────
 *  note
 * ──────────────────────────────────────────── */

function renderNotes(list) {
  if (!data.notes || data.notes.length === 0) {
    list.append(emptyBox('note の下書きがまだありません。\n日曜の夜に週1本ぶんが自動で用意されます。'));
    return;
  }

  const state = loadState();

  for (const note of data.notes) {
    const id = `note-${note.weekId}`;
    const saved = state[id] || {};

    const card = document.createElement('article');
    card.className = 'card' + (saved.done ? ' is-done' : '');

    const meta = document.createElement('div');
    meta.className = 'card__meta';
    meta.append(chip(note.weekId), chip(`${note.charCount}字`), chip((note.featured || []).join(' / ') || 'note'));
    card.append(meta);

    const title = document.createElement('p');
    title.className = 'card__text card__text--title';
    title.textContent = note.title;
    card.append(title);

    const preview = document.createElement('p');
    preview.className = 'card__text card__text--preview';
    preview.textContent = truncate(note.plain, 160);
    card.append(preview);

    const actions = document.createElement('div');
    actions.className = 'card__actions';

    const go = button('本文をコピーして note を開く', 'btn btn--note');
    go.addEventListener('click', () => {
      // note には公式の投稿 API が無く、非公式 API は規約に触れる。
      // だからここは「クリップボードに入れてエディタを開く」までにしてある。
      //
      // ⚠️ window.open を先に、コピーを後に。逆にすると（await のあとに開くと）
      //    iOS Safari で新しいタブが開かない。X を開くときとまったく同じ話。
      window.open(noteEditorUrl(), '_blank', 'noopener');
      copyText(note.plain).then((ok) => {
        toast(ok ? 'コピーしました。note で貼り付けてください' : 'コピーできませんでした。本文を長押しで選んでください');
      });
    });
    actions.append(go);

    const copyTitle = button('タイトルをコピー', 'btn btn--sub');
    copyTitle.addEventListener('click', async () => {
      toast((await copyText(note.title)) ? 'タイトルをコピーしました' : 'コピーできませんでした');
    });
    actions.append(copyTitle);

    const doneBtn = button(saved.done ? '公開ずみに戻す' : '公開した', 'btn btn--sub' + (saved.done ? '' : ' btn--done'));
    doneBtn.addEventListener('click', () => {
      patchState(id, { done: !saved.done });
      render();
    });
    actions.append(doneBtn);

    card.append(actions);
    list.append(card);
  }
}

/**
 * note のエディタ URL。launcher.json から来る文字列をそのまま開かない。
 * 生成物とはいえ画面に入ってくる唯一の外部文字列なので、行き先を note.com に限る。
 */
function noteEditorUrl() {
  const fallback = 'https://note.com/notes/new';
  try {
    const url = new URL(data.noteEditorUrl ?? fallback);
    if (url.protocol !== 'https:') return fallback;
    if (url.hostname !== 'note.com' && !url.hostname.endsWith('.note.com')) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

/* ────────────────────────────────────────────
 *  X へ出す
 * ──────────────────────────────────────────── */

/** その投稿で選べる画像。紹介カード＋アプリのリポジトリに置いてある画像。 */
function galleryFor(post) {
  return galleryOf(post, data.galleries ?? {});
}

/** いまその投稿に付くことになっている画像（選んだ順）。 */
function chosenFor(post, saved = loadState()[post.id] || {}) {
  return selectedItems(galleryFor(post), saved.media);
}

/**
 * 共有シートを開く。ここがこのアプリの心臓部。
 * 画像は prefetchMedia で先に読んであるので、押してすぐ share() に入れる。
 */
async function shareToX(post, btn, step = null, totalSteps = 1) {
  const saved = loadState()[post.id] || {};
  const text = step ? step.text : textOf(post, saved);

  // 280字を超えていると X 側で投稿できない。ただし共有そのものを禁止はしない。
  // 出せなくすると詰むので、1度目は止めて理由を伝え、2度目は通す。
  const length = weightedLength(text);
  if (length > MAX_WEIGHTED_LENGTH && !overLimitWarned.has(post.id)) {
    overLimitWarned.add(post.id);
    btn.textContent = 'それでも共有する';
    toast(`${overLimitMessage(length, MAX_WEIGHTED_LENGTH)}［本文を直す］で縮められます`);
    return;
  }

  // ① 先にクリップボードへ。await しないのは、
  //    ここで待つと「ユーザー操作の直後」の資格を失って share() が拒否されるためである。
  //    iOS で本文が落ちたときの保険なので、間に合わなくても致命的ではない。
  copyText(text);

  const chosen = chosenFor(post, saved);
  const files = chosen.map((item) => fileCache.get(item.src)).filter(Boolean);

  // まだ読み終わっていない画像があるときは、いったん止める。
  // 足りないまま共有すると、選んだはずの画像が黙って1枚減った状態で投稿されてしまう。
  // 読めなかった（失敗が確定した）ものは待っても変わらないので、そのまま先へ進む。
  const loading = chosen.filter((item) => !fileCache.has(item.src) && !mediaFailed.has(item.src));
  if (loading.length > 0) {
    for (const [i, item] of loading.entries()) loadMediaFile(post, item, i);
    toast(`画像を準備しています（残り${loading.length}枚）。もう一度［共有］を押してください`);
    return;
  }

  // 前に読めなかったものは、ここでもう一度だけ取りにいく（待たない）。
  // 電波が悪かっただけのことがあり、そのまま諦めると画面を開きなおすまで直らない。
  for (const [i, item] of chosen.entries()) {
    if (!fileCache.has(item.src)) loadMediaFile(post, item, i);
  }

  try {
    if (files.length > 1 && navigator.canShare && navigator.canShare({ files })) {
      // X は1投稿に画像4枚まで。選んだぶんをまとめて渡す。
      await navigator.share({ files, text });
    } else if (files.length > 0 && navigator.canShare && navigator.canShare({ files: [files[0]] })) {
      // 複数を受けつけない共有先もある。1枚に落として続ける。
      await navigator.share({ files: [files[0]], text });
    } else if (navigator.share) {
      // 画像を渡せない環境。本文だけでも共有シートに乗せる。
      await navigator.share({ text });
    } else {
      // PC の Chrome など、共有シートを持たない環境。
      openIntent(post);
      return;
    }

    // 共有シートを開いたところまでしか分からない（実際に投稿したかは取れない）。
    // 押した本人がいちばん分かっているので、投稿ずみの印は手で付けてもらう。
    const label = btn.textContent;
    btn.textContent = '共有しました';
    setTimeout(() => {
      btn.textContent = label;
    }, 2500);
    const missing = chosen.length - files.length;
    toast(
      totalSteps > 1
        ? 'X で投稿したら、［次へ］を押して返信を続けてください'
        : missing > 0
          ? `画像を${missing}枚用意できませんでした。${files.length > 0 ? '残りだけ添えて共有します' : '本文だけ共有します'}`
          : 'X を選んで投稿ボタンを押してください'
    );
  } catch (error) {
    // 共有シートを閉じただけでも AbortError が来る。これは失敗ではない。
    if (error && error.name === 'AbortError') return;
    console.warn('share に失敗しました', error);
    toast('共有できませんでした。［コピーして X を開く］をお使いください');
  }
}

/**
 * 本文をコピーして X の投稿画面を開く。画像は付かないので、別途［画像を保存］から添付する。
 *
 * ⚠️ window.open を先に呼ぶ。await のあとに開くと、iOS Safari のポップアップブロックに
 *    引っかかる。shareToX が copyText を await しないのとまったく同じ理由である。
 *    しかもこの導線は「共有シートに X が出ないとき」の唯一の逃げ道なので、失うと詰む。
 */
function openIntent(post, step = null) {
  const saved = loadState()[post.id] || {};
  const text = step ? step.text : textOf(post, saved);
  // noopener を付けると window.open は必ず null を返すため、開けたかどうかは判定できない。
  // 逆タブナビング対策のほうを優先し、案内文は「開かなければ」の場合も含む書き方にする。
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  copyText(text).then((ok) => {
    toast(
      ok
        ? 'コピーしました。X の画面が開かないときは、貼り付けて投稿してください'
        : 'X の画面を開きました。コピーはできなかったので、本文を長押しで選んでください'
    );
  });
}

/**
 * カード画像を端末に持ってくる。共有シートが使えないときに手で添付するため。
 *
 * iOS Safari の <a download> は長らく挙動が定まっていない（新しいタブに画像が開くだけ、
 * ということが普通に起きる）。それを「保存しました」と言い切るのは嘘になる。
 * 共有シートが使えるなら、そちらを開く（iOS ではここに「画像を保存」が出る）。
 */
async function saveMedia(post) {
  const chosen = chosenFor(post);
  if (chosen.length === 0) {
    toast('画像が選ばれていません');
    return;
  }

  const files = chosen.map((item) => fileCache.get(item.src)).filter(Boolean);

  if (files.length > 0 && navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      // 共有で駄目なら下のダウンロードに落ちる
    }
  }

  for (const [i, item] of chosen.entries()) {
    const a = document.createElement('a');
    a.href = item.src;
    a.download = fileNameFor(post.repo, item, i);
    document.body.append(a);
    a.click();
    a.remove();
  }
  toast('画像を開きました。表示された画像を長押しして保存してください');
}

/**
 * 選んである画像を File にして先に持っておく。
 * ボタンを押してから読みにいくと、その待ち時間のせいで share() が拒否されることがある。
 */
function prefetchMedia(posts) {
  for (const post of posts) {
    for (const [i, item] of chosenFor(post).entries()) {
      loadMediaFile(post, item, i);
    }
  }
}

/**
 * 画像1枚を File にする。読み終わるまでの Promise を覚えておき、二重に取りにいかない。
 *
 * repo の画像は raw.githubusercontent.com から読む（CORS は許可されている）。
 * Service Worker は他所のドメインには手を出さないので、ここは素の fetch がそのまま出る。
 * つまり圏外では取れない。取れなければ本文だけで共有できる形に落とす。
 */
function loadMediaFile(post, item, index = 0) {
  if (fileCache.has(item.src)) return Promise.resolve(fileCache.get(item.src));
  if (filePending.has(item.src)) return filePending.get(item.src);

  const task = fetch(item.src)
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((blob) => {
      const file = new File([blob], fileNameFor(post.repo, item, index), {
        type: blob.type || 'image/png',
      });
      fileCache.set(item.src, file);
      mediaFailed.delete(item.src);
      return file;
    })
    .catch((error) => {
      // 画像が無くても本文だけは共有できる。ここで止めないが、黙ってもいない。
      mediaFailed.add(item.src);
      console.warn(`画像を読み込めませんでした: ${item.src}`, error);
      return null;
    })
    .finally(() => filePending.delete(item.src));

  filePending.set(item.src, task);
  return task;
}

/* ────────────────────────────────────────────
 *  小道具
 * ──────────────────────────────────────────── */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http:// で開いている、または権限が無い場合。古い方法で試す。
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function chip(text, extra = '') {
  const span = document.createElement('span');
  span.className = `chip ${extra}`.trim();
  span.textContent = text;
  return span;
}

function button(label, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

function formatDate(iso) {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

let toastTimer = null;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  // hidden の付け外しは読み上げが安定しない。要素は残したまま見た目だけ切り替える。
  el.dataset.show = 'on';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.show = 'off';
  }, 3200);
}

function updateSummary() {
  document.getElementById('summary').textContent = summaryOf({
    posts: data.posts ?? [],
    state: loadState(),
    today: todayJst(),
    activeWeeks: activeWeekIds(data),
  });

  // 未送信の記録があることは、タブを開かないと分からない。バッジで外に出す。
  const pending = unsentRecords({ posts: data.posts ?? [], state: loadState() }).length;
  const doneTab = document.querySelector('.tab[data-view="done"]');
  if (doneTab) {
    doneTab.dataset.badge = pending > 0 ? String(pending) : '';
    doneTab.setAttribute('aria-label', pending > 0 ? `投稿ずみ（未送信の記録 ${pending} 件）` : '投稿ずみ');
  }
}

/* ────────────────────────────────────────────
 *  起動
 * ──────────────────────────────────────────── */

const TABS = ['today', 'week', 'now', 'note', 'done', 'past'];

function selectTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'today';
  view = name;
  const list = document.getElementById('list');
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.view === name;
    t.classList.toggle('is-on', on);
    t.setAttribute('aria-selected', String(on));
    // 選択中のタブだけをタブ順に載せる（roving tabindex）。
    // 全部が順番に入ると、キーボードで一覧に届くまでにタブを4回通ることになる。
    t.tabIndex = on ? 0 : -1;
    if (on) {
      list.setAttribute('aria-labelledby', t.id);
      if (focus) t.focus();
    }
  }
  render();
}

function bindTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab.dataset.view));
    tab.addEventListener('keydown', (event) => {
      const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      let next = null;
      if (move) next = tabs[(i + move + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      event.preventDefault();
      selectTab(next.dataset.view, { focus: true });
    });
  }
}

/** 通知の Issue から #done などで飛んでこられるようにする。 */
function viewFromHash() {
  const name = location.hash.replace(/^#/, '');
  return TABS.includes(name) ? name : 'today';
}

/**
 * ホーム画面への追加。
 *
 * beforeinstallprompt は Chrome 系にしかない。iOS Safari では永久に発火しないので、
 * それだけを頼りにすると iPhone にボタンが出ない（README は iPhone 前提で書いてある）。
 * UA を見て分岐すると必ず外すので、「一定時間たっても prompt が来ず、
 * まだホーム画面から開かれていない」という事実だけで手順の案内に切り替える。
 */
function bindInstall() {
  const btn = document.getElementById('install');
  let mode = null;

  const installed = () =>
    window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

  const showPrompt = () => {
    if (!window.__pwaInstallPrompt || installed()) return;
    mode = 'prompt';
    btn.textContent = 'ホーム画面に追加';
    btn.hidden = false;
  };

  window.addEventListener('pwa-install-available', showPrompt);
  window.addEventListener('pwa-installed', () => {
    btn.hidden = true;
  });
  showPrompt();

  setTimeout(() => {
    if (mode || installed()) return;
    mode = 'howto';
    btn.textContent = 'ホーム画面への追加';
    btn.hidden = false;
  }, 1500);

  btn.addEventListener('click', async () => {
    if (mode === 'howto') {
      showInstallHowTo();
      return;
    }
    const prompt = window.__pwaInstallPrompt;
    if (!prompt) return;
    btn.hidden = true;
    prompt.prompt();
    await prompt.userChoice;
    window.__pwaInstallPrompt = null;
  });
}

function showInstallHowTo() {
  const existing = document.getElementById('howto');
  if (existing) {
    existing.remove();
    return;
  }
  const box = document.createElement('div');
  box.id = 'howto';
  box.className = 'howto';
  box.innerHTML = '';

  const title = document.createElement('p');
  title.className = 'howto__title';
  title.textContent = 'ホーム画面に置くと、通知から1タップで開けます';
  box.append(title);

  const list = document.createElement('ol');
  list.className = 'howto__list';
  for (const step of [
    'iPhone / iPad：下（または右上）の「共有」ボタンを押す',
    'メニューを下にたどって「ホーム画面に追加」を押す',
    'Android：右上のメニューから「アプリをインストール」を押す',
  ]) {
    const li = document.createElement('li');
    li.textContent = step;
    list.append(li);
  }
  box.append(list);

  const close = button('閉じる', 'btn btn--sub');
  close.addEventListener('click', () => box.remove());
  box.append(close);

  document.getElementById('list').prepend(box);
}

/**
 * Service Worker の登録。
 *
 * ⚠️ launcher.json の読み込みより先にやること。
 *    以前は読み込みが失敗すると early return してここに来なかった。
 *    つまり「初回が圏外だった端末」には、以後シェルのキャッシュも offline.html も
 *    永久に用意されない。いちばんオフライン対応が要る場面で効かない、という形になっていた。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 新しい版が有効になった。1回だけ読み直して、古い画面を残さない。
    // これが無いと MANUAL の「アイコンを消して追加しなおしてください」が永久に残る。
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });

  navigator.serviceWorker.register('sw.js').catch(() => {
    // オフライン対応が効かないだけで、画面は動く。
  });
}

async function boot() {
  registerServiceWorker();
  bindTabs();
  bindInstall();
  view = viewFromHash();
  window.addEventListener('hashchange', () => selectTab(viewFromHash()));

  try {
    // Pages のキャッシュが古いと「新しい週が出てこない」という分かりにくい症状になる。
    // 毎回サーバーに確認しにいく。
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`launcher.json を読めません（${res.status}）`);
    data = await res.json();
  } catch (error) {
    document.getElementById('summary').textContent = '下書きを読み込めませんでした';
    document.getElementById('list').append(
      emptyBox(
        `下書きの読み込みに失敗しました。\n${error.message}\n\n` +
          'GitHub Actions の weekly ワークフローがまだ動いていない可能性があります。'
      )
    );
    return;
  }

  // 端末の記録を手入れする。放っておくと1年で数百件たまる。
  // 画面に出ているものと、まだ送っていない評価は残す（lib/state.js）。
  const { state, removed } = pruneState(loadState(), {
    keepIds: (data.posts ?? []).map((p) => p.id).concat((data.notes ?? []).map((n) => `note-${n.weekId}`)),
    today: todayJst(),
  });
  if (removed > 0) saveState(state);

  document.getElementById('stamp').textContent = `下書きの作成: ${data.generatedAtJst || '不明'}`;
  selectTab(view);
}

boot();
