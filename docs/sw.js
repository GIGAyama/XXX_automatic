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
 */

const VERSION = 'v1';
const SHELL_CACHE = `launcher-shell-${VERSION}`;
const MEDIA_CACHE = `launcher-media-${VERSION}`;

/** 画面を出すのに要る最小限。ここが揃っていれば圏外でも真っ白にならない。 */
const SHELL = ['./', './index.html', './style.css', './app.js', './install-hook.js', './manifest.webmanifest', './offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // 1つでも欠けると addAll 全体が失敗する。アイコンなど欠けても動くものは入れない。
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

  // ── それ以外（画面の部品）: キャッシュを先に返しつつ、裏で更新する ──
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => hit || caches.match('./offline.html'));
      return hit || network;
    })
  );
});
