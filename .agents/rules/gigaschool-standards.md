# GIGAスクール Webアプリ開発・運用基準 (Workspace Rules)

本ワークスペース（`GIGAyama.github.io`）および傘下のGIGAスクールWebアプリ群における開発・保守ルールです。
Claude CodeおよびAntigravity（Gemini）双方で共通の品質基準を担保します。

---

## 1. アプリケーション設計原則 (Architecture)
- **外部CDN非依存・自己完結 (Zero External CDN)**:
  - 学校現場のネットワーク制限・フィルタリング（i-FILTER等）やオフライン環境を考慮し、外部CDN（cdnjs, unpkg, Google Fonts等）からのランタイム読み込みは原則禁止。
  - ライブラリ・アイコン・フォントはバンドルまたはローカル静的配信（自己完結）とすること。
- **Service Worker & PWA 版管理 (Cache & SW)**:
  - アプリ改修時は、必ず `sw.js` または Service Worker のキャッシュ版数を更新すること。
  - `standards/sw/` のスクリプト（`build-sw-vite.mjs` / `build-sw-static.mjs`）に準拠し、キャッシュの不整合や配信事故を防止する。
- **正本コードとの同期 (Drift Prevention)**:
  - 共通モジュール（Service Worker生成、学習ログ連携 `records/` 等）を改修する場合は、必ず `standards/` 配下の正本を更新し、各アプリへのコピーずれ（Drift）を発生させないこと。

---

## 2. 児童目線UI/UX & 教育的配慮 (Child-Centric UI/UX)
- **直感性と誤操作防止**:
  - タッチ操作に配慮したボタンサイズ（タップ領域 48px 以上推奨）。
  - 直感的でコントラストの高いカラー設計。
- **言語・可読性**:
  - 対象学年に応じた漢字選定およびルビ（`<ruby>` タグ）の適切な付与。
- **フィードバック性**:
  - アニメーションやWeb Audio API等による明快な視覚・聴覚フィードバック。

---

## 3. 個人情報ゼロトラスト (Zero Tolerance for PII)
- **児童データの秘匿**:
  - 児童の氏名・出席番号・顔写真等の個人特定可能情報は一切コード・コミット・ログに含めない。
- **ローカル完結 (Local First)**:
  - 学習履歴やスコアデータはブラウザ内ストレージ（localStorage / IndexedDB）で完結させ、不必要な外部送信を行わない。
