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
import { bodyPreview, overLimitMessage, slotLabelMap, stepGuide, themeLabelMap } from './lib/format.js';
import {
  VIEWS,
  activeWeekIds,
  emptyMessageFor,
  firstViewOf,
  matchApps,
  routeFromHash,
  selectPosts,
  summaryOf,
  tabOfView,
  unsentRatings,
  unsentRecords,
} from './lib/select.js';
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
import {
  DEFAULT_COUNT,
  MAX_COUNT,
  MAX_NOTE_CHARS,
  MAX_THEMES,
  MIN_COUNT,
  buildOrder,
  buildOrderIssueUrl,
  newOrderId,
  resultPathOf,
  validateResult,
} from './lib/order.js';
import { articlePathOf, markerFor, validateArticle } from './lib/note-doc.js';
import {
  DONE as ORDER_DONE,
  FAILED as ORDER_FAILED,
  MINE_KEY,
  WAITING as ORDER_WAITING,
  addOrder,
  addPosts,
  dropOrder,
  dropPost,
  fromBackupText,
  minePosts,
  normalizeMine,
  patchOrder,
  repoCounts,
  toBackupText,
  waitingOrders,
} from './lib/mine.js';

const DATA_URL = 'launcher.json';

/** @type {{posts: any[], notes: any[], noteArticles?: any[], weekIds?: string[], slots?: any[], repoUrl?: string, noteEditorUrl?: string, galleries?: object}} */
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

/** 共有ボタンの文言。画像を選びなおしたときに書きかえるので、2か所に散らさない。 */
const SHARE_LABEL = '𝕏 に共有';
const SHARE_LABEL_WITH_MEDIA = '𝕏 に共有（画像つき）';

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

/* ── 自分で作らせた投稿（［つくる］タブ）──
 *
 * 週の投稿とは別の入れ物にする。週のぶんは launcher.json から毎週やってくるが、
 * こちらは注文して作らせたもので、出すまでのあいだ誰も預かってくれない。 */

function loadMine() {
  try {
    return normalizeMine(JSON.parse(localStorage.getItem(MINE_KEY) || '{}'));
  } catch {
    return normalizeMine(null);
  }
}

function saveMine(store) {
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(store));
    return true;
  } catch {
    // ここは黙ってはいけない。作らせた投稿は他にどこにも無い。
    toast('この端末に保存できませんでした（容量不足かプライベートモード？）');
    return false;
  }
}

/* ────────────────────────────────────────────
 *  画面
 * ──────────────────────────────────────────── */

function todayJst() {
  return jstDateString();
}

/**
 * 反応を記録できる投稿ぜんぶ。
 *
 * 週の投稿（launcher.json）に、［つくる］で作らせたものを足す。
 * あちらは端末のなかにしか無いので、ここで足さないと
 * 「反応よかった」を押しても翌週の生成に届かない
 * （型・アプリ・フックの手応えは、どちらの投稿から来ても同じだけ価値がある）。
 */
function recordablePosts() {
  return [...(data.posts ?? []), ...loadMine().posts];
}

/**
 * そのタブの母数になる投稿。
 *
 * ［投稿ずみ］だけは、［つくる］で作らせたものも混ぜる。
 * 出したものを見返す場所であって、どこから来た投稿かは関係ないからである。
 * ここを分けていたあいだ、作った投稿に［投稿した］を押すと
 * 「未送信の記録 1 件」のバッジだけが立って、一覧は「まだ投稿ずみのものはありません」と
 * 言う、という食い違いが出ていた。
 *
 * ほかのタブには混ぜない。あちらは「今週ぶん」を週IDで見ているので、
 * 週を持たない投稿を入れると［過去］に全部落ちる。
 */
function poolFor(name) {
  return name === 'done' ? recordablePosts() : data.posts ?? [];
}

function visiblePosts() {
  return selectPosts({
    posts: poolFor(view),
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

  // タブの中の切りかえ（今日 / 今週 / 予備、投稿ずみ / 過去）。
  // 一覧より先に置く。何を見ているのかが分からないまま中身を読むことになるのを防ぐ。
  const seg = segmentBar();
  if (seg) list.append(seg);

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

  if (view === 'make') {
    renderMake(list);
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
          posts: poolFor(view),
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
 *
 * ⚠️ ここでは render() を呼ばない。
 *    一覧を作りなおすと、横に流して見ていたサムネイルが必ず1枚目に戻る。
 *    週案エディタのように候補が23枚あると、奥のほうを2枚選ぶだけで
 *    毎回スクロールしなおすことになり、選ぶ作業そのものが成立しない。
 *    選択で変わるのは「番号」「見出し」「上に出ている絵」だけなので、そこだけ書きかえる。
 */
function mediaPicker(post, gallery, onChange) {
  const box = document.createElement('div');
  box.className = 'picker';

  const head = document.createElement('p');
  head.className = 'picker__head';
  box.append(head);

  const strip = document.createElement('div');
  strip.className = 'picker__strip';

  for (const item of gallery) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'picker__cell';
    cell.dataset.mediaId = item.id;

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
      onChange();
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
    onChange();
  });
  box.append(reset);

  refreshPicker(box, post);
  return box;
}

/**
 * 選んだ状態を、選ぶところに映す。番号・押された状態・見出しだけを書きかえる。
 * サムネイルそのものは作りなおさない（横のスクロール位置を保つため）。
 */
function refreshPicker(picker, post) {
  const chosen = chosenFor(post);
  const order = new Map(chosen.map((item, i) => [item.id, i + 1]));

  picker.querySelector('.picker__head').textContent = `添付する画像（${chosen.length}/${MAX_MEDIA}）`;

  for (const cell of picker.querySelectorAll('.picker__cell')) {
    const at = order.get(cell.dataset.mediaId);
    cell.classList.toggle('is-on', at !== undefined);
    cell.setAttribute('aria-pressed', at !== undefined ? 'true' : 'false');
    cell.querySelector('.picker__badge').textContent = at ?? '';
    const label = cell.querySelector('.picker__label').textContent;
    cell.setAttribute('aria-label', `${label}を${at !== undefined ? '外す' : '添付する'}`);
  }
}

/**
 * 共有ボタンの文言を、いまの選択に合わせる。
 *
 * 「それでも共有する」「共有しました」に変わっている最中は触らない。
 * こちらが上書きすると、長すぎる本文を止めている案内が消える。
 */
function refreshShareLabel(btn, post) {
  if (btn.textContent !== SHARE_LABEL && btn.textContent !== SHARE_LABEL_WITH_MEDIA) return;
  btn.textContent = chosenFor(post).length > 0 ? SHARE_LABEL_WITH_MEDIA : SHARE_LABEL;
}

/**
 * いま添付されることになっている画像を、カードの上に出す。
 * 選んだ結果がそのまま大きく見えていないと、投稿してから気づくことになる。
 */
function renderShots(box, post) {
  const shots = chosenFor(post);
  box.innerHTML = '';
  box.className = 'card__shots' + (shots.length > 1 ? ' is-multi' : '');

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
      const missing = document.createElement('div');
      missing.className = 'card__img card__img--missing';
      missing.textContent = '画像を読み込めませんでした（本文だけで共有できます）';
      img.replaceWith(missing);
    });
    box.append(img);
  }
}

