/* eslint-disable */
/**
 * =====================================================================
 * giga-app-links.js — アプリから「行き先」へつなぐ 3 本のリンク（正本）
 * =====================================================================
 *
 * 画面の中に、次の 3 つへの入口を出す。
 *
 *   つかいかた   https://giga-school.com/apps/<slug>/manual/
 *   利用規約     https://<slug>.giga-school.com/terms.html
 *   プライバシー https://<slug>.giga-school.com/privacy.html
 *
 * ⚠️ 紹介記事（/apps/<slug>/）は出さない。2026-08-29 に外した。理由は下の LINKS。
 *
 * ── なぜ正本にするのか ───────────────────────────────
 *
 * 紹介記事へのリンクは、42 本のリポジトリに手で書かれていた。文言は
 * 「使い方を読む」「使い方をみる」で揺れ、当時 31 本のうち 9 本には
 * 「置く場所が無い」という理由でリンクそのものが無かった。
 *
 * さらに、利用規約とプライバシーポリシーは 37 本が自分のサブドメインに
 * 持っているのに、**アプリの画面からは 1 本も辿れなかった**。
 * トップページのカードからしか行けない。アプリだけを見つけた人には
 * 存在しないのと同じだった。
 *
 * 42 か所に手で書くと、次に文言を変えるときもまた 42 か所になる。
 * ここを 1 本にして、配って回る。
 *
 * ── 使い方（ふつうのアプリ）─────────────────────────
 *
 *   <script src="./giga-app-links.js" defer><\/script>
 *
 * ⚠️ この説明の中の <\/script> に \ が入っているのは、書き間違いではない。
 *    このファイルは GAS のために <script> で囲んで取りこむことがあり、
 *    そのとき、コメントの中の閉じタグでも script が終わってしまう。
 *    実際 2026-08-29 に、囲んだ側が途中で切れて、残りが素の HTML として
 *    画面に出た。閉じタグをそのまま書かないこと。
 *
 * slug は自分がいるホスト名（<slug>.giga-school.com）から決まるので、
 * たいていのアプリは、この 1 行のほかに書くことがない。
 *
 * ── 使い方（GAS のアプリ）──────────────────────────
 *
 * GAS は自分の HTML ファイルしか配れないので <script src> が使えない。
 * このファイルの中身を <script> で囲んで取りこみ、先に slug を渡す。
 *
 *   <script>window.GIGA_APP_LINKS = { slug: '<slug>' };<\/script>
 *   <script> …このファイルの中身… <\/script>
 *
 * ⚠️ ここに本物のアプリ名を例として書かないこと。このファイルは 42 本へ
 *    バイト単位で同じものが配られる。1 本の名前が混ざると、他の 41 本に
 *    よそのアプリの名前が配られることになる（検査が止める）。
 *
 * ── どこに出るか ───────────────────────────────────
 *
 * 画面に <span data-giga-links></span> があれば、その中に出す。
 * ヘッダーに置けばヘッダーに、フッターに置けばフッターに出る。
 *
 * ⚠️ 置き場所は <span>（行の中に並ぶもの）にすること。<div> にすると、
 *    そこで必ず改行が入り、フッターが 2 行になる。2026-08-29、
 *    デジタル・クラス新聞社のフッターが 115px まで太って、新聞を作る
 *    場所を押しつぶしていた。部品そのものは行の一部として振る舞うので
 *    （:host が inline-flex）、包む側さえ行の中にあれば 1 行に収まる。
 *
 * ── 出すものを絞る ─────────────────────────────────
 *
 * data-links は、次のどこに書いても効く。
 *
 *   <script src="./giga-app-links.js" data-links="terms,privacy" defer><\/script>
 *   <span data-giga-links data-links="terms,privacy"></span>
 *   window.GIGA_APP_LINKS = { links: 'terms,privacy' };
 *
 * ⚠️ 2026-08-29 まで、<div> のほうに書いても効かなかった。しかも**黙って
 *    全部出る**ので、絞ったつもりの側は気づけない。置き場所のすぐ横に
 *    書くほうが自然なので、読む側を増やして罠を消した。
 *
 * マニュアルがまだ無いアプリでは "terms,privacy" にする。
 * 既定のまま出すと、行き止まりの「つかいかた」が 1 本増える。
 * マニュアルを書いたら、この属性ごと消す（既定は 3 つとも出る）。
 *
 * 並び順は、書いた順ではなく下の LINKS の順になる。
 *
 * ── 暗い画面のアプリ ─────────────────────────────────
 *
 * 既定は端末の設定（prefers-color-scheme）に従う。それで足りるのは、
 * アプリの地の色も端末の設定に従っているときだけ。
 *
 *   <span data-giga-links data-theme="dark"></span>
 *   window.GIGA_APP_LINKS = { theme: 'dark' };
 *
 * ⚠️ 端末の設定が light でも地が暗いアプリがある（しりとりファイターは
 *    <meta name="color-scheme" content="light"> を宣言したうえで
 *    #170f33 を塗っている）。そこで既定のまま置くと、暗い地に暗い字が
 *    載って**リンクがあることに気づけない**。Shadow DOM なのでアプリ側の
 *    CSS は届かず、アプリの側では直せない。地が固定のアプリは
 *    theme を明示すること。'light' も同じように書ける。
 *
 * 置き場所が無ければ、画面のいちばん下に控えめな行として出す。
 * **フッターを持たないアプリでも行き先ができる**ようにするため。
 * 「フッターに足して」と場所で頼んだせいで 9 本が取り残された、という
 * 失敗があった。場所ではなく目的で書いてある。
 *
 * ── 決めごと ──────────────────────────────────────
 *
 * ・外部から何も読まない（Zero External CDN）。書体も色も自前。
 * ・Shadow DOM で親のスタイルと切り離す。Bootstrap のアプリでも
 *   Tailwind のアプリでも同じ見た目になる。
 * ・行き先はすべて絶対 URL。GAS の画面は iframe の中で、しかも
 *   別のドメイン（script.google.com）で動くので、相対パスは違う先を指す。
 * ・すべて target="_blank"。iframe の中で同じタブに開くと、枠の中に
 *   マニュアルが出てアプリへ戻れなくなる。
 * ・見えている高さは 26px、押せる大きさは 48px（艦隊のルール 2）。
 *   高さそのものを 48px にすると、この 1 行だけでフッターが 56px になり、
 *   アプリの表示領域を押しつぶす。当たり判定だけを ::after で外へ広げる。
 * ・狭い画面では文字を落として絵だけにする。1 行に収めるため。
 *   文字は消さずに読み上げ用に残すので、名前は失われない。
 * ・slug が分からなければ、何も出さない。壊れたリンクを出すより出さない。
 *
 * ⚠️ このファイルはアプリ固有の文字を 1 つも持たない。42 本に同じものが
 *    バイト単位で配られる（standards/check-drift.mjs の normalize が要らない）。
 *    アプリの名前や URL をここに書き足さないこと。
 * =====================================================================
 */

