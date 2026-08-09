# AUDIT.md — GIGA Standard v5 監査：投稿ランチャー（XXX_automatic）

このファイルは「いま何が測れていて、何が測れていないか」の控えである。
**測っていないものを ✅ と書かない。** 分からないものは「未計測」と書く。

- 監査日：2026-08-09（改修後の実測も同日）
- 対象：`docs/`（GitHub Pages で配るランチャー）と、それを作る `scripts/`
- 型：**A型**（単一オリジンの静的サイト。ビルドは Node の自作スクリプトのみ、実行時の依存は 0）
- 測り方：`tools/measure-ui.mjs` / `tools/measure-pwa.mjs`（実 Chromium。手順は末尾）

---

## 測り方（同じ数字を出しなおすための手順）

```bash
npm install
# Chromium の場所は環境で変わる。playwright が入れたものを指す
CHROMIUM_PATH=$(node -e "console.log(require('playwright').chromium.executablePath())") \
NO_PROXY=localhost,127.0.0.1 node tools/measure-ui.mjs
CHROMIUM_PATH=... NO_PROXY=localhost,127.0.0.1 node tools/measure-pwa.mjs
```

`measure-ui.mjs` は色を **1px 実際に塗って `getImageData` で読む**（§7-2）。
`getComputedStyle` の文字列を数字として拾うと、`oklch()` を返すブラウザで
すべての要素が「ほぼ真っ黒」と判定される。ここは踏まないようにしてある。

グラデーション背景・絵文字・使用不可の要素は、誤報になるので走査から外している。
**昼（light）と夜（dark）の両方**を測る。片方だけだと、暗いほうの薄い文字を丸ごと見落とす。

---

## A. 法務・配布

| # | 項目 | 判定 | 実測 |
|---|---|:--:|---|
| A1 | LICENSE 実ファイル | ✅ | MIT / Copyright (c) 2026 GIGAyama |
| A2 | .gitignore | ✅ | `node_modules/` `.env` ほか。`git ls-files` に `.env` / `.clasp.json` は 0 件 |
| A3 | dependabot.yml | ✅ | github-actions と npm を monthly |
| A4 | README / MANUAL / AUDIT | ✅ | README 18KB・MANUAL 41KB。**AUDIT.md は今回作成**（それまで無かった） |

## B. セキュリティ

| # | 項目 | 判定 | 実測 |
|---|---|:--:|---|
| B1 | CSP（入れたうえで動作確認済み） | ✅ | `default-src 'self'` ほか。**16 通りの走査（4タブ×昼夜・一覧・圏外・320px）で CSP 違反 0 件・JS エラー 0 件**（実ブラウザ）。`offline.html` には CSP が無かったので `default-src 'none'` を追加した（この画面は JS も画像も使わないので全部止められる） |
| B2 | 秘密情報・IDの直書きなし | ✅ | `npm run check` の 4. が毎回見ている。検出 0 件 |
| B3 | OAuthスコープ最小 | — | 該当なし（GAS を使わない） |
| B4 | postMessage の宛先が `*` でない | ✅ | `docs/` に `postMessage` は 0 件 |
| B5 | サーバー側5段ガード | — | 該当なし（個人情報を扱わない） |
| B6 | CDN から取る実行コードが 0 | ✅ | **0 バイト。** 外部への要求は `raw.githubusercontent.com` の画像のみ（CSP・`isAllowedMediaSrc`・`npm run check` の3か所で押さえてある） |
| B7 | 残る外部資産に SRI と版の固定 | — | 該当なし（外部から実行コードを読まない） |

## C. 堅牢性

