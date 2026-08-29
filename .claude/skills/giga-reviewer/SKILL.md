---
name: giga-reviewer
description: このリポジトリが外部CDNを読んでいないか（Zero-CDN）、児童の個人情報を集めていないか（Zero-PII）を静的に検査する。ユーザーが「品質検査して」「Zero-CDN を確かめて」「外部CDNを使っていないか見て」「個人情報が漏れていないか」「giga-reviewer」「コミット前にチェックして」「PR を出す前に検査」「このアプリは学校のフィルタリングを通る?」のように言ったときは必ずこのスキルを使う。学校向けWebアプリを直したあと、公開してよいかを確かめたい、という話ならこのスキルを検討する。⚠️ここは静的検査なので「0 件」でも合格ではない。実際に出ていく通信は standards/web/verify-no-external.mjs で実ブラウザから測る。タッチ領域・ルビ・SW版数は各リポジトリの品質ゲート（npm run check）の担当。艦隊全体を横断して見るなら giga-fleet。
---

# giga-reviewer — GIGAスクール標準 品質・教育・セキュリティ検証スキル

Antigravity（Gemini）および Claude Code の両環境で動作する、GIGAスクールWebアプリケーション専用の品質ゲートスキルです。
コミット前、PR作成前、またはコード改修完了時に実行し、教育現場の要件に違反していないかを自動検証します。

---

## 1. 検査対象項目

### このスキルが実際に見るもの

| 項目 | 基準・ルール | 判定 | 違反例 |
| :--- | :--- | :--- | :--- |
| **Zero External CDN** | 既知のCDN（unpkg, cdnjs, jsdelivr, Google Fonts 等）のランタイム読み込み禁止 | ❌ error | `<script src="https://cdn.jsdelivr.net/...">` |
| **外部オリジン** | 既知CDN以外でも、外から実行時に読んでいるもの | ⚠️ warning | `<script src="https://example.com/app.js">` |
| **外部スタイル** | CSS の `@import url(http…)` | ❌ error | `@import url('https://fonts.googleapis.com/…')` |
| **Zero PII** | 児童の個人情報（氏名・出席番号等）を要求・保存・送信しない | ❌ error | `<input id="student_name" placeholder="氏名">` |

### このスキルでは見ていないもの（見た気にならないこと）

⚠️ 以前この表には「タッチターゲット48px以上・ルビ」「SW版数整合性」が並んでいたが、
**実装は無かった**。検査項目に書いてあるものは「見ているはず」と読まれるので、
無いものを並べるのは、検査が無いことより危ない。担当はそれぞれ別にある。

| 項目 | 実際に見ているもの |
| :--- | :--- |
| タッチ領域・ルビ・`100dvh`・`prefers-reduced-motion` 等 | 各リポジトリの品質ゲート（`npm run check`／`scripts/check-project.mjs` 等） |
| SW版数整合性 | `node tools/build-sw.mjs --check`（`tools/build-sw.mjs` のあるリポジトリ） |
| 正本とのずれ | `node …/standards/check-drift.mjs --standards …/standards` |

### 宣言済みの例外は赤くしない

リポジトリが `quality.config.json` の `securityExceptions` に
`{ "rule": "external-runtime-host", "value": "<ホスト>", "reason": "…" }`
と理由つきで書いてあるホストは見逃す。宣言を済ませたリポジトリほど赤くなるのでは、
このスキルを無視する習慣がつく。**宣言していないホストはこれまでどおり赤くする。**

どうしても違反の形を書き残す必要がある行（ビルド時に取り寄せて自己ホストする処理、
検査がわざと落ちることを確かめる資料）は、直前の行に `giga-lint-ignore-next-line`
と理由を書く。ファイルまるごとなら `giga-lint-disable-file`。

---

## 2. 実行方法

エージェント（または開発者）は、作業完了時に以下のコマンドを実行してください：

```bash
# GIGAスクール静的ルール検証（Claude Code / Antigravity のどちらの置き場からでも同じ）
node .claude/skills/giga-reviewer/scripts/lint-giga.mjs .
node .agents/skills/giga-reviewer/scripts/lint-giga.mjs .
# ポータル（正本を持つ側）から:
node standards/skills/giga-reviewer/scripts/lint-giga.mjs .

# Service Worker の版数一致検査（tools/build-sw.mjs のあるリポジトリのみ）
node tools/build-sw.mjs --check
```

⚠️ 出力が 1 行も出ずに終わったら、それは「合格」ではなく「走っていない」。
2026-08-28 まで、入口の判定に `file://` を文字列で組み立てていたせいで、
**Windows と、空白や日本語を含むパスでは一度も動いていなかった**（無言で exit 0）。
いまは `pathToFileURL` で比べている。`[giga-reviewer] …検査を開始` の行が出ることを確かめること。

---

## 3. レビュー結果の解釈と修正指針

1. **CDNエラーが出た場合**:
   - 該当ライブラリを `npm install` してバンドルするか、静的JSファイルとして `vendor/` に配置してローカル読み込みに切り替えてください。
2. **PIIエラーが出た場合**:
   - 氏名入力欄を撤廃し、キャラクター選択や自動採番ID、端末ローカルでの完結に設計変更してください。
3. **SW版数エラーが出た場合**:
   - `node tools/build-sw.mjs` を実行してキャッシュ版数を再生成してください。