(function () {
  'use strict';

  var SITE = 'https://giga-school.com';
  var HOST_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.giga-school\.com$/;
  var SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

  /* 出せる行き先。並び順もここで決まる。
     つかいかたが先頭なのは、画面の前で困っている人がいちばん先に要るものだから。

     ⚠️ 紹介記事（/apps/<slug>/）はここに置かない。2026-08-29 に外した。
        あれは「なぜ作ったか」を、まだ使っていない先生に向けて書いたもので、
        いま画面の前にいて「このボタンは何ですか」と困っている人が
        求めているものではない。そもそもこの部品は、42 本のフッターが
        揃って紹介記事を指していたのを直すために作った。
        読み物への道は、つかいかたのページの中に置いてある。 */
  var LINKS = [
    { id: 'manual',  label: 'つかいかた',   of: function (s) { return SITE + '/apps/' + s + '/manual/'; } },
    { id: 'terms',   label: '利用規約',     of: function (s) { return 'https://' + s + '.giga-school.com/terms.html'; } },
    { id: 'privacy', label: 'プライバシー', of: function (s) { return 'https://' + s + '.giga-school.com/privacy.html'; } }
  ];

  var DEFAULT_IDS = LINKS.map(function (l) { return l.id; });

  /**
   * 出す行き先を決める。ここは画面に触らない純粋な関数にしてある。
   * DOM の無いところ（node --test）から、そのまま呼んで確かめられるようにするため。
   *
   * @param {object} o
   * @param {string} [o.slug]     はっきり渡された slug。あればこれを使う
   * @param {string} [o.hostname] いま居るホスト名。<slug>.giga-school.com なら slug が取れる
   * @param {string} [o.links]    出すものを絞る（"manual,terms" のように）
   * @returns {{slug: string, items: {id: string, label: string, href: string}[]}}
   */
  function resolve(o) {
    var opt = o || {};
    var slug = String(opt.slug || '').trim();

    /* 渡されていなければ、居るホスト名から取る。
       ⚠️ 取れない場所（GAS の script.google.com、file://、localhost）は
          必ずある。そこで当てずっぽうに組むと、存在しないアプリの
          利用規約へ飛ばすことになる。取れなければ何も出さない。 */
    if (!slug) {
      var m = HOST_RE.exec(String(opt.hostname || ''));
      slug = m ? m[1] : '';
    }
    if (!SAFE_SLUG.test(slug)) return { slug: '', items: [] };

    var want = String(opt.links == null ? '' : opt.links).trim();
    var ids = want
      ? want.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      : DEFAULT_IDS;

    var items = [];
    /* LINKS の順に並べる。data-links の書き順では並べない。
       アプリごとに並びが変わると、いつも同じ場所にある、が崩れる。 */
    LINKS.forEach(function (l) {
      if (ids.indexOf(l.id) === -1) return;
      items.push({ id: l.id, label: l.label, href: l.of(slug) });
    });
    return { slug: slug, items: items };
  }

  /* テストと、アプリ側から呼びたいときのために出しておく。
     画面のあるなしに関わらず、ここまでは必ず通る。 */
  var api = { resolve: resolve, LINKS: LINKS };
  if (typeof window !== 'undefined') window.GigaAppLinks = api;
  if (typeof globalThis !== 'undefined') globalThis.GigaAppLinks = api;

  /* ここから下は画面がある時だけ。node から読んだときは、ここで終わる。 */
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.__GIGA_APP_LINKS_LOADED__) return;      // 二重に出さない
  window.__GIGA_APP_LINKS_LOADED__ = true;

  var TAG = 'giga-app-links';

  /** 設定の読み場所。先に書いてあるものが勝つ。 */
  function settings() {
    var conf = window.GIGA_APP_LINKS || {};
    /* 自分を読み込んだ <script> の data-* も見る。
       document.currentScript は defer でも読み込み中は取れるが、
       DOMContentLoaded を待ったあとでは null になるので、先に取っておく。 */
    var el = self.__gigaAppLinksScript || null;
    var data = (el && el.dataset) || {};
    /* 置き場所の <div data-giga-links> の data-* も見る。
       ⚠️ 2026-08-29、data-links をこちらへ書いて効かず、しかも黙って全部
          出た。絞ったつもりの側は気づけない。書く人にとっては、置き場所の
          すぐ隣に書くほうが自然なので、罠を消す側で解いた。
       ここは start() から呼ぶので、<div> はもう在る。 */
    var slotEl = document.querySelector('[data-giga-links]');
    var slot = (slotEl && slotEl.dataset) || {};
    return {
      slug: conf.slug || data.slug || slot.slug || '',
      links: conf.links || data.links || slot.links || '',
      /* 'dark' / 'light' を明示したときだけ、端末の設定より優先する。
         書かなければ prefers-color-scheme に従う（既定）。 */
      theme: conf.theme || data.theme || slot.theme || '',
      hostname: window.location && window.location.hostname
    };
  }

  var mine = document.currentScript || null;
  self.__gigaAppLinksScript = mine;

  var STYLE = [
    /* 行そのものではなく「行の中の一部品」として振る舞う。
       ⚠️ display:block に戻さないこと。そこで必ず改行が入り、著作権表示と
          別の行になる。2026-08-29、デジタル・クラス新聞社のフッターが
          2 行・115px まで太って、新聞を作る場所を押しつぶしていた。 */
    ':host{all:initial;display:inline-flex;vertical-align:middle;',
    'font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif}',
    /* 置き場所が無くて <body> の末尾へ出したとき。こちらは 1 行を占めてよい。
       style 属性は CSP で効かないことがあるので、余白もここで付ける（place() を参照）。 */
    ':host(.giga-app-links--end){display:flex;justify-content:center;inline-size:100%;',
    'margin:.5rem 0 max(.5rem, env(safe-area-inset-bottom))}',
    /* 折り返さない。折り返すと、収めたはずの 1 行がまた 2 行になる。 */
    '.row{display:flex;flex-wrap:nowrap;align-items:center;gap:.1rem}',
    /* 見えている高さは 26px。
       ⚠️ min-height:48px と書かないこと。それをやるとこの 1 行だけで
          フッターが 56px になる。押せる大きさ（艦隊のルール 2 の 48px）は
          下の ::after で当たり判定だけを外へ広げて確保する。
       ⚠️ min-inline-size:48px を外さないこと。当たり判定だけを広げると、
          隣どうしの 48px が重なって、押したつもりと違うほうが開く。
       px で置くのは、rem だと文字を小さくした端末で下限を割るため。 */
    'a{position:relative;display:inline-flex;align-items:center;justify-content:center;',
    'gap:.3em;min-inline-size:48px;block-size:26px;padding:0 .45em;border-radius:8px;',
    'font-size:13px;line-height:1;white-space:nowrap;text-decoration:none;',
    'color:#42506b;background:transparent;transition:background-color .15s,color .15s}',
    /* 指で押せる大きさ。見た目は 26px のまま、当たり判定だけ 48px にする。 */
    'a::after{content:"";position:absolute;inset-block-start:50%;inset-inline-start:50%;',
    'transform:translate(-50%,-50%);inline-size:100%;block-size:48px}',
    'a:hover{background:rgba(26,115,232,.10);color:#1a4fa8}',
    'a:focus-visible{outline:3px solid #1a73e8;outline-offset:2px}',
    'svg{inline-size:15px;block-size:15px;flex:none}',
    /* 狭い画面では文字を落として絵だけにする。1 行に収めるため。
       ⚠️ display:none にしないこと。読み上げからも消えて、絵だけのリンクに
          名前が無くなる。見えなくするだけにして、名前は残す。 */
    '@media (max-width: 640px){.t{position:absolute;inline-size:1px;block-size:1px;',
    'margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
    /* 絵だけになると、文字が添えられていたときより読み取りにくい。少し大きくする。 */
    'svg{inline-size:18px;block-size:18px}}',
    /* 暗い画面の端末でも読めるようにする。アプリ側の指定は Shadow DOM で
       届かないので、こちらで両方を持つ。
       ⚠️ :host(.giga-app-links--light) を外さないこと。地の色が固定で明るい
          アプリが theme="light" と書いたとき、端末の設定が dark だと
          明るい地に明るい字が載る。 */
    '@media (prefers-color-scheme: dark){',
    ':host(:not(.giga-app-links--light)) a{color:#c3ccdd}',
    ':host(:not(.giga-app-links--light)) a:hover{background:rgba(150,190,255,.16);color:#eaf1ff}}',
    /* theme を明示したときは、端末の設定より優先する。
       :host(.…) a のほうが、上の a{} より詳しいので後ろに書かなくても勝つが、
       読む順で分かるように、こちらも後ろへ置いてある。 */
    ':host(.giga-app-links--dark) a{color:#c3ccdd}',
    ':host(.giga-app-links--dark) a:hover{background:rgba(150,190,255,.16);color:#eaf1ff}',
    ':host(.giga-app-links--dark) a:focus-visible{outline-color:#8ab4f8}',
    ':host(.giga-app-links--light) a{color:#42506b}',
    ':host(.giga-app-links--light) a:hover{background:rgba(26,115,232,.10);color:#1a4fa8}',
    '@media (prefers-reduced-motion: reduce){a{transition:none}}',
    /* 紙にはリンクを写しても押せない。当たり判定は要らないが、文字は戻す
       （絵だけが並んだ紙は、あとから読んで何のことか分からない）。 */
    '@media print{a{block-size:auto;padding:0 .4em}a::after{display:none}',
    '.t{position:static;inline-size:auto;block-size:auto;margin:0;overflow:visible;clip-path:none}}'
  ].join('');

  /* 絵は 4 つだけなので、線を直接持つ。アイコンの webfont は取りこまない
     （bootstrap-icons を丸ごと入れると 229KB。使う分だけなら数百バイト）。 */
  var ICONS = {
    manual: 'M4 4.5A1.5 1.5 0 0 1 5.5 3H12v14H5.5A1.5 1.5 0 0 1 4 15.5zM12 3h2.5A1.5 1.5 0 0 1 16 4.5v11a1.5 1.5 0 0 1-1.5 1.5H12',
    terms: 'M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 9h4M8 12h4',
    privacy: 'M10 3l6 2.5v4c0 3.6-2.4 6.8-6 7.5-3.6-.7-6-3.9-6-7.5v-4z'
  };

  function icon(id) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[id] || ICONS.manual);
    svg.appendChild(path);
    return svg;
  }

  function build(items, theme) {
    var host = document.createElement(TAG);
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
    if (!root) return null;                       // Shadow DOM が無い環境では出さない

    /* 地の色が端末の設定に従わないアプリだけが書く。書かなければ
       prefers-color-scheme のまま（既定）。知らない値は既定に落とす。 */
    if (theme === 'dark' || theme === 'light') host.className = 'giga-app-links--' + theme;

    /* ⚠️ <style> を入れるだけにしない。
       CSP が `style-src 'self'`（'unsafe-inline' なし）の画面では、Shadow DOM の
       中でも <style> は弾かれる。弾かれても例外は飛ばず、リンクは出たまま
       **見た目だけが落ちる**。2026-08-29 に Gobblet で実際に起きて、48px の
       タップ領域が 28px になっていた（艦隊のルール 2 を割る）。しかも画面には
       出ているので、コンソールを読むまで気づけない。

       構築可能なスタイルシートは style-src の対象外なので、使えるならそちらを使う。
       使えない古い browser には <style> で降りる（そちらは CSP も古いか無い）。 */
    var styled = false;
    try {
      if (root.adoptedStyleSheets && typeof CSSStyleSheet === 'function') {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLE);
        root.adoptedStyleSheets = [sheet];
        styled = true;
      }
    } catch (e) { styled = false; }
    if (!styled) {
      var style = document.createElement('style');
      style.textContent = STYLE;
      root.appendChild(style);
    }

    var nav = document.createElement('nav');
    nav.className = 'row';
    nav.setAttribute('aria-label', 'このアプリについて');
    items.forEach(function (it) {
      var a = document.createElement('a');
      a.href = it.href;
      /* iframe の中で同じタブに開くと、枠の中にページが出てアプリへ戻れなくなる。
         rel は noopener と noreferrer の両方。開いた先に元の画面を触らせない。 */
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      /* 狭い画面では文字が見えなくなるので、指で押す人のために名前を残す。
         読み上げには下の <span> がそのまま読まれるので、aria-label は付けない
         （付けると 2 つ名前を持つことになる）。 */
      a.title = it.label;
      a.appendChild(icon(it.id));
      /* 文字は <span class="t"> で包む。狭い画面ではこれだけを見えなくして
         絵だけにする。地の文のままだと、消す手が無い。 */
      var t = document.createElement('span');
      t.className = 't';
      t.appendChild(document.createTextNode(it.label));
      a.appendChild(t);
      nav.appendChild(a);
    });
    root.appendChild(nav);
    return host;
  }

  function place(host) {
    var slot = document.querySelector('[data-giga-links]');
    if (slot) { slot.appendChild(host); return; }
    /* 置き場所が無いアプリ。画面のいちばん下に置く。
       position を触らないので、アプリの操作の邪魔にはならない。

       ⚠️ ここで host.style.margin と書かない。style 属性も CSP の style-src が
          見ているので、`style-src 'self'` の画面では黙って効かない。
          余白は上の STYLE の :host(.giga-app-links--end) で付ける。
       ⚠️ className へ代入し直さないこと。theme で付けた色の指定を消してしまう。 */
    host.classList.add('giga-app-links--end');
    document.body.appendChild(host);
  }

  var shown = null;                               // いま出しているもの
  var shownSlot = null;                           // 置き場所の中に出したなら、その置き場所

  /* まだ画面にあるか。
     ⚠️ isConnected を直に読まないこと。持っていない古い browser では必ず
        undefined になり、「消えた」と読めてしまう。下の見張りはそれを見て
        出しなおすので、画面が描き替わるたびに出しなおし続けることになる。 */
  function inPage(node) {
    if (!node) return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    return document.contains(node);
  }

  /** 出す（すでに出ていれば、出しなおして置き場所へ移す）。 */
  function paint() {
    var conf = settings();
    var got = resolve(conf);
    if (!got.items.length) return;                // slug が分からない。何も出さない
    var host = build(got.items, conf.theme);
    if (!host) return;
    if (shown && shown.parentNode) shown.parentNode.removeChild(shown);
    shown = host;
    place(host);
    shownSlot = document.querySelector('[data-giga-links]');
  }

  /* 置き場所が後から来るアプリへの手当て。
     ⚠️ React や Vue のアプリは、画面を DOMContentLoaded より**後**に描く。
        そのとき <div data-giga-links> はまだ無い。そこで諦めると、
        置き場所が見つからないだけでなく、**そこに書いた data-links も読めない**。
        黙って既定の 3 本が画面のいちばん下に出る。
        2026-08-29 に Reversi（React）で実際に起きた。フッターに置いたはずの
        リンクが本文の下に落ち、外したはずの「つかいかた」も出ていた。

     ⚠️ だからといって「待ってから出す」にしないこと。同じ日に、そう書いて
        置き場所を持たないアプリ（Typa）でリンクが 1.5 秒あとに出るようにしてしまった。
        フッターの無いアプリは艦隊にいくつもあり、そちらのほうが数が多い。

     **先に出す。後から置き場所が来たら、出しなおして移す。** どちらも待たせない。

     ⚠️ 置き場所へ移したあとも見張りをやめないこと。React のフッターは
        画面によって消えることがある（宿題ポストは {view !== 'admin' && <Footer/>}、
        教材プリントメーカーは {!currentTextbookId && <Footer/>}）。
        置き場所ごと消えると、その中に出したリンクも一緒に消える。
        そこで見張りを畳んでいると、**画面を 1 回切り替えただけで
        リンクが二度と戻らない。** しかも何も起きないので気づけない。

     ⚠️ ただし、ふだんは何も調べないこと。この見張りは画面が描き替わるたびに
        呼ばれる。置き場所の中に居て、それがまだ画面にあるなら、そこで返す
        （プロパティを 2 つ読むだけ）。querySelector は必要になるまで呼ばない。 */
  var SLOT_WAIT_MS = 1500;
  function watchForSlot() {
    if (typeof MutationObserver !== 'function') return;
    var timer = null;
    var obs = new MutationObserver(function () {
      if (shownSlot) {
        /* 置き場所の中に居る。安いほうから見て、変わっていなければ何もしない。 */
        if (inPage(shown) && inPage(shownSlot)) return;
        paint();                                  // 置き場所ごと消えた。出しなおす
        return;
      }
      /* まだ置き場所を見つけていない（画面のいちばん下に出してある）。 */
      if (document.querySelector('[data-giga-links]')) paint();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    /* 置き場所を持たないアプリでは、待っても来ない。そこまでで見張りを畳む。
       画面のいちばん下（<body> の直下）は、アプリの描き替えで消えることが
       無いので、そのあと見張り続ける理由が無い。 */
    timer = setTimeout(function () {
      if (!shownSlot) obs.disconnect();
    }, SLOT_WAIT_MS);
    return timer;
  }

  function start() {
    paint();                                      // まず出す。待たせない
    watchForSlot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
