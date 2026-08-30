# GIGAスクール Webアプリ開発・運用基準 (Workspace Rules)

本ワークスペース（`GIGAyama.github.io`）および傘下の全GIGAスクールWebアプリ群における開発・保守ルールです。
Antigravity（Gemini）および Claude Code の双方が共通して遵守すべき最高位の行動原則を定めます。

※ システム全体の詳細設計・障害教訓・データフローについては、必ず
`GIGAyama.github.io/docs/architecture/SYSTEM_MASTER.md` を参照してください。

⚠️ この文書の正本は `GIGAyama.github.io/standards/agents/rules/gigaschool-standards.md`
です。各リポジトリの `.agents/rules/` にあるものは配布された写しなので、
**直接編集しても他のリポジトリには届きません。** 直すときは正本を直し、
`node tools/distribute.mjs` で配ってください。

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
  - タッチ操作に配慮したボタンサイズ（タップ領域は **48px × 48px 以上**を既定とする）。
  - ⚠️ ただし **リポジトリ側の品質ゲートが明示している数値が優先**する。
    たとえば Werewolf は GIGA Standard v4 世代で 44px を採用し、CI がその値で
    検査している。ここの数値に合わせて 44px の側を書き替えると、そのリポジトリの
    ゲートと文書の両方と食い違う。新規に作るものは 48px、既存のものは
    そのリポジトリのゲートに従うこと。
  - rem 指定のタップ領域は狭い端末で下限を割る。下限は **px の絶対値**で置くこと。
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

コミット・PR作成前に、**そのリポジトリに在るものだけ**を必ずパスさせること。
無いものを走らせて ENOENT で止まるのは「検査に通っていない」であって
「検査が無い」ではない。まず `package.json` の `scripts` を見て、在るものを走らせる。

| 何を見るか | コマンド | 在る場所 |
| --- | --- | --- |
| 単体テスト | `npm test`（無ければ `node --test`） | `scripts.test` のあるリポジトリ |
| 品質ゲート | `npm run check` | `scripts.check` のあるリポジトリ |
| SW版数整合性 | `node tools/build-sw.mjs --check` | `tools/build-sw.mjs` が `--check` を持つリポジトリのみ |
| 正本整合性 | 下記 | 全リポジトリ |

⚠️ **`--check` を持たない `build-sw.mjs` がある。** 手書きのものや、正本が古いまま
配られたものがそれで、渡しても黙って無視して **`dist/sw.js` を書き換える**。
検査のつもりが作業ツリーを変え、しかもレビューでは「検査は通った」と読まれる。
SessionStart のフック（`announce-checks.mjs`）は中身を見て、受けつけるものだけを
案内する。案内に出ていなければ、そのリポジトリでは走らせない。

⚠️ **検査は、直し終わってから走らせる。** SW の版は配信物の中身から作るので、
検査を通したあとに 1 文字直すだけで合わなくなる。手元では緑のまま、CI で初めて
赤くなる形になる。

### 正本整合性検査（check-drift）の走らせ方

⚠️ **配布先のリポジトリに `standards/` は無い。** 正本はポータル
（`GIGAyama.github.io`）だけが持つ。`node standards/check-drift.mjs` と打っても
配布先では必ず ENOENT で落ちる。

- **配布先（アプリのリポジトリ）**: ポータルを隣に置いてから、その正本を指して走らせる。

  ```bash
  node ../GIGAyama.github.io/standards/check-drift.mjs \
       --standards ../GIGAyama.github.io/standards
  ```

  CI は同じことを `.standards-src` へチェックアウトして行っている
  （`.github/workflows/*.yml` の drift ジョブ）。

- **ポータル自身**: `node standards/check-drift.mjs --standards standards`

`--standards` は必須。省くと使い方を出して exit 2 で終わる。
