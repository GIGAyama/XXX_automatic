/*
 * インストールの合図をいちばん先に受け取るための小さなファイル。
 *
 * Chrome は条件がそろうとすぐに beforeinstallprompt を出す。
 * app.js は </body> の直前で読まれるので、通信が遅い端末では合図に間に合わず、
 * 「ホーム画面に追加」ボタンが一度も出ないまま終わる。
 *
 * <head> で同期に読みこんで、ここで受け取ってためておく。
 * app.js はあとから window.__pwaInstallPrompt を見にくる。
 *
 * インラインの <script> にしないのは、CSP の script-src 'self' がインラインを止めるからである
 * （'unsafe-inline' を足すと CSP の意味がなくなる）。
 */
(function () {
  window.__pwaInstallPrompt = null;
  window.__pwaInstalled = false;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__pwaInstallPrompt = e;
    window.dispatchEvent(new Event('pwa-install-available'));
  });

  window.addEventListener('appinstalled', function () {
    window.__pwaInstallPrompt = null;
    window.__pwaInstalled = true;
    window.dispatchEvent(new Event('pwa-installed'));
  });
})();