| # | 項目 | 判定 | 実測 |
|---|---|:--:|---|
| C1 | LockService（GAS） | — | 該当なし |
| C2 | 自動復旧 | ✅ | `launcher.json` が読めないときに理由を出す。`orders/` は素通し |
| C3 | pagehide で記録確定 | ❌→✅ | **前：`pagehide` / `visibilitychange` が 0 件。** ［本文を直す］で打ちかけの文は DOM の中にしか無く、Chromebook のタブ破棄で消えていた。**後：両方で `draftText` に控える**（確定した `editedText` とは別に持つ。押していない文が「手直しずみ」になっては困るため） |
| C4 | 通信失敗時のリトライと明示 | ✅ | 失敗の理由を画面に出す。圏外では前回の `launcher.json` を返す |
| C5 | localStorage.clear() を使っていない | ✅ | 0 件。自アプリの接頭辞だけを消している |

## D. 表示（Part I §2）

| # | 項目 | 判定 | 実測 |
|---|---|:--:|---|
| D1 | viewport に viewport-fit=cover | ✅ | 3ファイルすべて一致 |
| D2 | 100dvh を使用 | ❌→✅ | **前：`docs/offline.html:8` が `min-height:100vh` 単独。** 後：`100dvh` ＋ `@supports not (height: 100dvh)` のフォールバック |
| D3 | safe-area-inset を適用 | ✅ | `body` の四辺とトーストの下端 |
| D4 | clamp() による fluid type | ❌→✅ | **前：`clamp()` 0 件**（14〜21px の固定 px のみ）。後：`--fs-body` / `--fs-small` / `--fs-title` を index・apps・offline の3画面に |
| D5 | Canvas に DPR 補正 | — | 該当なし（`getContext('2d')` は画面側に無い。実測ツールの中だけ） |
| D6 | 320px 幅で横スクロールが出ない | ✅ | index / apps / offline とも `scrollWidth == clientWidth` |
| D7 | 画像に width/height、150KB以下 | ⚠ | `width`/`height`/`loading="lazy"` は全 `<img>` にある。**ただし 150KB 超の PNG が 40 件（最大 1.8MB）**。後述の「人間に決めてほしいこと」 |
| D8 | コントラスト 4.5:1 以上 | ❌→✅ | **前：昼 2 件・夜 5 件**（下表）→ **後：昼 0 件・夜 0 件**（全16走査） |
| D9 | タップ領域 44px 以上 | ❌→✅ | **前：のべ 19 種**（下表）→ **後：0 件**（全16走査） |
| D10 | prefers-reduced-motion（`.01ms` であって 0 でない） | ⚠→✅ | **前：`animation: none !important`。** `@keyframes` が 0 件なので実害は出ていなかったが、`fill-mode: forwards` を1つ足した日に**中身が消える**形だった（§2-10）。後：`.01ms` の既定形へ。`npm run check` の `MOTION_ZERO` が戻りを検出する |
| D11 | forced-colors 対応 | ❌→✅ | **前：0 件**（ハイコントラストで塗りが消えると、選んでいるものが分からなくなる）。後：選択状態を `Highlight` の枠と塗りで示しなおす |
| D12 | 提示モード | — | 該当なし（片手のスマホで使う道具。電子黒板に映さない） |
| D13 | 印刷CSS | — | 該当なし（印刷する画面が無い） |
| D14 | 拡大を禁止していない | ✅ | `user-scalable=no` / `maximum-scale` は 0 件 |

### D8 コントラスト（実測・改修前）

| 画面 | 要素 | 文字色 | 面 | 比 | 必要 |
|---|---|---|---|---:|---:|
| note（昼夜とも） | `.btn--note`「本文をコピーして note を開く」 | `#fff` | `--note #2cb696` | **2.55** | 4.5 |
| note（昼夜とも） | `.btn--done`「公開した」 | `#fff` | `--ok #2a9d5c` | **3.46** | 4.5 |
| 全タブ（夜） | `.tab.is-on`「出す」ほか | `#fff` | `--accent #7aa5d8` | **2.56** | 4.5 |
| 全タブ（夜） | フッタの `<a>`「アプリの一覧を見る」 | `#0000ee`（**ブラウザの既定色**） | `--bg #12161d` | **1.93** | 4.5 |
| apps.html（夜） | `.app__open`「ひらく」 | `#fff` | `--accent #7aa5d8` | **2.56** | 4.5 |

