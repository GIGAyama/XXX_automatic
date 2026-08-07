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
 * ただし2つ気をつける点がある。
 *
 * 1. ユーザー操作の直後でないと share() は拒否される。
 *    ボタンを押してから画像を fetch していると、その待ち時間で
 *    「操作の直後」ではなくなり、iOS で失敗することがある。
 *    そのため画像は表示した時点で先に読みこんでおく（prefetchMedia）。
 *
 * 2. iOS では files と text を一緒に渡すと text が落ちることがある。
 *    そのため share() を呼ぶ前に必ずクリップボードにも本文を入れておく。
 *    落ちても貼り付けで復旧できる。
 */

'use strict';

const STORAGE_KEY = 'launcher:state:v1';
const DATA_URL = 'launcher.json';

/** @type {{posts: any[], notes: any[]}} */
let data = { posts: [], notes: [] };
let view = 'today';

/** 投稿ID → その投稿のカード画像（File）。共有の直前に読みにいかないための先読み置き場。 */
const mediaCache = new Map();

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
  const state = loadState();
  state[id] = { ...(state[id] || {}), ...patch, at: new Date().toISOString() };
  saveState(state);
  return state;
}

/* ────────────────────────────────────────────
 *  日付（端末のタイムゾーンではなく JST で見る）
 * ──────────────────────────────────────────── */

/**
 * 「今日」を JST の YYYY-MM-DD で返す。
 * 端末のタイムゾーンをそのまま使うと、海外にいるときや
 * 端末の設定がずれているときに「今日の投稿」が出てこなくなる。
 * 生成側（scripts/lib/jst.mjs）と同じ基準にそろえる。
 */
function todayJst() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/* ────────────────────────────────────────────
 *  画面
 * ──────────────────────────────────────────── */

function visiblePosts() {
  const state = loadState();
  const today = todayJst();

  if (view === 'done') {
    return data.posts.filter((p) => state[p.id]?.done);
  }
  const undone = data.posts.filter((p) => !state[p.id]?.done);
  if (view === 'today') return undone.filter((p) => p.date <= today);
  return undone;
}

function render() {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (view === 'note') {
    renderNotes(list);
    updateSummary();
    return;
  }

  const posts = visiblePosts();

  if (posts.length === 0) {
    list.append(emptyBox(emptyMessage()));
    updateSummary();
    return;
  }

  const state = loadState();
  const today = todayJst();
  for (const post of posts) list.append(postCard(post, state[post.id] || {}, today));

  updateSummary();
  prefetchMedia(posts);
}

function emptyMessage() {
  if (view === 'done') return 'まだ投稿ずみのものはありません。';
  if (view === 'today') return '今日出すぶんは終わりました。おつかれさまでした。';
  return '投稿の下書きがまだありません。\n日曜の夜に翌週ぶんが自動で用意されます。';
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

  // ── 見出し（日付・枠・型・文字数）──
  const meta = document.createElement('div');
  meta.className = 'card__meta';
  meta.append(
    chip(`${formatDate(post.date)}（${post.weekday}）${post.slotLabel}`, post.date === today ? 'chip--today' : ''),
    chip(post.themeLabel),
    chip(post.repo)
  );
  if (post.weightedLength) {
    const over = post.weightedLength > 280;
    meta.append(chip(`${post.weightedLength}/280`, 'chip--len' + (over ? ' is-over' : '')));
  }
  card.append(meta);

  // ── 画像 ──
  if (post.media) {
    const img = document.createElement('img');
    img.className = 'card__img';
    img.src = post.media;
    img.alt = `${post.repo} の紹介カード`;
    img.loading = 'lazy';
    img.decoding = 'async';
    card.append(img);
  }

  // ── 本文 ──
  const body = document.createElement('p');
  body.className = 'card__text';
  body.textContent = post.text;
  card.append(body);

  // ── ボタン ──
  const actions = document.createElement('div');
  actions.className = 'card__actions';

  const shareBtn = button('𝕏 に共有（画像つき）', 'btn btn--x');
  shareBtn.addEventListener('click', () => shareToX(post, shareBtn));
  actions.append(shareBtn);

  const copyBtn = button('コピーして X を開く', 'btn btn--sub');
  copyBtn.addEventListener('click', () => openIntent(post));
  actions.append(copyBtn);

  if (post.media) {
    const saveBtn = button('画像を保存', 'btn btn--sub');
    saveBtn.addEventListener('click', () => downloadMedia(post));
    actions.append(saveBtn);
  }

  const doneBtn = button(saved.done ? '投稿ずみに戻す' : '投稿した', 'btn btn--sub' + (saved.done ? '' : ' btn--done'));
  doneBtn.addEventListener('click', () => {
    const nowDone = !saved.done;
    patchState(post.id, { done: nowDone });
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
        patchState(post.id, { rating: saved.rating === value ? null : value, theme: post.theme });
        render();
      });
      rate.append(b);
    }
    card.append(rate);
  }

  return card;
}

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
    title.className = 'card__text';
    title.style.fontWeight = '800';
    title.style.paddingBottom = '0';
    title.textContent = note.title;
    card.append(title);

    const preview = document.createElement('p');
    preview.className = 'card__text';
    preview.style.color = 'var(--ink-weak)';
    preview.style.fontSize = '14px';
    preview.textContent = `${note.plain.slice(0, 160)}…`;
    card.append(preview);

    const actions = document.createElement('div');
    actions.className = 'card__actions';

    const go = button('本文をコピーして note を開く', 'btn btn--note');
    go.addEventListener('click', async () => {
      // note には公式の投稿 API が無く、非公式 API は規約に触れる。
      // だからここは「クリップボードに入れてエディタを開く」までにしてある。
      // タイトルは本文と別枠なので、本文の1行目には入れずに案内だけ出す。
      const ok = await copyText(note.plain);
      window.open(data.noteEditorUrl || 'https://note.com/notes/new', '_blank', 'noopener');
      toast(ok ? 'コピーしました。note で貼り付けてください' : 'コピーできませんでした。本文を長押しで選んでください');
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

/* ────────────────────────────────────────────
 *  X へ出す
 * ──────────────────────────────────────────── */

/**
 * 共有シートを開く。ここがこのアプリの心臓部。
 * 画像は prefetchMedia で先に読んであるので、押してすぐ share() に入れる。
 */
async function shareToX(post, btn) {
  // ① 先にクリップボードへ。await しないのは、
  //    ここで待つと「ユーザー操作の直後」の資格を失って share() が拒否されるためである。
  //    iOS で本文が落ちたときの保険なので、間に合わなくても致命的ではない。
  copyText(post.text);

  const file = mediaCache.get(post.id);

  try {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: post.text });
    } else if (navigator.share) {
      // 画像を渡せない環境。本文だけでも共有シートに乗せる。
      await navigator.share({ text: post.text });
    } else {
      // PC の Chrome など、共有シートを持たない環境。
      openIntent(post);
      return;
    }

    // 共有シートを開いたところまでしか分からない（実際に投稿したかは取れない）。
    // 押した本人がいちばん分かっているので、投稿ずみの印は手で付けてもらう。
    btn.textContent = '共有しました';
    setTimeout(() => {
      btn.textContent = '𝕏 に共有（画像つき）';
    }, 2500);
    toast('X を選んで投稿ボタンを押してください');
  } catch (error) {
    // 共有シートを閉じただけでも AbortError が来る。これは失敗ではない。
    if (error && error.name === 'AbortError') return;
    console.warn('share に失敗しました', error);
    toast('共有できませんでした。［コピーして X を開く］をお使いください');
  }
}