function emptyBox(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

/**
 * たまにしか使わない操作を畳んでおくところ。
 *
 * ⚠️ 隠すのであって、無くすのではない。
 *    ここに入るものにも「これが唯一の道」という場面がある
 *    （共有シートに X が出ない端末の［コピーして X を開く］がまさにそれ）。
 *    だから閉じているときも件数の分かる見た目にし、開けば全部が縦に並ぶようにする。
 *    折りたたみを入れ子にしない。2回押さないと出てこないものは、無いのと同じである。
 *
 * @returns {{toggle: HTMLButtonElement, box: HTMLElement, add: (label: string, onClick: () => void) => void}}
 */
function moreMenu() {
  const box = document.createElement('div');
  box.className = 'more';
  box.hidden = true;

  const toggle = button('…', 'btn btn--sub btn--more');
  toggle.setAttribute('aria-label', 'ほかの操作');
  toggle.setAttribute('aria-expanded', 'false');
  // 中身が1つも無いなら押す意味が無い。1つ足された時点で出す。
  toggle.hidden = true;
  toggle.addEventListener('click', () => {
    box.hidden = !box.hidden;
    toggle.setAttribute('aria-expanded', String(!box.hidden));
    toggle.classList.toggle('is-on', !box.hidden);
  });

  return {
    toggle,
    box,
    add(label, onClick) {
      const b = button(label, 'btn btn--sub more__item');
      b.addEventListener('click', onClick);
      box.append(b);
      toggle.hidden = false;
      return b;
    },
  };
}

/**
 * すでに組み上がったカードの［…］に、あとから1つ足す。
 *
 * ［つくる］で作った投稿にだけ付く操作（この投稿を消す）のためにある。
 * カードの組み立てを2つに分けると、週の投稿と作った投稿で見た目が割れるので、
 * 足す側がここを通る形にしてある。
 */
function addToMore(card, label, className, onClick) {
  const box = card.querySelector('.more');
  const toggle = card.querySelector('.btn--more');
  if (!box || !toggle) return null;

  const b = button(label, `btn btn--sub more__item ${className}`.trim());
  b.addEventListener('click', onClick);
  box.append(b);
  toggle.hidden = false;
  return b;
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
  const gallery = galleryFor(post);
  const shots = selectedItems(gallery, saved.media);

  const shotsBox = document.createElement('div');
  card.append(shotsBox);
  renderShots(shotsBox, post);

  // 選んだときに書きかえるところ。一覧ごと作りなおすとスクロール位置が飛ぶので、
  // ここに集めて、変わるものだけを差しかえる。
  let shareBtn = null;
  let picker = null;
  const refreshMedia = () => {
    renderShots(shotsBox, post);
    if (picker) refreshPicker(picker, post);
    if (shareBtn) refreshShareLabel(shareBtn, post);
  };

  // 候補が紹介カード1枚しか無いなら、選ぶところは出さない（押すものが増えるだけになる）。
  if (gallery.length > 1) {
    picker = mediaPicker(post, gallery, refreshMedia);
    card.append(picker);
  }

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
  //
  // 主要な1つ（共有）と、押したあとの印（投稿した）だけを外に出す。
  // 残り（コピー・本文を直す・別の案・画像を保存）は［…］の中に入れる。
  //
  // もとは7つが同じ大きさで横に並んでいた。ふだんの2タップ（共有 → 投稿した）と、
  // たまにしか使わないものが同じ強さで置かれていると、毎日押すほうを探すことになる。
  const actions = document.createElement('div');
  actions.className = 'card__actions';
  const more = moreMenu();

  if (step.kind === 'main') {
    shareBtn = button(shots.length > 0 ? SHARE_LABEL_WITH_MEDIA : SHARE_LABEL, 'btn btn--x');
    shareBtn.addEventListener('click', () => shareToX(post, shareBtn, step, steps.length));
    actions.append(shareBtn);

    // 共有シートに X が出ない端末では、これが唯一の道になる。
    // 隠すが、いちばん上に置いて最初に目に入るようにする。
    more.add('コピーして X を開く', () => openIntent(post, step));
  } else {
    // 返信は共有シートからは出せない（共有すると新しい投稿になってしまう）。
    // 本文をクリップボードに入れて、X で「返信」を押してから貼ってもらう。
    const copyBtn = button('この文をコピーする', 'btn btn--x');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(step.text);
      toast(ok ? 'コピーしました。X で返信を押して貼り付けてください' : 'コピーできませんでした。長押しで選んでください');
    });
    actions.append(copyBtn);

    more.add('X で自分の投稿を開く', () => {
      // ⚠️ window.open を同期で先に。await のあとだと iOS で開かない。
      window.open(myTimelineUrl(), '_blank', 'noopener');
      copyText(step.text);
    });
  }

  // 連投の途中は「次へ」がその場の続きなので、外に出しておく。
  if (at < steps.length - 1) {
    const nextBtn = button(`次へ（${steps[at + 1].label}）`, 'btn btn--sub btn--next');
    nextBtn.addEventListener('click', () => {
      patchState(post.id, { step: at + 1, ...traceOf(post) });
      render();
    });
    actions.append(nextBtn);
  }

  if (step.kind === 'main') {
    more.add(saved.editedText ? '本文を直す（手直しずみ）' : '本文を直す', () => openEditor(card, post, body, lenChip));

    if ((post.alternatives ?? []).length > 0) {
      more.add(`別の案を見る（${post.alternatives.length}）`, () => openAlternatives(card, post, body));
    }

    // 候補があるなら常に出す。何も選んでいないときに押されたら、saveMedia がその場で理由を出す。
    if (gallery.length > 0) more.add('画像を保存', () => saveMedia(post));
  }

  const doneBtn = button(saved.done ? '投稿ずみに戻す' : '投稿した', 'btn btn--sub' + (saved.done ? '' : ' btn--done'));
  doneBtn.addEventListener('click', () => {
    const nowDone = !saved.done;
    patchState(post.id, { done: nowDone, ...traceOf(post) });
    render();
    // 「投稿した」を押すとカードが一覧から消える。
    // 何も出ないと消えたことに驚くので、どこへ行ったのかを必ず伝える。
    toast(nowDone ? '［記録］に移しました。反応はあとで記録できます' : '一覧に戻しました');
  });
  actions.append(doneBtn);
  actions.append(more.toggle);
  card.append(actions, more.box);

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
  // 書きかけが端末に残っていれば、そちらを先に出す（下の saveOpenDrafts を参照）。
  const draft = typeof saved.draftText === 'string' && saved.draftText.trim() ? saved.draftText : null;
  area.value = draft ?? textOf(post, saved);
  area.rows = 8;
  area.setAttribute('aria-label', '投稿の本文');
  // pagehide のときに、どの投稿の書きかけなのかを引けるようにしておく。
  area.dataset.draftId = post.id;
  area.dataset.draftBase = post.text;

  if (draft) {
    const note = document.createElement('p');
    note.className = 'editor__resumed';
    note.textContent = '前に書きかけていた文を出しています。［この内容にする］を押すまでは確定しません。';
    editor.append(note);
  }

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
    // 確定したので、書きかけの控えは要らない。
    patchState(post.id, { editedText: value && value !== post.text ? value : null, draftText: null, ...traceOf(post) });
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
  cancel.addEventListener('click', () => {
    // やめると言われた以上、書きかけの控えも残さない。
    // 残すと、次に開いたときに「消したはずの文」が戻ってくる。
    if (typeof loadState()[post.id]?.draftText === 'string') patchState(post.id, { draftText: null });
    editor.remove();
  });

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
  const pending = unsentRecords({ posts: recordablePosts(), state });
  if (pending.length === 0) return;

  // 評価を押していない「出しただけ」の記録も一緒に送る。
  // 出せた枠・出せなかった枠が分かるのは、この記録だけである。
  const rated = unsentRatings({ posts: recordablePosts(), state }).length;
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
  const stock = data.stock ?? [];
  if (stock.length === 0) {
    list.append(
      emptyBox('予備の下書きがまだありません。\n日曜の夜に、その週の予定に出ていないアプリぶんが用意されます。')
    );
    return;
  }

  const guide = document.createElement('p');
  guide.className = 'lede';
  guide.textContent = '予定に無い日でも出せるように作り置きしてあるものです。日付を持たないので、いつ出してもかまいません。';
  list.append(guide);

  const state = loadState();
  const themes = [...new Set(stock.map((p) => p.themeLabel).filter(Boolean))];

  // 型でしぼる。ここはタブでも切りかえでもなく、一覧の絞りこみである。
  // 上の2段（タブ・切りかえ）と同じ見た目にすると、3段目に見えて迷う。
  if (themes.length > 1) {
    const filter = document.createElement('div');
    filter.className = 'jump';
    const current = nowFilter;
    for (const label of ['すべて', ...themes]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'jump__btn' + (label === current ? ' is-on' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        nowFilter = label;
        render();
      });
      filter.append(b);
    }
    list.append(filter);
  }

  const shown = stock.filter((p) => nowFilter === 'すべて' || p.themeLabel === nowFilter);
  for (const post of shown) list.append(postCard(post, state[post.id] || {}, todayJst()));
  prefetchMedia(shown);
}