夜のリンクがいちばん低い。**CSS で色を当てていない `<a>` が1つだけ残っていた**ため、
暗い地の上に素のリンク青（`#0000ee`）が出ていた。

### D9 タップ領域（実測・改修前）

実ブラウザで出たもの（この画面を開けば必ず出る）。

| 要素 | 実測 | 出る場所 |
|---|---:|---|
| `.tab`（出す／つくる／note／記録） | 79.8×**40** | 全画面 |
| `.seg__btn`（今日／今週／予備、投稿ずみ／過去） | 109.7×**36** | 出す・記録 |
| `.jump__btn`（本数・型のしぼりこみ） | 45.5×**31** | つくる |
| `.make__search`（アプリを探す欄） | 313×**42** | つくる |
| フッタの `<a>`「アプリの一覧を見る」 | 114.3×**14** | 全画面 |
| `apps.html` の目次リンク | 91.5×**39.6** | アプリ一覧 |
| `apps.html` のフッタの `<a>` | 88.7×**14** / 38.9×**14** | アプリ一覧 |

**CSS から読んだだけで、まだ実測していないもの**（そのカードが出ている状態を
走査で作れていない）。同じ書き方なので同じ結果になるはずだが、未計測である。

| 要素 | CSS 上の高さ | 出る場所 |
|---|---:|---|
| `.steps__dot` | padding 5px + 12.5px → 約 31 | 連投の手順 |
| `.rate button` | `min-height: 40px` | 記録 |
| `.shot__actions .btn` | `min-height: 38px` | note の画像を1枚ずつ渡すところ |

## E. PWA（Part I §3）

| # | 項目 | 判定 | 実測 |
|---|---|:--:|---|
| E1 | manifest の id/scope/start_url がリポジトリ名絶対パス | ✅ | 3つとも `/XXX_automatic/` |
| E2 | アイコン4種 + 透明を含まない apple-touch-icon | ✅ | **apple-touch-icon の透明画素 0.00%**（画素で確認） |
| E3 | beforeinstallprompt を head 最上部で捕捉（外部ファイル） | ✅ | `install-hook.js`。インラインではない |
| E4 | インストールボタン（案内できるときだけ表示） | ✅ | `#install` は既定 `hidden` |
| E5 | sw.js が自アプリ接頭辞のキャッシュのみ削除 | ❌→✅ | **前：実測で全消し。** 別アプリ名のキャッシュを2つ置いてから開くと、`launcher-shell-*` 以外がすべて消えた。**後：2つとも残る**（初回 activate 後・版を上げた後・押して切りかえた後の3回とも） |
| E6 | sw.js が localStorage に触れていない | ✅ | 0 件 |
| E7 | 更新通知（押すまで切り替わらない） | ❌→✅ | **前：実測で `waiting=false`**（`install` の中で `skipWaiting()` していたため、版を上げて3秒放置しただけで切り替わり、そのまま読み直していた）。**後：3秒放置で `waiting=true`・画面遷移 0 回。押すと `waiting=false`・遷移 1 回・古いキャッシュが消える** |
| E8 | 初回訪問で勝手にリロードしない | ❌→✅ | **前：画面遷移 2 回**（`controllerchange` を無条件に受けていた）→ **後：1 回** |
| E9 | Service Worker が実際に登録されている | ✅ | `getRegistration()` で `active=true` |
| E10 | offline.html（外部資産・JS に頼らない） | ✅ | 自前の CSS のみ・JS 0。本体のキャッシュを消して圏外にすると出ることを実測 |
| E11 | APP_VERSION を更新した | ✅ | `npm run build:sw` が `docs/` の中身から計算する。手で書かない |
| E12 | maskable のセーフゾーン外の中身 0.2% 以下 | ❌→✅ | **前：192 が 0.29% / 512 が 0.27%** → **後：どちらも 0.00%**（画素で測定。下地の色は除いて数えた）。下地は端まで伸ばしたまま、中身の余白を 10%→14% にした |
| E13 | iOS の「ホーム画面に追加」手順を MANUAL に記載 | ❌→✅ | **前：MANUAL.md に手順が無い**（画面の［…］の中にはある）。後：iOS / Android / PC の手順と、7日で消える話（ITP）を追記 |