/** 本文をコピーして X の投稿画面を開く。画像は付かないので、別途［画像を保存］から添付する。 */
async function openIntent(post) {
  const ok = await copyText(post.text);
  const url = `https://x.com/intent/post?text=${encodeURIComponent(post.text)}`;
  window.open(url, '_blank', 'noopener');
  toast(ok ? 'コピーしました。X の画面が開きます' : 'X の画面を開きました');
}

/** カード画像を端末に保存する。共有シートが使えないときに手で添付するため。 */
function downloadMedia(post) {
  const a = document.createElement('a');
  a.href = post.media;
  a.download = `${post.repo}-card.png`;
  document.body.append(a);
  a.click();
  a.remove();
  toast('画像を保存しました');
}

/**
 * 表示中のカードの画像を File にして先に持っておく。
 * ボタンを押してから読みにいくと、その待ち時間のせいで share() が拒否されることがある。
 */
function prefetchMedia(posts) {
  for (const post of posts) {
    if (!post.media || mediaCache.has(post.id)) continue;
    fetch(post.media)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob) return;
        mediaCache.set(post.id, new File([blob], `${post.repo}-card.png`, { type: 'image/png' }));
      })
      .catch(() => {
        // 画像が無くても本文だけは共有できる。ここで止めない。
      });
  }
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
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function updateSummary() {
  const state = loadState();
  const today = todayJst();
  const todays = data.posts.filter((p) => p.date === today);
  const left = todays.filter((p) => !state[p.id]?.done).length;

  const summary = document.getElementById('summary');
  if (data.posts.length === 0) {
    summary.textContent = '下書きがまだありません';
  } else if (left === 0) {
    summary.textContent = `今日のぶんは終わりました（用意ぜんぶで ${data.posts.length} 件）`;
  } else {
    summary.textContent = `今日はあと ${left} 件（用意ぜんぶで ${data.posts.length} 件）`;
  }
}

/* ────────────────────────────────────────────
 *  起動
 * ──────────────────────────────────────────── */

function bindTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      view = tab.dataset.view;
      for (const t of document.querySelectorAll('.tab')) {
        const on = t === tab;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-selected', String(on));
      }
      render();
    });
  }
}

function bindInstall() {
  const btn = document.getElementById('install');
  const show = () => {
    if (window.__pwaInstallPrompt) btn.hidden = false;
  };
  window.addEventListener('pwa-install-available', show);
  window.addEventListener('pwa-installed', () => {
    btn.hidden = true;
  });
  show();

  btn.addEventListener('click', async () => {
    const prompt = window.__pwaInstallPrompt;
    if (!prompt) return;
    btn.hidden = true;
    prompt.prompt();
    await prompt.userChoice;
    window.__pwaInstallPrompt = null;
  });
}

async function boot() {
  bindTabs();
  bindInstall();

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

  document.getElementById('stamp').textContent = `下書きの作成: ${data.generatedAtJst || '不明'}`;
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // オフライン対応が効かないだけで、画面は動く。
    });
  }
}

boot();