let nowFilter = 'すべて';

/* ［つくる］の入力。画面を作りなおしても消えないように、ここに置く。 */
let makeRepo = '';
let makeCount = DEFAULT_COUNT;
let makeThemes = new Set();
let makeNote = '';
let appQuery = '';
/** マイ投稿の絞りこみ（アプリ名。空ならすべて）。 */
let mineFilter = '';

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
 *  つくる — アプリを選んで宣伝ポストを頼む
 * ──────────────────────────────────────────── */

/**
 * ［つくる］タブ。
 *
 * 週次の生成は日曜の夜にしか動かない。ところが「このアプリの話を、いま出したい」は
 * 予定と関係なくやってくる（誰かに聞かれた、その教科の研究授業が近い、など）。
 * ［いま出す］の予備の引き出しは作り置きなので、アプリを選べない。
 *
 * その場で文章を作るにはブラウザから Gemini を呼ぶことになり、
 * それには API キーを画面に置くしかない（できない / CLAUDE.md §2）。
 * だから注文を Issue にして送り、ワークフローが作ったものを拾いにいく。
 * 反応の記録と返信の下書きが、すでに同じ問題を同じやり方で解いている。
 *
 * 受け取った投稿はこの端末に貯める（docs/lib/mine.js）。
 * 週の投稿と違って誰も預かってくれないので、出すまでのあいだ手元に置いておく。
 */
/**
 * ［つくる］。
 *
 * 「頼んで作ってもらう」ものをここに集めてある。宣伝ポストと、返信の下書きである。
 * 返信の下書きは以前［いま出す］にあったが、あちらは作り置きを出す場所で、
 * 頼む相手も待ち方も違うものが同じ画面に並んでいた。
 * どちらも「GitHub に注文を出して、できたものを受け取る」という同じ形なので、ここが正しい。
 */
function renderMake(list) {
  list.append(orderForm());
  list.append(replyBox());

  const store = loadMine();

  const pending = waitingOrders(store);
  if (pending.length > 0) list.append(pendingBox(pending));

  // 作れなかった注文は、画面に理由を出す。
  // トーストだけだと、そのとき別のタブを見ていた人には何も残らず、
  // 「頼んだはずなのに何も無い」になる。
  const failed = store.orders.filter((o) => o.state === ORDER_FAILED);
  if (failed.length > 0) list.append(failedBox(failed));

  const state = loadState();
  const posts = minePosts(store, { repo: mineFilter, isDone: (id) => Boolean(state[id]?.done) });
  const counts = repoCounts(store);

  if (counts.length > 1) list.append(mineFilterBar(counts, store));

  if (posts.length === 0) {
    list.append(
      emptyBox(
        store.posts.length === 0
          ? '作った投稿はまだありません。\n上でアプリを選んで［この内容で頼む］を押すと、1〜2分でここに並びます。'
          : 'この絞りこみに当てはまる投稿はありません。'
      )
    );
  } else {
    for (const post of posts) list.append(minePostCard(post, state[post.id] || {}));
    prefetchMedia(posts);
  }

  if (store.posts.length > 0) list.append(backupBox(store));
}

/** ［つくる］の入力。押すまでは端末の外に何も出ない。 */
function orderForm() {
  const box = document.createElement('div');
  box.className = 'card make';

  const title = document.createElement('p');
  title.className = 'sendbar__text';
  title.textContent = 'アプリを選んで、宣伝の投稿を作ってもらう';
  box.append(title);

  const apps = data.apps ?? [];
  if (apps.length === 0) {
    const help = document.createElement('p');
    help.className = 'steps__guide';
    help.textContent =
      'アプリの一覧をまだ読み込めていません。週次の生成が一度も動いていないか、古い版が端末に残っています。';
    box.append(help);
    return box;
  }

  const chosen = apps.find((a) => a.name === makeRepo) ?? null;

  // ── ① アプリ ──
  box.append(fieldLabel('① どのアプリの投稿にしますか'));

  if (chosen) {
    const picked = document.createElement('div');
    picked.className = 'make__picked';

    const name = document.createElement('p');
    name.className = 'make__pickedName';
    name.textContent = chosen.name;
    picked.append(name);

    const one = document.createElement('p');
    one.className = 'make__pickedOne';
    one.textContent = chosen.oneLine || '';
    picked.append(one);

    if (!chosen.hasPages) {
      // 公開 URL が無いアプリ（拡張機能・GAS など）は、投稿にリンクを置けない。
      // 押せなくはしないが、出したあとで気づくことにならないよう先に言う。
      const warn = document.createElement('p');
      warn.className = 'make__warn';
      warn.textContent = 'このアプリはブラウザで直接ひらく形ではないので、リンクの返信が付かないことがあります。';
      picked.append(warn);
    }

    const change = button('別のアプリにする', 'btn btn--sub');
    change.addEventListener('click', () => {
      makeRepo = '';
      render();
    });
    picked.append(change);
    box.append(picked);
  } else {
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'make__search';
    search.placeholder = 'アプリ名・教科・学年でさがす';
    search.value = appQuery;
    search.setAttribute('aria-label', 'アプリをさがす');
    box.append(search);

    const results = document.createElement('div');
    results.className = 'make__apps';
    box.append(results);

    const draw = () => {
      results.innerHTML = '';
      const hits = matchApps(apps, appQuery);
      for (const app of hits.slice(0, APP_LIST_MAX)) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'make__app';

        const name = document.createElement('span');
        name.className = 'make__appName';
        name.textContent = app.name;
        row.append(name);

        const meta = document.createElement('span');
        meta.className = 'make__appMeta';
        meta.textContent = [app.subject, app.grade].filter(Boolean).join(' / ');
        row.append(meta);

        const one = document.createElement('span');
        one.className = 'make__appOne';
        one.textContent = app.oneLine || '';
        row.append(one);

        row.addEventListener('click', () => {
          makeRepo = app.name;
          appQuery = '';
          render();
        });
        results.append(row);
      }

      const note = document.createElement('p');
      note.className = 'make__count';
      note.textContent =
        hits.length === 0
          ? '見つかりませんでした。ひらがな・英字のつづりを変えてみてください。'
          : hits.length > APP_LIST_MAX
            ? `${hits.length} 件のうち ${APP_LIST_MAX} 件を出しています。しぼりこんでください。`
            : `${hits.length} 件`;
      results.append(note);
    };

    // ⚠️ ここで render() を呼ばない。一覧ごと作りなおすと入力欄が作りかえられ、
    //    1文字打つたびにキーボードが閉じる。書きかえるのは結果のところだけにする。
    search.addEventListener('input', () => {
      appQuery = search.value;
      draw();
    });
    draw();
  }

  // ── ② 本数 ──
  box.append(fieldLabel('② 何本つくりますか'));
  const counts = document.createElement('div');
  counts.className = 'make__row';
  for (let n = MIN_COUNT; n <= MAX_COUNT; n += 1) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jump__btn' + (n === makeCount ? ' is-on' : '');
    b.textContent = `${n}本`;
    b.setAttribute('aria-pressed', String(n === makeCount));
    b.addEventListener('click', () => {
      makeCount = n;
      render();
    });
    counts.append(b);
  }
  box.append(counts);

  // ── ③ 型 ──
  box.append(fieldLabel(`③ 投稿の型（選ばなければおまかせ・${MAX_THEMES}つまで）`));
  const themes = document.createElement('div');
  themes.className = 'make__row';

  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'jump__btn' + (makeThemes.size === 0 ? ' is-on' : '');
  auto.textContent = 'おまかせ';
  auto.addEventListener('click', () => {
    makeThemes.clear();
    render();
  });
  themes.append(auto);

  for (const theme of data.themes ?? []) {
    const b = document.createElement('button');
    b.type = 'button';
    const on = makeThemes.has(theme.id);
    b.className = 'jump__btn' + (on ? ' is-on' : '');
    b.textContent = theme.label;
    b.title = theme.intent ?? '';
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => {
      if (on) makeThemes.delete(theme.id);
      else if (makeThemes.size >= MAX_THEMES) {
        toast(`型は${MAX_THEMES}つまでです。どれかを外してから選んでください`);
        return;
      } else makeThemes.add(theme.id);
      render();
    });
    themes.append(b);
  }
  box.append(themes);

  // ── ④ 切り口 ──
  box.append(fieldLabel('④ こういう切り口で、があれば（任意）'));
  const note = document.createElement('textarea');
  note.className = 'editor__area';
  note.rows = 2;
  note.maxLength = MAX_NOTE_CHARS;
  note.placeholder = '例）2学期のはじめに使う場面で／低学年の先生に向けて';
  note.value = makeNote;
  note.setAttribute('aria-label', '切り口の指定');
  note.addEventListener('input', () => {
    makeNote = note.value;
  });
  box.append(note);

  // ── 送る ──
  const row = document.createElement('div');
  row.className = 'card__actions';

  const ask = button('この内容で頼む', 'btn btn--x');
  ask.addEventListener('click', () => submitOrder());
  row.append(ask);
  box.append(row);

  const guide = document.createElement('p');
  guide.className = 'steps__guide';
  guide.textContent =
    'GitHub の画面がひらきます。緑の［Create］を押すと作りはじめ、1〜2分でこの画面に並びます。' +
    '（文章を作るのに AI を使うので、この端末からは直接呼べません）';
  box.append(guide);

  return box;
}