### E5・E7・E8 の実測ログ

**改修前**

```
① 登録: されている（active=true）
② 初回訪問の画面遷移: 2 回  （❌ 勝手にリロードしている）
④-a 初回 activate のあと、他アプリのキャッシュ: ❌ 全部消えた
③ 版を上げて3秒放置: waiting=false  ❌ 勝手に切り替わった
   画面遷移: 1 回 ❌ 押していないのに読み直した
④-b 版を上げたあと、他アプリのキャッシュ: ❌ 全部消えた
⑤-a 圏外で起動: できた（title="投稿ランチャー"）
⑤-b 本体が無いときの表示: title="オフラインです - 投稿ランチャー"
```

**改修後**

```
① 登録: されている（active=true）
② 初回訪問の画面遷移: 1 回  （正常）
④-a 初回 activate のあと、他アプリのキャッシュ: ["keisan-card-static-v1","kanji-town-static-v3"]
③ 版を上げて3秒放置: waiting=true  （正常：押すまで切り替わらない）
   画面遷移: 0 回 （正常）
④-b 版を上げたあと、他アプリのキャッシュ: ["keisan-card-static-v1","kanji-town-static-v3"]（正常）
③' 更新の帯が出ているか: 出ている
   押したあと: waiting=false / 画面遷移 1 回 （正常：読み直した）
   古いキャッシュ: 消えた（正常）
   他アプリのキャッシュ: ["keisan-card-static-v1","kanji-town-static-v3"]
⑤-a 圏外で起動: できた（title="投稿ランチャー"）
⑤-b 本体が無いときの表示: title="オフラインです - 投稿ランチャー"
```

⚠️ ③' を足したのは、「押すまで切り替わらない」だけを確かめて満足すると、
**押しても何も起きないボタンを置いたまま合格にしてしまう**からである。

**E5 がこのリポジトリでいちばん重い。** `gigayama.github.io` は数十本のアプリが
同一オリジンを共有している。このランチャーを1度開くだけで、
**同じ端末に入れてある他のアプリのオフライン用キャッシュが全部消える。**
消えたことは誰にも見えず、次に圏外で開いたときに「壊れた」としか分からない。

## F. アクセシビリティ・性能

| # | 項目 | 判定 | 実測 |
|---|---|:--:|---|
| F1 | alt / aria-label / aria-live / role="alert" | ✅ | 装飾画像は `alt=""`、要約は `aria-live="polite"`、トーストは `role="status"` |
| F2 | モーダルに role="dialog"・Esc で閉じる | — | 該当なし（モーダルを使わない。案内はカードとして一覧の先頭に差しこむ） |
| F3 | キーボードのみで全機能に到達 | ⚠ | タブは矢印キーで動き `:focus-visible` もあるが、**全経路は未計測** |
| F4 | rt の色を決め打ちしていない | — | 該当なし（ルビを使わない。大人向けの道具） |
| F5 | 初回JS 300KB以下 | ✅ | `app.js` 105KB + `lib/*.js` 77KB = **182KB**（gzip 前）／gzip 後 54KB |
| F6 | 1ファイル 5,000行 / 400KB 以内 | ✅ | 最大は `docs/app.js` 2,707行・105KB |

## G. 学習ログ

| # | 項目 | 判定 |
|---|---|:--:|
| G1・G2 | `study.v1` | — 該当なし（学習アプリではない） |

---

## 品質ゲートに足したもの

