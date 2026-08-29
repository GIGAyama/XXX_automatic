---
name: giga-fleet
description: GIGAスクール艦隊 42 本の状態をまとめて調べ、次に直すべきものを作業待ち行列として出す。ユーザーが「艦隊の状態を見せて」「どのアプリが Zero-CDN 違反？」「品質ゲートが入っていないのはどれ」「配布の抜けを調べて」「fleet-status」「全部のリポジトリの状況」「次に何を直すべき?」のように言ったときは必ずこのスキルを使う。1 本のリポジトリではなく艦隊全体を横断して見たい、という話ならこのスキルを検討する。個々のリポジトリの品質検査（giga-reviewer）や新規立ち上げ（giga-scaffold）とは見る範囲が違うので取り違えない。
---

# 艦隊の状態を読む

42 本を 1 本ずつ歩かない。**歩いたぶんだけ文脈が埋まる**ので、
「v5 ゲートが入っていないのはどれか」を調べるだけで、肝心の作業に使う余地が無くなる。

```bash
node tools/fleet-status.mjs           # 人が読む表
node tools/fleet-status.mjs --json    # 機械が読む
node tools/fleet-status.mjs --todo    # 作業待ち行列（これがいちばん使う）
```

⚠️ これはポータル（`GIGAyama.github.io`）の道具です。配布先には在りません。
配布先で作業しているなら、ポータルへ移ってから走らせてください。

## `--todo` の読み方

出るのは「違反 → 直し方 → 使う正本の道具」の 3 点セット。

```
[Zero-CDN] KANJI_Town: fonts.googleapis.com
    → standards/fonts/build-fonts.mjs で自己ホスト化（束は 780 字まで）

[ゲート未配備] 24 本: scripts/lib/giga-v5-checks.mjs が無い
    → standards/lib/run-giga-checks.mjs を scripts/check-standard.mjs として配る
```

**直し方まで出しているのは、行列を見た人がすぐ動けるようにするため。**
「違反が 4 件あります」だけでは、次に何をすればよいかが分からず、
結局もう一度 42 本を調べることになる。

## 数字を信じる前に、どこから来たかを見る

| 行 | 出どころ | いつのものか |
| --- | --- | --- |
| Zero-CDN 違反 | `data/apps.json` の `hosts` | 毎朝 `sync-updates.yml` が**配布ファイルの静的解析から推定** |
| ゲート・SW・hook の有無 | 隣に置いた各リポジトリのファイル | いま手元にあるもの |

⚠️ **Zero-CDN の行は推定です。** 静的解析なので、実行時に組み立てられる URL は
見えません（`['cd','n.js','delivr','.net'].join('')` のような形）。逆に、直したばかりの
ものが古いまま残って見えることもあります。生成日が添えて出るので、必ず見てください。

実測が要るときは、実ブラウザで通信を記録するほうを走らせます。

```bash
node tools/verify-runtime.mjs              # 公開中の 41 本を巡回
node tools/verify-runtime.mjs --slug typa  # 1 本だけ
```

## 「測れなかった」を「きれい」と読まない

配布先が手元に無ければ（CI では自分しか checkout していない）、
その行は `unmeasured` に入り、合格として数えられません。

```
⚠️ 手元に無くて調べられなかった 30 本（調べていない、であって、きれい、ではありません）
```

このときは隣に clone してから、もう一度走らせてください。
**「0 件でした」を信じない**のは、この艦隊で何度も痛い目を見た形です。

## 行列を消すときの順番

1. **正本を直す**（`standards/` 配下）。配布先の写しを直しても、他の 41 本には届きません
2. **正本をコミットする**。先に配ると、手元だけ緑で正本が古く残ります（2026-08-28 の #98 → #99）
3. `node tools/distribute.mjs --dry-run` で確かめてから配る
4. `node tools/check-distribution.mjs --skip-repo-list` で配り残しを見る

## 関わりのある道具

| 見たいもの | 道具 |
| --- | --- |
| 艦隊ぜんぶの持ちもの | `tools/fleet-status.mjs`（これ） |
| 実際に出ていく通信 | `tools/verify-runtime.mjs` / `standards/web/verify-no-external.mjs` |
| 1 本の Zero-CDN・Zero-PII | `giga-reviewer` スキル |
| 配布の抜け | `tools/check-distribution.mjs` |
| そのリポジトリのずれ | `standards/check-drift.mjs` |