/** 一覧に出すアプリの上限。 */
const APP_LIST_MAX = 12;

function fieldLabel(text) {
  const p = document.createElement('p');
  p.className = 'make__label';
  p.textContent = text;
  return p;
}

/** 注文を送る。Issue の作成画面をひらいて、控えを端末に残す。 */
function submitOrder() {
  if (!makeRepo) {
    toast('先にアプリを選んでください');
    return;
  }
  if (!data.repoUrl) {
    toast('送り先が分かりません（launcher.json が古い可能性があります）');
    return;
  }

  const order = buildOrder({
    orderId: newOrderId(),
    repo: makeRepo,
    count: makeCount,
    themes: [...makeThemes],
    note: makeNote,
    askedAtJst: jstStamp(),
  });

  // ⚠️ window.open は同期で、いちばん先に呼ぶ。
  //    ここより前に await を挟むと「ユーザー操作の直後」の資格が切れて、
  //    iOS Safari のポップアップブロックに落ちる。共有シートとまったく同じ話。
  const themeLabels = Object.fromEntries((data.themes ?? []).map((t) => [t.id, t.label]));
  window.open(buildOrderIssueUrl(data.repoUrl, order, { themeLabels }), '_blank', 'noopener');

  // 実際に送信ボタンを押したかは取れない。ひらいたところまでを控えておき、
  // 押し忘れたときのために［取り消す］を出しておく。
  saveMine(
    addOrder(loadMine(), {
      id: order.orderId,
      repo: order.repo,
      count: order.count,
      themes: order.themes,
      note: order.note,
      askedAtJst: order.askedAtJst,
      state: ORDER_WAITING,
    })
  );
  makeNote = '';
  render();
  scheduleOrderCheck();
  toast('GitHub の画面をひらきました。緑の［Create］を押すと作りはじめます');
}

/** 頼んだまま届いていない注文。 */
function pendingBox(pending) {
  const box = document.createElement('div');
  box.className = 'sendbar';

  const text = document.createElement('p');
  text.className = 'sendbar__text';
  text.textContent = `${pending.length} 件たのんでいます`;
  box.append(text);

  for (const order of pending) {
    const line = document.createElement('p');
    line.className = 'steps__guide';
    line.textContent = `${order.repo} を ${order.count} 本（${order.askedAtJst || '時刻不明'}）`;
    box.append(line);
  }

  const row = document.createElement('div');
  row.className = 'card__actions';

  const check = button('届いたか見る', 'btn btn--x');
  check.addEventListener('click', async () => {
    check.disabled = true;
    check.textContent = '見ています…';
    const { got, still } = await checkOrders({ quiet: false });
    check.disabled = false;
    if (got === 0 && still > 0) {
      toast('まだできていません。1〜2分ほどかかります（GitHub の［Create］は押しましたか）');
    }
    render();
  });
  row.append(check);

  for (const order of pending) {
    const cancel = button(pending.length > 1 ? `${order.repo} を取り消す` : '取り消す', 'btn btn--sub');
    cancel.addEventListener('click', () => {
      // 消すのは端末の控えだけ。Issue はそのまま残るので、作られたものは
      // GitHub のコメントで読める（黙って無かったことにはならない）。
      saveMine(dropOrder(loadMine(), order.id));
      render();
      toast('待つのをやめました。GitHub 側で作られたものはコメントに残ります');
    });
    row.append(cancel);
  }

  box.append(row);
  return box;
}

/**
 * 作れなかった注文。
 *
 * 多くは生成した文がガードレール検査に落ちた場合である
 * （機械が知らないはずの教室の様子を書いた、など）。
 * 何が起きたのかを画面に残さないと、頼んだ人には「無かったこと」に見える。
 */
function failedBox(failed) {
  const box = document.createElement('div');
  box.className = 'sendbar';

  const text = document.createElement('p');
  text.className = 'sendbar__text';
  text.textContent = `${failed.length} 件は作れませんでした`;
  box.append(text);

  for (const order of failed) {
    const line = document.createElement('p');
    line.className = 'steps__guide';
    line.textContent = `${order.repo}: ${order.message || '理由が分かりません'}`;
    box.append(line);
  }

  const help = document.createElement('p');
  help.className = 'steps__guide';
  help.textContent = '切り口の一言を足して、もう一度頼んでみてください。作られたものがあれば GitHub のコメントに残っています。';
  box.append(help);

  const row = document.createElement('div');
  row.className = 'card__actions';
  const close = button('分かった', 'btn btn--sub');
  close.addEventListener('click', () => {
    let store = loadMine();
    for (const order of failed) store = dropOrder(store, order.id);
    saveMine(store);
    render();
  });
  row.append(close);
  box.append(row);

  return box;
}

/** アプリごとの絞りこみ。 */
function mineFilterBar(counts, store) {
  const bar = document.createElement('div');
  bar.className = 'jump';

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'jump__btn' + (mineFilter === '' ? ' is-on' : '');
  all.textContent = `すべて（${store.posts.length}）`;
  all.addEventListener('click', () => {
    mineFilter = '';
    render();
  });
  bar.append(all);

  for (const [repo, n] of counts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jump__btn' + (mineFilter === repo ? ' is-on' : '');
    b.textContent = `${repo}（${n}）`;
    b.addEventListener('click', () => {
      mineFilter = mineFilter === repo ? '' : repo;
      render();
    });
    bar.append(b);
  }
  return bar;
}