Part I の検査は `scripts/lib/giga-v5-checks.mjs` に分けて置き、
`npm run check` から呼んでいる。共通の検査が更新されたときに、
ファイルごと差し替えて受けられるようにするためである。

| コード | 何を見るか |
|---|---|
| `SW_CACHE_WIPE` | activate が `startsWith` で自アプリ分に絞っているか（**「消す式」を追わない**。`(k) => caches.delete(k)` を見落とすため） |
| `SW_SKIP_WAITING_INSTALL` | install の中で `skipWaiting()` していないか |
| `SW_NO_UPDATE_PATH` / `SW_NO_UPDATE_PROMPT` | 切りかえの経路が sw.js と画面の両方に揃っているか（片方だけだと押しても何も起きない） |
| `SW_LOCALSTORAGE` | Service Worker が localStorage に触れていないか（**判定の前にコメントを落とす**。注意書きに反応するため） |
| `SW_RELOAD_UNGUARDED` | `controllerchange` を無条件に受けて reload していないか |
| `NO_PAGEHIDE` | 打ちかけの確定保存があるか |
| `VIEWPORT_FIT` / `VIEWPORT_NO_ZOOM` / `VIEWPORT_MISSING` | viewport の3点 |
| `VIEWPORT_100VH` | `100vh` の単独使用（**`@supports not (height: 100dvh)` の中は通す**） |
| `MOTION_ZERO` | reduced-motion で 0 / none にしていないか |
| `NO_FORCED_COLORS` | ハイコントラストの手当てがあるか |
| `MASKABLE_MISSING` / `ICON_MISSING` / `APPLE_ICON_ALPHA` | アイコン |

**「0件でした」は信じていない。** `tests/giga-v5-checks.test.mjs` で、
正しい形が通ることと、**15 通りにわざと壊した形が落ちること**の両方を確かめている。
この確認をしたことで、**検査そのものの不具合が1件**見つかった
（`handlerBody` がイベント名の引用符から括弧を数えはじめていたため、
`addEventListener('install', (event)` までしか取り出せず、中を見ているつもりで何も見ていなかった）。
実リポジトリでも、`docs/sw.js` の絞りこみを外すと `SW_CACHE_WIPE` で落ちることを確かめてある。

## 測っていないもの（未計測）

- **本番（`gigayama.github.io`）での確認**。作業環境からは到達できない（プロキシ 403）。
  ここに書いた数字はすべて**手元に立てた同じファイル**を実 Chromium で測ったものである。
- **実機**（iPad / Chromebook / Android）。iOS の「ホーム画面に追加」と
  apple-touch-icon の見え方は、画素の確認までしかしていない。
- **キーボードだけで全機能に到達できるか**（F3）。Tab 順の目視は未実施。
- **`.steps__dot` / `.rate button` / `.shot__actions .btn` の実測**。
  CSS では 44px にしたが、そのカードが出ている状態を走査で作れていない。
- **ハイコントラストモードの実際の見え方**。`forced-colors` の指定は入れたが、
  Windows のハイコントラストで開いてはいない。
- **LCP / CLS の実測**。Chromebook 実機が無い。
- **共有シート（`navigator.share`）の実挙動**。ヘッドレスでは呼べない。

## 人間に決めてほしいこと

1. **カード画像 40 件（150KB 超・合計 32MB）をどうするか。**
   `docs/media/*-card.png` は 1200×675 で、**X に添付する成果物そのもの**である。
   異なる色を数えたところ 14,000〜18,000 色あり（写真的なグラデーションを含む）、
   256 色のパレット PNG にすると帯が出る。§2-6 の「アイコンはほぼ必ずパレット化できる」は
   ここには当てはまらない。画面側は `loading="lazy"` と `width`/`height` があるため
   初回表示には効いていない。**効くのはリポジトリの重さだけ**なので、
   落とすなら画質と引き換えになる。今回は変更していない。
2. 同じ理由で `*-shot.png`（最大 1.8MB）も触っていない。
   これは note の記事に貼る絵で、note 側で縮む。
