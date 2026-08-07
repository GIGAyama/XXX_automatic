/**
 * 紹介カード（1200×675）の HTML を組み立てる。
 *
 * なぜ画像を作るのか:
 *   X はテキストだけの投稿より、画像つきの投稿のほうが圧倒的に目に留まる。
 *   そして Web Share API に渡せるのはファイルなので、
 *   「共有シートを開いたら画像が添付済み」を成立させるには画像が要る。
 *
 * なぜ HTML を Playwright で撮るのか:
 *   画像生成ライブラリ（sharp や canvas）は OS ごとのビルドが要り、
 *   日本語フォントの扱いでつまずきやすい。
 *   すでに Playwright を入れているので、HTML を書いて撮るのがいちばん壊れにくい。
 *
 * フォントについて:
 *   外部フォントは読みにいかない（学校のネットワークが CDN を塞ぐという
 *   このフリート共通の方針と、CI での不安定さの両方の理由）。
 *   OS に載っている日本語フォントを順に指定する。CI（Ubuntu）では
 *   Noto Sans CJK JP を apt で入れてから撮る。
 */

const FONT_STACK =
    "'Noto Sans CJK JP', 'Noto Sans JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', " +
    "'Yu Gothic', Meiryo, IPAexGothic, IPAGothic, sans-serif";

/**
 * 教科ごとに色を変える。並べたときに一目で見分けがつくようにするため。
 * アプリ一覧ページ（build-apps-page.mjs）も同じ色を使う。
 * 投稿カードと一覧で教科の色が違うと、同じアプリだと分からなくなる。
 */
export const SUBJECT_COLORS = {
    算数: { from: '#ff9f43', to: '#ee5a24' },
    国語: { from: '#ff6b81', to: '#c44569' },
    理科: { from: '#26de81', to: '#20bf6b' },
    社会: { from: '#fd9644', to: '#e17055' },
    体育: { from: '#45aaf2', to: '#2d98da' },
    英語: { from: '#a55eea', to: '#8854d0' },
    音楽: { from: '#f7b731', to: '#f0932b' },
    学級経営: { from: '#4b7bec', to: '#3867d6' },
    校務: { from: '#778ca3', to: '#4b6584' },
};
export const DEFAULT_COLORS = { from: '#2bcbba', to: '#0fb9b1' };

export function colorsFor(subject = '') {
    const hit = Object.keys(SUBJECT_COLORS).find((key) => subject.includes(key));
    return hit ? SUBJECT_COLORS[hit] : DEFAULT_COLORS;
}

/** 教科名を SUBJECT_COLORS のキーに寄せる。「算数（図形）」→「算数」。一覧の見出しにも使う。 */
export function subjectKeyOf(subject = '') {
    return Object.keys(SUBJECT_COLORS).find((key) => subject.includes(key)) ?? 'その他';
}

export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {object} options
 * @param {string} options.name          リポジトリ名
 * @param {string} options.catchCopy     短い惹句
 * @param {string} options.oneLine       一文説明
 * @param {string} options.targetGrade   対象学年
 * @param {string} options.subject       教科
 * @param {string|null} options.screenshotDataUri  画面のスクリーンショット（data URI）
 */
export function buildCardHtml({ name, catchCopy, oneLine, targetGrade, subject, screenshotDataUri }) {
    const { from, to } = colorsFor(subject);

    // スクリーンショットが撮れなかったアプリでもカードは作る。
    // 画像なしの投稿にするより、文字だけのカードでも付いていたほうが目に留まる。
    const shot = screenshotDataUri
        ? `<div class="shot"><img src="${screenshotDataUri}" alt=""></div>`
        : '<div class="shot shot--empty"><span>🧩</span></div>';

    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:675px;font-family:${FONT_STACK};
       background:linear-gradient(135deg,${from} 0%,${to} 100%);
       display:flex;align-items:center;padding:56px;gap:48px;overflow:hidden}
  .left{flex:1;min-width:0;color:#fff}
  .badges{display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap}
  .badge{background:rgba(255,255,255,.24);border:2px solid rgba(255,255,255,.5);
         border-radius:999px;padding:7px 20px;font-size:24px;font-weight:700;
         letter-spacing:.02em;white-space:nowrap}
  .copy{font-size:66px;font-weight:900;line-height:1.24;letter-spacing:-.01em;
        text-shadow:0 3px 14px rgba(0,0,0,.22);word-break:auto-phrase;
        display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .one{margin-top:24px;font-size:29px;line-height:1.6;opacity:.96;
       display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .foot{margin-top:36px;display:flex;align-items:center;gap:14px;
        font-size:23px;opacity:.94;font-weight:700}
  .dot{width:11px;height:11px;border-radius:50%;background:#fff;opacity:.8;flex:none}
  .right{width:452px;flex:none}
  .shot{width:452px;height:452px;border-radius:26px;overflow:hidden;
        background:#fff;box-shadow:0 22px 60px rgba(0,0,0,.3);
        border:9px solid rgba(255,255,255,.95)}
  .shot img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
  .shot--empty{display:flex;align-items:center;justify-content:center;font-size:150px}
</style></head><body>
  <div class="left">
    <div class="badges">
      <span class="badge">${escapeHtml(subject || '学習アプリ')}</span>
      <span class="badge">${escapeHtml(targetGrade || '小学生向け')}</span>
      <span class="badge">ブラウザで動く</span>
    </div>
    <div class="copy">${escapeHtml(catchCopy || name)}</div>
    <div class="one">${escapeHtml(oneLine || '')}</div>
    <div class="foot"><span>${escapeHtml(name)}</span><span class="dot"></span><span>無料・登録不要</span></div>
  </div>
  <div class="right">${shot}</div>
</body></html>`;
}

export const CARD_SIZE = { width: 1200, height: 675 };