/** 作らせた投稿1件。週の投稿と同じカードに、消すところだけ足す。 */
function minePostCard(post, saved) {
  const card = postCard(post, saved, todayJst());

  // ⚠️ 消す操作は［…］の中に入れる。
  //    ここに貯まっているものは、この端末のなかにしか無い。
  //    毎日押すボタンの隣に置いておくものではない。
  const drop = addToMore(card, 'この投稿を消す', 'more__item--danger', () => {
    // 一度きりの確認を入れる。ここにしか無いものを、押し間違いで消せてはいけない。
    if (drop.dataset.armed !== 'yes') {
      drop.dataset.armed = 'yes';
      drop.textContent = '本当に消す（もう一度押す）';
      setTimeout(() => {
        drop.dataset.armed = '';
        drop.textContent = 'この投稿を消す';
      }, 4000);
      return;
    }
    saveMine(dropPost(loadMine(), post.id));
    render();
    toast('消しました');
  });

  return card;
}

/**
 * 端末の外に逃がす道。
 *
 * ここに貯まっているものは、この端末のなかにしか無い。
 * ブラウザのデータを消せば消えるし、機種変更でも消える。
 * 取り返す手段が無いのは怖いので、書き出しと読みこみを置いておく。
 */
function backupBox(store) {
  const box = document.createElement('div');
  box.className = 'card make';

  const title = document.createElement('p');
  title.className = 'sendbar__text';
  title.textContent = 'この端末のバックアップ';
  box.append(title);

  const help = document.createElement('p');
  help.className = 'steps__guide';
  help.textContent =
    `作った投稿 ${store.posts.length} 件は、この端末のなかにしかありません。` +
    'ブラウザのデータを消すと一緒に消えます。書き出してメモアプリなどに貼っておけば、別の端末でも読みこめます。';
  box.append(help);

  const row = document.createElement('div');
  row.className = 'card__actions';

  const out = button('書き出す（コピー）', 'btn btn--sub');
  out.addEventListener('click', async () => {
    const ok = await copyText(toBackupText(loadMine()));
    toast(ok ? `${store.posts.length} 件をコピーしました。メモアプリなどに貼って保存してください` : 'コピーできませんでした');
  });
  row.append(out);

  const inBtn = button('読みこむ', 'btn btn--sub');
  inBtn.addEventListener('click', () => openImport(box));
  row.append(inBtn);

  box.append(row);
  return box;
}

function openImport(box) {
  if (box.querySelector('.editor')) return;

  const editor = document.createElement('div');
  editor.className = 'editor';

  const area = document.createElement('textarea');
  area.className = 'editor__area';
  area.rows = 5;
  area.placeholder = '書き出したものを貼り付けてください';
  area.setAttribute('aria-label', '書き出したバックアップ');

  const row = document.createElement('div');
  row.className = 'card__actions';

  const go = button('読みこむ', 'btn btn--done');
  go.addEventListener('click', () => {
    const { store, added, error } = fromBackupText(loadMine(), area.value);
    if (error) {
      toast(error);
      return;
    }
    saveMine(store);
    render();
    toast(added > 0 ? `${added} 件を足しました` : 'すべてこの端末にすでにありました');
  });

  const cancel = button('やめる', 'btn btn--sub');
  cancel.addEventListener('click', () => editor.remove());

  row.append(go, cancel);
  editor.append(area, row);
  box.append(editor);
  area.focus();
}

/* ── 届いたかを見にいく ─────────────────────── */

/**
 * 頼んだ注文の結果を拾いにいく。
 *
 * 置き場は同一オリジンの docs/orders/<注文ID>.json。
 * まだ無ければ 404 が返る（＝作っている最中）。
 *
 * ⚠️ cache: 'no-store' を付ける。ここは「さっきまで無かったものが増える」場所なので、
 *    一度でも 404 をキャッシュされると、以後いつまでも届かない。
 *    Service Worker 側も /orders/ をキャッシュしない（docs/sw.js）。
 */
async function checkOrders({ quiet = true } = {}) {
  const pending = waitingOrders(loadMine());
  let got = 0;

  for (const order of pending) {
    // 端末に残っている控えが壊れていることがある（古い版・手で触った localStorage）。
    // resultPathOf は形の違う注文IDで投げるので、ここで受けないと以降の注文まで見にいけなくなる。
    let path;
    try {
      path = resultPathOf(order.id);
    } catch {
      saveMine(patchOrder(loadMine(), order.id, { state: ORDER_FAILED, message: '注文の控えが壊れています' }));
      continue;
    }

    let result = null;
    try {
      const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) continue; // まだできていない
      result = await res.json();
    } catch {
      continue; // 圏外・作成中。次に見にきたときに拾う
    }

    const { ok, errors } = validateResult(result, { orderId: order.id });
    if (!ok) {
      // 壊れたものを端末に貯めない。何が起きたかは残す。
      saveMine(patchOrder(loadMine(), order.id, { state: ORDER_FAILED, message: errors[0] }));
      continue;
    }

    if (result.posts.length === 0) {
      // 作れなかった、も結果である。ここで受け取らないと画面が永久に「たのんでいます」になる。
      saveMine(patchOrder(loadMine(), order.id, { state: ORDER_FAILED, message: result.message || '作れませんでした' }));
      if (!quiet) toast(`${order.repo}: ${result.message || '作れませんでした'}`);
      continue;
    }

    const { store, added } = addPosts(loadMine(), result.posts, {
      orderId: order.id,
      gallery: result.gallery ?? null,
      gotAtJst: jstStamp(),
    });
    saveMine(patchOrder(store, order.id, { state: ORDER_DONE, gotAtJst: jstStamp() }));
    got += added;
  }

  if (got > 0) {
    // 届いたことは、そのタブを見ていなくても分かるようにする。
    toast(`できあがりました（${got} 本）。［つくる］に並んでいます`);
    updateSummary();
  }

  const still = waitingOrders(loadMine()).length;
  return { got, still };
}

/**
 * 届くまで、間を空けて見にいく。
 *
 * 生成に30秒ほど、GitHub Pages への配信にもう1分ほどかかる。
 * 短い間隔で叩いても早く届くわけではないので、だんだん間を空ける。
 * 5分ほど見て届かなければやめる（そのときは［届いたか見る］を手で押せる）。
 */
const CHECK_DELAYS = [20_000, 20_000, 30_000, 30_000, 45_000, 60_000, 60_000];
let checkTimer = null;
let checkAt = 0;

function scheduleOrderCheck(step = 0) {
  clearTimeout(checkTimer);
  if (step >= CHECK_DELAYS.length) return;
  if (waitingOrders(loadMine()).length === 0) return;

  checkAt = step;
  checkTimer = setTimeout(async () => {
    const { got, still } = await checkOrders();
    if (got > 0 && view === 'make') render();
    if (still > 0) scheduleOrderCheck(checkAt + 1);
  }, CHECK_DELAYS[step]);
}

/* ────────────────────────────────────────────
 *  note
 * ──────────────────────────────────────────── */

