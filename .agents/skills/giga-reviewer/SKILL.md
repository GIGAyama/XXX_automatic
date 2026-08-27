---
name: giga-reviewer
description: GIGAスクール標準品質・教育・セキュリティ検証スキル。Zero-CDN、個人情報ゼロトラスト（Zero-PII）、児童向けUI/UX（タッチ領域・ルビ・外部フォント禁止）、SW版数整合性を自動検証します。
---

# giga-reviewer — GIGAスクール標準 品質・教育・セキュリティ検証スキル

Antigravity（Gemini）および Claude Code の両環境で動作する、GIGAスクールWebアプリケーション専用の品質ゲートスキルです。
コミット前、PR作成前、またはコード改修完了時に実行し、教育現場の要件に違反していないかを自動検証します。

---

## 1. 検査対象項目

| 項目 | 基準・ルール | 違反例 |
| :--- | :--- | :--- |
| **Zero External CDN** | 外部CDN（unpkg, cdnjs, Google Fonts等）のランタイム読み込み禁止 | `<script src="https://cdn.jsdelivr.net/...">` |
| **Zero PII** | 児童の個人情報（氏名・出席番号等）を要求・保存・送信しない | `<input id="student_name" placeholder="氏名">` |
| **Child UI / UX** | タッチターゲット48px以上、外部フォント禁止、適切なルビ | `<a style="font-size: 10px; padding: 0">` |
| **SW版数整合性** | Service Workerのキャッシュ版数が成果物ハッシュと一致している | `node tools/build-sw.mjs --check` 失敗 |

---

## 2. 実行方法

エージェント（または開発者）は、作業完了時に以下のコマンドを実行してください：

```bash
# GIGAスクール静的ルール検証
node .claude/skills/giga-reviewer/scripts/lint-giga.mjs .
# または正本側から:
node standards/skills/giga-reviewer/scripts/lint-giga.mjs .

# Service Worker の版数一致検査
node tools/build-sw.mjs --check
```

---

## 3. レビュー結果の解釈と修正指針

1. **CDNエラーが出た場合**:
   - 該当ライブラリを `npm install` してバンドルするか、静的JSファイルとして `vendor/` に配置してローカル読み込みに切り替えてください。
2. **PIIエラーが出た場合**:
   - 氏名入力欄を撤廃し、キャラクター選択や自動採番ID、端末ローカルでの完結に設計変更してください。
3. **SW版数エラーが出た場合**:
   - `node tools/build-sw.mjs` を実行してキャッシュ版数を再生成してください。
