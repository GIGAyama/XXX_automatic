/*
 * Service Worker。
 *
 * 目的は2つ。
 *   ① ホーム画面から開いたとき、電波が悪くても画面が出るようにする
 *   ② カード画像を一度読んだら二度目は取りにいかない（通勤中の通信量を減らす）
 *
 * ⚠️ launcher.json だけはキャッシュしない。
 *    ここをキャッシュすると「新しい週の投稿がいつまでも出てこない」という、
 *    原因がとても分かりにくい症状になる。中身が毎週入れかわるファイルなので、
 *    常にネットワークを見にいく。
 *
 * ⚠️ VERSION の行は `npm run build:sw` が書き換える。手で直さないこと。
 *    シェルの中身から計算した値が入っているので、画面を直せば必ず版が変わり、
 *    端末のキャッシュも入れかわる。`npm run check` がずれを検出する。
 */

const VERSION = 'vf7262496';
const SHELL_CACHE = `launcher-shell-${VERSION}`;
const MEDIA_CACHE = `launcher-media-${VERSION}`;

/** 画面を出すのに要る最小限。ここが揃っていれば圏外でも真っ白にならない。 */
const SHELL = ['./', './index.html', './style.css', './app.js', './install-hook.js', './manifest.webmanifest', './offline.html', './apps.css', './lib/jst-client.js', './lib/select.js', './lib/state.js', './lib/format.js', './lib/x-length.js', './lib/feedback-payload.js', './lib/media-pick.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // 1つでも欠けると addAll 全体が失敗する。アイコンなど欠けても動くものは入れない。
      // 実在するかは npm run build:sw / npm run check が先に見ている。
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== MEDIA_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // ── 下書きデータ: 必ずネットワークを見る ──
  if (url.pathname.endsWith('/launcher.json')) {
    event.respondWith(
      fetch(request).catch(() =>
        // 圏外のときだけ、前回の内容を返す。何も出ないよりは古いほうがましである。
        caches.match(request).then((hit) => hit || new Response('{"posts":[],"notes":[]}', { headers: { 'content-type': 'application/json' } }))
      )
    );
    return;
  }

  // ── カード画像: 一度取ったら使いまわす ──
  if (url.pathname.includes('/media/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(MEDIA_CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // ── それ以外（画面の部品）──
  //
  // キャッシュを先に返し、無いときだけ取りにいく。
  //
  // 以前は「キャッシュを返しつつ裏で更新する」形だったが、app.js を
  // lib/*.js に分けたことで、その形は「新しい app.js と古い lib」という
  // 混ざった状態を作れてしまう。1ファイルなら気にならなかった問題である。
  // いまは VERSION がシェルの内容から決まるので、直せば必ず別のキャッシュになり、
  // 版が混ざらない。裏で更新する必要そのものが無くなった。
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./offline.html'));
    })
  );
});