function renderNotes(list) {
  const articles = data.noteArticles ?? [];

  if ((!data.notes || data.notes.length === 0) && articles.length === 0) {
    list.append(
      emptyBox(
        'note の下書きがまだありません。\n日曜の夜に週1本ぶんが自動で用意されます。\n\n' +
          'アプリのリポジトリの docs/note/ に記事を置いてあれば、それもここに出ます。'
      )
    );
    return;
  }

  const state = loadState();

  // アプリのリポジトリに用意された記事を先に出す。
  // こちらは本人が書き上げたもので、機械の下書きより先に出したいものだからである。
  if (articles.length > 0) {
    list.append(sectionLabel(`リポジトリに用意された記事（${articles.length}本）`));
    for (const entry of articles) list.append(articleCard(entry, state[articleStateId(entry)] || {}));
    if (data.notes && data.notes.length > 0) list.append(sectionLabel('今週の下書き（自動生成）'));
  }

  for (const note of data.notes ?? []) {
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
    preview.textContent = bodyPreview(note.title, note.plain);
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

    // タイトルは note の別の欄に貼るもの。本文の次に必ず押すので外に出しておく。
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

/* ────────────────────────────────────────────
 *  note — アプリのリポジトリに用意された記事
 *
 * 週の下書き（自動生成）との違いは、出どころと画像である。
 * こちらはアプリを作った本人が、そのアプリのリポジトリの中で書き上げたもので、
 * 実際に操作して撮った画面が十数点ついている。
 *
 * note には公式の投稿 API が無く、画像を上げる口も無い。
 * だからここでの仕事は「順番どおりに、迷わず渡せる形にする」ことに尽きる。
 *   ① 本文をコピーして note を開く（画像の位置には ［画像1: …］ という目印が入っている）
 *   ② 画像を上から1枚ずつ共有シートに渡す（目印と同じ番号が画面に出ている）
 * 本文は7,900字あるので launcher.json には載せていない。開いたときに読みにいく。
 * ──────────────────────────────────────────── */

/** 読みこんだ記事。id で持つ（同じ記事を何度も取りにいかない）。 */
const articleCache = new Map();
/** 読んでいる最中のもの。押した瞬間に「準備中」と「壊れている」を区別するために要る。 */
const articlePending = new Map();
/** 読めなかった記事と、その理由。画面に出す。 */
const articleFailed = new Map();

/** 端末に残す印（公開した・どの画像まで渡したか）のキー。 */
function articleStateId(entry) {
  return `note-article-${entry.id}`;
}

/** 一覧のあいだに置く見出し。どちらの記事を見ているのかが分からなくなるのを防ぐ。 */
function sectionLabel(text) {
  const p = document.createElement('p');
  p.className = 'section';
  p.textContent = text;
  return p;
}

/**
 * 記事の本文を読みにいく。
 *
 * ⚠️ launcher.json の src をそのまま fetch に渡さない。
 *    id から組みなおしたパスだけを使う（docs/lib/note-doc.js の articlePathOf が形を見ている）。
 *    生成物とはいえ、もとはアプリのリポジトリ名という外から来た文字列である。
 */
function loadNoteArticle(entry) {
  if (articleCache.has(entry.id)) return Promise.resolve(articleCache.get(entry.id));
  if (articlePending.has(entry.id)) return articlePending.get(entry.id);

  let path;
  try {
    path = articlePathOf(entry.id);
  } catch (error) {
    articleFailed.set(entry.id, error.message);
    return Promise.resolve(null);
  }

  const task = fetch(path, { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((json) => {
      const { ok, errors, article } = validateArticle(json, { id: entry.id });
      if (!ok) throw new Error(errors.join(' / '));
      articleCache.set(entry.id, article);
      articleFailed.delete(entry.id);
      return article;
    })
    .catch((error) => {
      articleFailed.set(entry.id, error.message);
      console.warn(`記事を読めませんでした: ${entry.id}`, error);
      return null;
    })
    .finally(() => articlePending.delete(entry.id));

  articlePending.set(entry.id, task);
  return task;
}

function articleCard(entry, saved) {
  const card = document.createElement('article');
  card.className = 'card' + (saved.done ? ' is-done' : '');

  const meta = document.createElement('div');
  meta.className = 'card__meta';
  meta.append(chip(entry.repo), chip(`${entry.charCount}字`), chip(`画像${entry.imageCount}点`), chip('用意ずみ'));
  card.append(meta);

  const title = document.createElement('p');
  title.className = 'card__text card__text--title';
  title.textContent = entry.title;
  card.append(title);

  const preview = document.createElement('p');
  preview.className = 'card__text card__text--preview';
  preview.textContent = '本文を読み込んでいます…';
  card.append(preview);

  // 出す前に本人が見るべきこと（画像が足りない、連載の書き方から外れている、など）。
  // 押す前に見えていないと、直す機会は投稿後にしか来ない。
  const notes = document.createElement('div');
  notes.className = 'notes';
  notes.hidden = true;
  card.append(notes);

  const actions = document.createElement('div');
  actions.className = 'card__actions';

  const go = button('本文をコピーして note を開く', 'btn btn--note');
  go.addEventListener('click', () => {
    const article = articleCache.get(entry.id);
    if (!article) {
      // ⚠️ 読めていないときに window.open だけ先に呼ばない。
      //    貼るものが無いまま note の新規記事が開くと、書きかけの記事が1本増えるだけになる。
      toast(articleFailed.get(entry.id) ? '記事を読み取れませんでした' : '本文を読み込んでいます。もう一度押してください');
      loadNoteArticle(entry).then(() => fill());
      return;
    }
    // note には公式の投稿 API が無く、非公式 API は規約に触れる。
    // ここも週の下書きと同じで、「クリップボードに入れてエディタを開く」までにする。
    //
    // ⚠️ window.open を先に、コピーを後に。逆にすると iOS Safari で新しいタブが開かない。
    window.open(noteEditorUrl(), '_blank', 'noopener');
    copyText(article.plain).then((ok) => {
      toast(
        ok
          ? `コピーしました。貼ったあと、［画像1: …］の位置に画像を入れてください（${article.images.length}点）`
          : 'コピーできませんでした。本文を長押しで選んでください'
      );
    });
  });
  actions.append(go);

  const copyTitle = button('タイトルをコピー', 'btn btn--sub');
  copyTitle.addEventListener('click', async () => {
    toast((await copyText(entry.title)) ? 'タイトルをコピーしました' : 'コピーできませんでした');
  });
  actions.append(copyTitle);

  const shotsBox = document.createElement('div');
  shotsBox.className = 'shots';
  shotsBox.hidden = true;

  const toggle = button(`画像を1枚ずつ渡す（${entry.imageCount}点）`, 'btn btn--sub');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const article = articleCache.get(entry.id);
    if (!article) {
      toast(articleFailed.get(entry.id) ? '記事を読み取れませんでした' : '読み込んでいます。もう一度押してください');
      loadNoteArticle(entry).then(() => fill());
      return;
    }
    shotsBox.hidden = !shotsBox.hidden;
    toggle.setAttribute('aria-expanded', String(!shotsBox.hidden));
    if (!shotsBox.hidden && shotsBox.childElementCount === 0) renderArticleShots(shotsBox, entry, article);
  });
  if (entry.imageCount > 0) actions.append(toggle);

  const doneBtn = button(saved.done ? '公開ずみに戻す' : '公開した', 'btn btn--sub' + (saved.done ? '' : ' btn--done'));
  doneBtn.addEventListener('click', () => {
    patchState(articleStateId(entry), { done: !saved.done });
    render();
  });
  actions.append(doneBtn);

  card.append(actions, shotsBox);

  /** 読み終わったら、本文の頭とお知らせを埋める。カード全体は作りなおさない（開いた画像の一覧が閉じる）。 */
  const fill = () => {
    const article = articleCache.get(entry.id);
    if (!article) {
      preview.textContent = `記事を読み取れませんでした（${articleFailed.get(entry.id) ?? '理由不明'}）`;
      return;
    }
    preview.textContent = bodyPreview(article.title, article.plain);

    const lines = [
      ...article.problems,
      ...article.styleWarnings.map((w) => `書き方: ${w}`),
      article.imagesInText > article.images.length
        ? `本文には画像が${article.imagesInText}点ありますが、渡せるのは${article.images.length}点です`
        : null,
    ].filter(Boolean);

    notes.innerHTML = '';
    notes.hidden = lines.length === 0;
    for (const line of lines) {
      const p = document.createElement('p');
      p.className = 'notes__line';
      p.textContent = line;
      notes.append(p);
    }
  };

  loadNoteArticle(entry).then(() => fill());
  return card;
}

/**
 * 画像を1枚ずつ渡すところ。
 *
 * 上から順に渡していけば、本文に入っている ［画像1: …］ の目印と番号が合う。
 * 27点ある記事もあるので、どこまで渡したかを端末に残す。
 * 残さないと、途中で中断したときに「次はどれだったか」を数えなおすことになる。
 */
function renderArticleShots(box, entry, article) {
  const stateId = articleStateId(entry);

  const guide = document.createElement('p');
  guide.className = 'shots__guide';
  guide.textContent =
    '本文を貼ったあと、上から順に渡してください。渡した画像は note の ［画像n: …］ の行と入れかえて、その行を消します。';
  box.append(guide);

  for (const [at, image] of article.images.entries()) {
    box.append(articleShotRow(stateId, entry, article, image, at));
  }

  // 先の数枚だけ先に読んでおく。押してから読みにいくと、その待ち時間で
  // 「操作の直後」ではなくなり iOS で share() が拒否される。
  // ⚠️ 全部は読まない。1本ぶんで5MBほどある（KANJI_Town の記事は27点）。
  prefetchArticleImages(entry, article, 0);
}

function articleShotRow(stateId, entry, article, image, at) {
  const row = document.createElement('div');
  row.className = 'shot';
  const doneList = () => loadState()[stateId]?.images ?? [];
  if (doneList().includes(image.n)) row.classList.add('is-done');

  const img = document.createElement('img');
  img.className = 'shot__img';
  img.src = image.src;
  img.alt = image.label;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    mediaFailed.add(image.src);
    row.classList.add('is-broken');
  });
  row.append(img);

  const body = document.createElement('div');
  body.className = 'shot__body';

  const head = document.createElement('p');
  head.className = 'shot__head';
  head.textContent = `${markerFor(image)}`;
  body.append(head);

  if (image.caption) {
    const caption = document.createElement('p');
    caption.className = 'shot__caption';
    caption.textContent = image.caption;
    body.append(caption);
  }

  const actions = document.createElement('div');
  actions.className = 'shot__actions';

  const share = button('この画像を渡す', 'btn btn--sub');
  share.addEventListener('click', () => shareArticleImage(entry, article, image, at, share, row));
  actions.append(share);

  if (image.caption) {
    const copyCaption = button('説明をコピー', 'btn btn--sub');
    copyCaption.addEventListener('click', async () => {
      toast((await copyText(image.caption)) ? 'note のキャプション欄に貼れます' : 'コピーできませんでした');
    });
    actions.append(copyCaption);
  }

  // 共有シートを使わずに（PC でダウンロードした、前に上げてあった）進めることもある。
  // 手で印を付け外しできないと、そこで並びの意味が失われる。
  const mark = button(doneList().includes(image.n) ? '印を消す' : '渡した', 'btn btn--sub shot__mark');
  mark.addEventListener('click', () => {
    const done = doneList();
    const next = done.includes(image.n) ? done.filter((n) => n !== image.n) : [...done, image.n];
    patchState(stateId, { images: next });
    const isDone = next.includes(image.n);
    row.classList.toggle('is-done', isDone);
    mark.textContent = isDone ? '印を消す' : '渡した';
  });
  actions.append(mark);

  body.append(actions);
  row.append(body);
  return row;
}

