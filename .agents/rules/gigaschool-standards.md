# GIGAスクール Webアプリ開発・運用基準 (Workspace Rules)

本ワークスペース（`GIGAyama.github.io`）および傘下の全GIGAスクールWebアプリ群における開発・保守ルールです。
Antigravity（Gemini）および Claude Code の双方が共通して遵守すべき最高位の行動原則を定めます。

※ システム全体の詳細設計・障害教訓・データフローについては、必ず [SYSTEM_MASTER.md](file:///c:/Users/basst/gigayama/GIGAyama.github.io/docs/architecture/SYSTEM_MASTER.md) を参照してください。

---

## 1. アプリケーション設計原則 (Architecture Invariants)
- **外部CDN非依存・自己完結 (Zero External CDN)**:
  - 学校現場のネットワーク制限（i-FILTER等）やオフライン環境を考慮し、外部CDN（cdnjs, unpkg, Google Fonts, jsdelivr等）からのランタイム読み込みは**原則禁止**。
  - ライブラリ・アイコン・フォントはバンドルまたはローカル静的配信（自己完結）とすること。
- **Service Worker & PWA 版管理 (Cache & SW)**:
  - アプリ改修時は、必ず `sw.js` または Service Worker のキャッシュ版数を更新すること。
  - `standards/sw/` のスクリプト（`build-sw-vite.mjs` / `build-sw-static.mjs`）に準拠し、ファイル内容ハッシュから自動生成すること。
- **正本コードとの同期 (Drift Prevention)**:
  - 共通モジュール（Service Worker生成、品質ゲート、学習ログ連携 `records/` 等）を改修する場合は、**個別リポジトリを直接直さず、必ず `standards/` 配下の正本を更新**し、`distribute.mjs` を通じて配布すること。

---

## 2. 児童目線UI/UX & 教育的配慮 (Child-Centric UI/UX)
- **直感性と誤操作防止**:
  - タッチ操作に配慮したボタンサイズ（タップ領域 48px × 48px 以上必須）。
  - 直感的でコントラストの高いカラー設計（WCAG AA基準準拠）。
- **言語・可読性**:
  - 対象学年に応じた漢字選定およびルビ（`<ruby>` タグ）の適切な付与。
- **反応性・フィードバック**:
  - アニメーションやWeb Audio API等による明快な視覚・聴覚フィードバック。

---

## 3. 個人情報ゼロトラスト (Zero Tolerance for PII)
- **児童データの秘匿**:
  - 児童の氏名・出席番号・顔写真・学級名等の個人特定可能情報は一切コード・コミット・ログ・外部通信に含めない。
- **ローカル完結 (Local First)**:
  - 学習履歴やスコアデータはブラウザ内ストレージ（localStorage / IndexedDB）で完結させ、不必要な外部送信を行わない。

---

## 4. AI開発エージェント共通コマンド・チェック手順
コミット・PR作成前には以下のチェックを必ずパスさせること：
- `npm test` または `node --test`（単体テスト）
- `node tools/build-sw.mjs --check`（SW版数整合性検査）
- `node standards/check-drift.mjs`（正本整合性検査）
