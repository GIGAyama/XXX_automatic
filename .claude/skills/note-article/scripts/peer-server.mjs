/* PeerJS のシグナリングサーバを手もとに立てる。
 *
 *   npm i --no-save peer
 *   node peer-server.mjs [ポート]
 *
 * ── なぜ要るのか
 * 「みんなであそぶ」のような P2P の機能は、へやの番号をやりとりするために
 * 外部のシグナリングサーバ（既定では 0.peerjs.com）に出ていく。
 * 作業環境がそこに到達できないと、へやを作った瞬間に「接続エラー」で止まり、
 * マルチプレイの画面が1枚も撮れない。
 *
 * そこで撮影のあいだだけ、同じ役目のサーバを 127.0.0.1 に立てて、
 * アプリの接続先をそちらに向ける。端末どうしの実際のやりとりは
 * ブラウザ間の WebRTC でそのまま行われるので、撮れる画面は本物と同じになる。
 *
 * ── アプリ側で一時的に必要な変更（撮影後に必ず戻すこと）
 *   1. Peer の接続先。たとえば
 *        export const PEER_OPTIONS = { host: '127.0.0.1', port: 9000, path: '/', secure: false, config: {...} };
 *   2. CSP の connect-src に ws://127.0.0.1:9000 と http://127.0.0.1:9000 を足す
 *      （足さないとブラウザが接続をはじく）
 *   3. 変更したらビルドし直す
 *
 * 撮影が終わったら git checkout などで確実に戻し、差分に残っていないか
 * git status で確かめる。ここを戻し忘れると、本番が動かなくなる。
 *
 * ── 注意
 * host に 127.0.0.1 を明示している。省略すると IPv6 で listen しようとして、
 * IPv6 が無い環境では EAFNOSUPPORT で起動できない。
 */
import { join } from 'node:path';
import { createRequire } from 'node:module';

// peer も、スキルの隣ではなく作業中のリポジトリに入っている
let PeerServer;
try {
  ({ PeerServer } = createRequire(join(process.cwd(), 'x.js'))('peer'));
} catch (e) {
  try {
    ({ PeerServer } = await import('peer'));
  } catch (e2) {
    console.error('peer が見つからない。リポジトリの中で次を実行してから、もう一度。');
    console.error('  npm i --no-save peer');
    process.exit(2);
  }
}

const PORT = Number(process.argv[2] || 9000);

PeerServer({ host: '127.0.0.1', port: PORT, path: '/' }, () => {
  console.log(`peer server on http://127.0.0.1:${PORT}/`);
});