/**
 * 画像1枚を共有シートに渡す。
 *
 * X に出すときと同じ仕組み（navigator.share）だが、渡すのは画像だけである。
 * note のエディタに直接入れる口は無いので、共有シートから「画像を保存」するか、
 * note のアプリを選んで開く、という形になる。
 */
async function shareArticleImage(entry, article, image, at, btn, row) {
  const item = { src: image.src, kind: 'repo', label: image.label };
  const file = fileCache.get(image.src);

  if (!file) {
    // まだ読めていない。X の共有とまったく同じで、待たずに「もう一度」を返す
    // （待つと「操作の直後」でなくなり、iOS で share() そのものが拒否される）。
    loadMediaFile({ repo: article.repo }, item, at).then(() => {});
    toast(mediaFailed.has(image.src) ? '画像を読み込めませんでした（圏外かもしれません）' : '画像を準備しています。もう一度押してください');
    return;
  }

  // 画像のあとに貼るものを、先にクリップボードへ入れておく。
  // await しないのは、ここで待つと share() が「操作の直後」でなくなるためである。
  if (image.caption) copyText(image.caption);

  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      // 共有シートを持たない環境（PC の Chrome など）。開いて保存してもらう。
      const a = document.createElement('a');
      a.href = image.src;
      a.download = fileNameFor(article.repo, item, at);
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
    }
  } catch (error) {
    // 共有シートを閉じただけでも AbortError が来る。これは失敗ではない。
    if (error && error.name === 'AbortError') return;
    console.warn('画像を渡せませんでした', error);
    toast('渡せませんでした。画像を長押しで保存してください');
    return;
  }

  // 渡したところまでを残す。次に開いたときに、どこから続ければよいかが分かる。
  const done = loadState()[articleStateId(entry)]?.images ?? [];
  if (!done.includes(image.n)) patchState(articleStateId(entry), { images: [...done, image.n] });
  row.classList.add('is-done');
  const mark = row.querySelector('.shot__mark');
  if (mark) mark.textContent = '印を消す';
  btn.textContent = '渡しました';
  setTimeout(() => {
    btn.textContent = 'この画像を渡す';
  }, 2500);

  if (image.caption) toast('説明もコピーしました。note のキャプション欄に貼れます');

  // 次に押すぶんを読んでおく。
  prefetchArticleImages(entry, article, at + 1);
}

/**
 * これから渡すぶんの画像を、少しだけ先に読んでおく。
 *
 * ⚠️ 全部は読まない。記事1本ぶんで数MBある。
 *    通勤中に note タブを開いただけで通信量を使いきる、という形にはしない。
 */
function prefetchArticleImages(entry, article, from, count = 3) {
  for (const [at, image] of article.images.entries()) {
    if (at < from || at >= from + count) continue;
    loadMediaFile({ repo: article.repo }, { src: image.src, kind: 'repo', label: image.label }, at);
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

  // タブを開かないと分からないことを、バッジで外に出す。
  // タブが4つになったぶん1つあたりが持つ中身は増えたので、
  // 「開かないと分からない」を減らさないと、集約したぶんだけ見落としが増える。
  const state = loadState();

  // ① 出す … 今日ぶんの残り
  const left = selectPosts({
    posts: data.posts ?? [],
    state,
    view: 'today',
    today: todayJst(),
    activeWeeks: activeWeekIds(data),
  }).length;
  setTabBadge('post', left, `出す（今日はあと ${left} 件）`, '出す');

  // ② 記録 … まだ送っていない記録
  const pending = unsentRecords({ posts: recordablePosts(), state }).length;
  setTabBadge('log', pending, `記録（未送信の記録 ${pending} 件）`, '記録');

  // ③ つくる … 頼んだまま届いていない注文
  const waiting = waitingOrders(loadMine()).length;
  setTabBadge('make', waiting, `つくる（待っている注文 ${waiting} 件）`, 'つくる');
}

function setTabBadge(tabId, count, onLabel, offLabel) {
  const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (!tab) return;
  tab.dataset.badge = count > 0 ? String(count) : '';
  tab.setAttribute('aria-label', count > 0 ? onLabel : offLabel);
}

/* ────────────────────────────────────────────
 *  起動
 * ──────────────────────────────────────────── */

/**
 * 見るものを切りかえる。
 *
 * name は view（today / week / now / make / note / done / past）で受ける。
 * タブは4つだが、今日・今週・予備は「出す」の中の、投稿ずみ・過去は「記録」の中の
 * 切りかえである（docs/lib/select.js の TABS）。
 * 送信ずみの Issue に残っている `#now` `#done` のリンクを、これまでどおり効かせるため。
 */
function selectTab(name, { focus = false } = {}) {
  if (!VIEWS.includes(name)) name = VIEWS[0];
  view = name;

  const tab = tabOfView(name);
  const list = document.getElementById('list');
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.tab === tab.id;
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
    // タブを押したら、そのタブの最初のものを見せる。
    // 前に見ていた中身を覚えておくと、［記録］を押したのに［過去］が出る、
    // という「押した名前と出るものが違う」状態になる。
    tab.addEventListener('click', () => selectTab(firstViewOf(tab.dataset.tab)));
    tab.addEventListener('keydown', (event) => {
      const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      let next = null;
      if (move) next = tabs[(i + move + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      event.preventDefault();
      selectTab(firstViewOf(next.dataset.tab), { focus: true });
    });
  }
}

/**
 * タブの中の切りかえ（今日 / 今週 / 予備、投稿ずみ / 過去）。
 *
 * ⚠️ タブと同じ見た目にしない。同じに見えると、どちらが上位なのかが分からなくなる。
 *    ここは「いま見ているタブの中で、どれを見るか」だけを決める。
 */
function segmentBar() {
  const tab = tabOfView(view);
  if (tab.views.length < 2) return null;

  const bar = document.createElement('div');
  bar.className = 'seg';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', `${tab.label}の中の切りかえ`);

  for (const item of tab.views) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg__btn' + (item.id === view ? ' is-on' : '');
    b.textContent = item.label;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(item.id === view));
    const count = countFor(item.id);
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'seg__count';
      badge.textContent = String(count);
      b.append(badge);
    }
    b.addEventListener('click', () => selectTab(item.id));
    bar.append(b);
  }
  return bar;
}

