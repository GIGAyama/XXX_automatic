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
 * ⚠️ orders/ もキャッシュしない。しかも 404 のときに offline.html を返してはいけない。
 *    ここは「さっきまで無かったものが増える」場所である（［つくる］で頼んだ結果が届く）。
 *    404 を一度でも覚えられると以後いつまでも届かないし、
 *    下の「それ以外」に落ちると offline.html（HTML）が返り、
 *    受け取る側は JSON として読めずに「壊れています」と言うことになる。
 *
 * ⚠️ VERSION の行は `npm run build:sw` が書き換える。手で直さないこと。
 *    シェルの中身から計算した値が入っているので、画面を直せば必ず版が変わり、
 *    端末のキャッシュも入れかわる。`npm run check` がずれを検出する。
 *
 * ⚠️ activate で自アプリ以外のキャッシュを消さない。
 *    旧構成では gigayama.github.io に数十本のアプリが同居していた。
 *    いまはアプリごとに専用サブドメインを持つが、移行前の端末には旧オリジンの
 *    Service Worker が残っているため、接頭辞での絞り込みはそのまま残す。
 *    caches.keys() を「自分のもの以外」で消すと、このランチャーを1度開いただけで
 *    同じ端末に入れてある他のアプリのオフライン用キャッシュが全部消える。
 *    消えたことは誰にも見えず、次に圏外で開いたときに「壊れた」としか分からない。
 *    だから CACHE_PREFIX で始まるものだけを掃除する。
 *
 * Service Worker は localStorage を一切操作しない。
 */

const VERSION = 'vb2940d97'; /* __APP_VERSION__ */
/** 自アプリの目印。ここで始まるキャッシュだけが掃除の対象になる。 */
const CACHE_PREFIX = 'launcher-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const MEDIA_CACHE = `${CACHE_PREFIX}media-${VERSION}`;

/** 画面を出すのに要る最小限。ここが揃っていれば圏外でも真っ白にならない。 */
const SHELL = ['./', './index.html', './style.css', './app.js', './install-hook.js', './manifest.webmanifest', './offline.html', './apps.css', './lib/jst-client.js', './lib/select.js', './lib/state.js', './lib/format.js', './lib/x-length.js', './lib/feedback-payload.js', './lib/media-pick.js', './lib/order.js', './lib/mine.js', './lib/note-doc.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // 1つでも欠けると addAll 全体が失敗する。アイコンなど欠けても動くものは入れない。
      // 実在するかは npm run build:sw / npm run check が先に見ている。
      .then((cache) => cache.addAll(SHELL))
    // ⚠️ ここで skipWaiting() しない。
    //    ［本文を直す］で打ちかけの文は、押すまで端末に保存されない。
    //    配信のたびに勝手に入れかわると、書いている最中に画面ごと消える。
    //    切りかえるのは、画面側で［さいしんに する］を押してもらってからにする。
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // ⚠️ 「自分のもの以外」ではなく「自分のもののうち古いもの」を消す。
            //    同一オリジンを共有している他アプリを巻き添えにしないため。
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== SHELL_CACHE && k !== MEDIA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/**
 * 画面から「入れかわってよい」と言われたときだけ、待機中の版を有効にする。
 * 押すまでは待たせる（install で skipWaiting しない理由と同じ）。
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
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

  // ── 頼んだ投稿の結果: 素通しする ──
  // まだ無いことに意味がある（作っている最中）。キャッシュも肩代わりもしない。
  if (url.pathname.includes('/orders/')) {
    event.respondWith(fetch(request));
    return;
  }

  // ── リポジトリに用意された note 記事: 新しいほうを優先し、取れなければ前のものを返す ──
  //
  // アプリ側で記事を直したら、次に開いたときには新しいほうが出てほしい。
  // かといってキャッシュしないと、圏外では本文すら読めなくなる（画像は元から圏外では取れないが、
  // 貼るだけならできる）。だから「まずネットワーク、駄目なら前の中身」にする。
  // launcher.json と違って中身は毎週変わらないので、前のものを返しても実害は小さい。
  if (url.pathname.includes('/note-articles/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(MEDIA_CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error()))
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
