---
name: giga-scaffold
description: GIGAスクールの絶対原則（Zero-CDN・Zero-PII・決定論的SW版管理・正本同期・児童目線UI）に最初から沿った形で、新しい学校向けWebアプリの土台を作る。ユーザーが「〇〇の練習アプリを作りたい」「新しい教育用アプリを立ち上げたい」「giga-scaffold」「新規リポジトリを作って」「アプリの雛形がほしい」「一から作りたい」のように言ったときは必ずこのスキルを使う。まだ何も無いところから学校で使うWebアプリを作りはじめる、という話ならこのスキルを検討する。既にあるリポジトリの検査は giga-reviewer、正本の共通ゲートを後から入れる移行は giga-migrator サブエージェントの担当なので取り違えない。
---

# giga-scaffold — GIGAスクール Webアプリ スキャフォールディング

「〇〇の練習アプリを作りたい」「新しい教育用Webアプリを立ち上げたい」という要求から、GIGAスクールの絶対設計原則に完全準拠したプロジェクト構成を一発でセットアップするスキルです。

---

## 1. 自動生成される標準ファイル構成

```
[新規アプリの標準構成]
├── index.html                  # 児童向けUIテンプレート（48pxタップ領域、学年別CSS、ルビ）
├── app.js                      # メインロジック（Local First、localStorage/IndexedDB完結）
├── style.css                   # 自己完結CSS（外部フォント・外部CDNなし）
├── manifest.webmanifest        # PWAマニフェスト（スタンドアロン起動設定）
├── sw.js                       # Service Worker本体
├── sw-build.config.json        # SW先読み・版数生成設定
├── install-hook.js             # PWAインストール案内フック
├── standards-map.json          # 正本（standards/）との同期定義
├── .github/
│   └── workflows/
│       └── ci.yml              # 正本ドリフト検査 & SW版数一致検査
└── docs/
    ├── CHANGELOG.md            # 更新ログ（giga-changelog スキル）
    ├── note/
    │   └── note-article.md     # note紹介記事用ひな形
    └── devlog/                 # 開発記録置き場
```

⚠️ **`docs/CHANGELOG.md` は最初から置く。** giga-school.com のトップ・紹介ページ・
使い方マニュアルの 3 か所が、ここを読んで「何が変わったか」を出す。あとから作る形に
していたところ、**42 本すべてで 1 本も書かれないまま半年たった**（書き方の正本を
配っていなかったため）。中身は最初の 1 行だけでよい。

```md
## <公開日 YYYY-MM-DD>
- はじめて公開しました
```

書き足し方は giga-changelog スキルにある。

---

## 2. 必須設定ファイルのテンプレート

### ① `standards-map.json`
```json
{
  "files": [
    {
      "canonical": "sw/build-sw-static.mjs",
      "local": "tools/build-sw.mjs"
    },
    {
      "canonical": "lib/giga-v5-checks.mjs",
      "local": "scripts/lib/giga-v5-checks.mjs"
    }
  ],
  "dirs": [
    {
      "canonical": "skills/devlog-article",
      "local": ".claude/skills/devlog-article"
    },
    {
      "canonical": "skills/note-article",
      "local": ".claude/skills/note-article"
    },
    {
      "canonical": "skills/giga-scaffold",
      "local": ".claude/skills/giga-scaffold"
    },
    {
      "canonical": "skills/giga-reviewer",
      "local": ".claude/skills/giga-reviewer"
    }
  ]
}
```

### ② `.github/workflows/ci.yml`
```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '20'
      - name: SW の版が中身と一致しているか
        run: node tools/build-sw.mjs --check

  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/checkout@v7
        with:
          repository: GIGAyama/GIGAyama.github.io
          path: .standards-src
      - name: 正本とのずれ検知
        run: node .standards-src/standards/check-drift.mjs --standards .standards-src/standards
```

⚠️ この雛形は**配信物をコミットするアプリ**（`sw/build-sw-static.mjs`）の形。
Vite 系（`sw/build-sw-vite.mjs`）にするなら、`--check` は `dist/` を読むので、
その前に `npm ci` と `npm run build` を足すこと。足さないと `dist/` が無くて
ENOENT で落ちる。

### ③ `sw-build.config.json`
```json
{
  "swPath": "sw.js",
  "precaches": [
    "index.html",
    "app.js",
    "style.css",
    "manifest.webmanifest",
    "install-hook.js"
  ]
}
```

---

## 3. UI/UX設計ガイドライン（児童目線テンプレート）

1. **タッチ領域**: 全てのボタン・インタラクティブ要素は `min-width: 48px; min-height: 48px;` を適用。
2. **文字・フォント**:
   - `font-family: system-ui, -apple-system, sans-serif, "Hiragino Kaku Gothic ProN", "Meiryo";`（外部Webフォント禁止）。
   - 漢字には `<ruby>漢字<rt>かんじ</rt></ruby>` を付与。
3. **色彩設計**: コントラスト比 4.5:1 以上を確保。
4. **個人情報ゼロ**: 氏名や学級の入力フォームは一切作らない。ニックネーム入力も避け、必要なら「プレイヤー1」「どうぶつアイコン選択」等にする。

---

## 4. 作ったあと、ポータルにつながるまで

新しいリポジトリを `GIGAyama` に作ると、ポータル（`GIGAyama.github.io`）の側で
次のことが**ひとりでに**起きる。手で台帳を書き足す必要は無い。

| いつ | 何が起きるか | 誰がやるか |
| --- | --- | --- |
| 翌朝 | `standards-map.json` を見つけて、配布の台帳（`tools/distribution.json` の `targets`）に足す | ポータルの `tools/register-repos.mjs`（機械） |
| その直後 | スキル・ルール・hook・`CLAUDE.md` と、対応表に書いた正本が PR で届く | ポータルの `auto-distribute`（機械） |
| 配り終わったあと | 写しが正本と同じかを見る。違えばポータルに Issue が立つ | ポータルの `check-distribution`（機械） |

⚠️ **`standards-map.json` を置かずに push しないこと。** 対応表の無いリポジトリは
「配る先かどうか」を機械が決められないので、台帳には足されない。そのあいだ
ポータルの検査は赤いままで、Issue が立つ。2026-09-19 に 1 本増えたとき、
台帳に足すのは人の手で、**52 日のあいだ誰も足さなかった**（毎朝おなじ 1 行で赤いまま）。
上の表は、その穴を塞いだあとの形。

⚠️ **トップに載せるところは、ひとりでには起きない。** カードの文・分類・対象学年・
画面写真は、作った人にしか決められないため。ポータルで次をやる。

1. `data/apps.json` に 1 項目足す（`repo` / `name` / `slug` / `category` / `grades` / `hosts`）
2. `index.html` にカードを 1 枚と、絞りこみの件数を直す（`node tools/check-cards.mjs` が数を見る）
3. 画面写真を `assets/thumbs/<slug>-1〜6.webp` に置く（アプリの本物の画面を撮る）
4. `node tools/sync-updates.mjs` → `node tools/build-sw.mjs` で組み直す
5. `<slug>.giga-school.com` の DNS（CNAME）と GitHub Pages を有効にする
   （開けないままトップに載せると、ポータルの週次の巡回が「測れなかった」で赤くなる）
