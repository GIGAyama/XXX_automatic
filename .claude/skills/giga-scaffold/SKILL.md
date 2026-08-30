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
    ├── note/
    │   └── note-article.md     # note紹介記事用ひな形
    └── devlog/                 # 開発記録置き場
```

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: SW の版が中身と一致しているか
        run: node tools/build-sw.mjs --check

  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
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