/** その切りかえに何件あるか。数が見えていないと、押してみるまで空かどうか分からない。 */
function countFor(name) {
  if (name === 'now') return (data.stock ?? []).length;
  return selectPosts({
    posts: poolFor(name),
    state: loadState(),
    view: name,
    today: todayJst(),
    activeWeeks: activeWeekIds(data),
  }).length;
}

/** 通知の Issue から #done、アプリ一覧から #make/Qalc で飛んでこられるようにする。 */
function viewFromHash() {
  return routeFromHash(location.hash, VIEWS, (data.apps ?? []).map((a) => a.name));
}

/** ハッシュを読んでタブを切りかえる。アプリの指定があれば選んでおく。 */
function applyHash() {
  const { view: name, repo } = viewFromHash();
  if (repo) makeRepo = repo;
  selectTab(name);
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
/**
 * ［本文を直す］で開いている書きかけを、端末に控える。
 *
 * 打ちかけの文は、押すまで DOM のなかにしか無い。
 * Chromebook はメモリが足りなくなるとタブを黙って捨てるので、
 * 「書いていたのに戻ってきたら消えていた」が起きる。しかも理由が誰にも見えない。
 * 確定（editedText）とは別の場所に置く。控えただけのものを確定にすると、
 * 押していない文が「手直しずみ」として出てしまう。
 */
function saveOpenDrafts() {
  for (const area of document.querySelectorAll('.editor__area[data-draft-id]')) {
    const id = area.dataset.draftId;
    const base = area.dataset.draftBase ?? '';
    const saved = loadState()[id] ?? {};
    const effective = typeof saved.editedText === 'string' && saved.editedText.trim() ? saved.editedText : base;
    const value = area.value.trim();
    if (value && value !== effective) patchState(id, { draftText: value });
    else if (typeof saved.draftText === 'string') patchState(id, { draftText: null });
  }
}

/**
 * 画面を離れるときに必ず確定させる。
 *
 * ⚠️ beforeunload ではなく pagehide にする。
 *    iOS Safari と、タブを捨てる Chromebook では beforeunload が呼ばれないことがある。
 *    visibilitychange も見るのは、ホーム画面に戻したまま端末がアプリを終わらせる経路が
 *    pagehide を通らないことがあるためである。
 */
function bindPageHide() {
  window.addEventListener('pagehide', saveOpenDrafts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOpenDrafts();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // ⚠️ controllerchange は、はじめて開いたときにも飛んでくる。
  //    activate の clients.claim() でページが管理下に入るためである。
  //    これを素直に受けると「初回訪問が必ず1回リロードされる」。
  //    ［本文を直す］で打ちかけの文があれば、それが消える。
  //
  // ⚠️ 「もともと管理下だったか」で分けるのは駄目である。
  //    入れた直後に［さいしんに する］を押した場合、切り替わったのに読み直されなくなる。
  //    見るのは「利用者が押したかどうか」だけにする。
  let userAskedUpdate = false;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!userAskedUpdate || reloaded) return;
    reloaded = true;
    location.reload();
  });

  const ask = (worker) => {
    showUpdateBar(() => {
      userAskedUpdate = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  navigator.serviceWorker
    .register('sw.js')
    .then((registration) => {
      // controller が居る＝初回インストールではなく更新。
      // 初回で出すと「入れた直後に新しい版があります」と言うことになり、意味が分からない。
      if (registration.waiting && navigator.serviceWorker.controller) ask(registration.waiting);

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) ask(installing);
        });
      });
    })
    .catch(() => {
      // オフライン対応が効かないだけで、画面は動く。
    });
}

/**
 * 新しい版が待っていることを伝える帯。
 *
 * トーストにしないのは、消えてしまうと押す機会が無くなるからである。
 * 押されるまで出したままにする（［あとで］で引っこめられる）。
 */
function showUpdateBar(onAccept) {
  if (document.getElementById('updatebar')) return;

  const bar = document.createElement('div');
  bar.id = 'updatebar';
  bar.className = 'updatebar';
  bar.setAttribute('role', 'status');

  const text = document.createElement('p');
  text.className = 'updatebar__text';
  text.textContent = 'あたらしい版があります';
  bar.append(text);

  const row = document.createElement('div');
  row.className = 'updatebar__row';

  const yes = button('さいしんに する', 'btn btn--done');
  yes.addEventListener('click', () => {
    // 押した時点で、書きかけがあれば端末に控える。読み直しで消えるのを防ぐ。
    saveOpenDrafts();
    text.textContent = '入れかえています…';
    yes.disabled = true;
    onAccept();
  });

  const later = button('あとで', 'btn btn--sub');
  later.addEventListener('click', () => bar.remove());

  row.append(yes, later);
  bar.append(row);
  document.body.append(bar);
}

async function boot() {
  registerServiceWorker();
  bindPageHide();
  bindTabs();
  bindInstall();
  view = viewFromHash().view;
  window.addEventListener('hashchange', applyHash);

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
  //
  // ⚠️ ［つくる］で作った投稿も keepIds に入れる。
  //    あちらは launcher.json に載らないので、入れないと60日で
  //    ［投稿した］や選んだ画像が消える（投稿そのものは残るので、いっそう分かりにくい）。
  const mine = loadMine();
  const { state, removed } = pruneState(loadState(), {
    keepIds: (data.posts ?? [])
      .map((p) => p.id)
      .concat((data.notes ?? []).map((n) => `note-${n.weekId}`))
      // リポジトリに用意された記事の印（公開した・どの画像まで渡したか）も残す。
      // 週の下書きと違って日付を持たないので、消されると「どこまで渡したか」が失われる。
      .concat((data.noteArticles ?? []).map((a) => `note-article-${a.id}`))
      .concat(mine.posts.map((p) => p.id)),
    today: todayJst(),
  });
  if (removed > 0) saveState(state);

  document.getElementById('stamp').textContent = `下書きの作成: ${data.generatedAtJst || '不明'}`;

  // ハッシュにアプリの指定（#make/Qalc）があれば、data を読んだいま反映できる。
  const { repo } = viewFromHash();
  if (repo) makeRepo = repo;

  selectTab(view);

  // 頼んだまま届いていないものがあれば、開いた時点で見にいく。
  // アプリを閉じているあいだに出来上がっていることのほうが多い。
  if (waitingOrders(mine).length > 0) {
    checkOrders().then(({ got }) => {
      if (got > 0) render();
      scheduleOrderCheck();
    });
  }
}

boot();
