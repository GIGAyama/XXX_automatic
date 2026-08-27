# スキルの正本

`.claude/skills/` および `.agents/skills/` に置いて使うスキルの、正本の置き場。

```
standards/skills/
├── devlog-article/    開発記録（giga-school.com/devlog/）を書く
├── note-article/      note の紹介記事「教室で使えるかもしれないもの作り」を書く
├── giga-scaffold/     GIGAスクールWebアプリの新規立ち上げ・スキャフォールディング
└── giga-reviewer/     Zero-CDN、Zero-PII、児童UI/UX、SW版数の一括品質検査
```

## なぜ配るのか

スキルは**開発をしたセッションの上**で走らせる。Typa の開発記録を書くセッションは
Typa のリポジトリにいて、記事の納品先も Typa の `docs/devlog/` になる。
正本のあるポータルにしか置かないと、**書きたい場所に道具が無い。**

⚠️ 古いコピーの壊れ方は「落ちる」ではなく「黙る」。front matter の書き方が古いと、
`build-devlog.mjs` はその記事を下書きとして数えるだけで、警告は朝のワークフローの
ログに出る。あの流れは `GITHUB_TOKEN` で push するので standards-ci が起動しない。
**誰も見ないログに出る警告は、出ていないのと同じ。**

## 置き方

配布先のリポジトリでは `.claude/skills/<名前>/` および `.agents/skills/<名前>/` に**写す**。
`standards-map.json` に `dirs` で行を書けば、あとは機械が見張る。

```json
{
  "dirs": [
    { "canonical": "skills/devlog-article", "local": ".claude/skills/devlog-article" },
    { "canonical": "skills/note-article",   "local": ".claude/skills/note-article" },
    { "canonical": "skills/giga-scaffold",  "local": ".claude/skills/giga-scaffold" },
    { "canonical": "skills/giga-reviewer",  "local": ".claude/skills/giga-reviewer" }
  ]
}
```

`files` と違って 1 ファイルずつ並べない。`dirs` は両方向に見るので、
**正本にファイルを 1 本足した瞬間、配布先ぜんぶが赤くなる。**
`files` で並べる方式だと、対応表を直し忘れたぶんが黙って配られない。

⚠️ **ポータル自身は写しを作らない。** `standards/` の中身が原本なので、
`standards-map.json` の `unmanaged` に理由つきで書いてある。

## 配る先

コードの正本（ゲート・SW・受け渡し口）とは**配る先が違う**。

| | 配る先 | 台帳の書き方 |
|---|---|---|
| コードの正本 | 32 本 | `targets` |
| スキル | 42 本 | `targets` ＋ `skills.extra` |

`excluded` の 10 本が外れている理由はどれも「正本のコピーを1つも持たない」で、
これはコードの話。開発はどのリポジトリでも起きるので、スキルはそちらにも配る。

## 検査

| いつ | 何が見るか |
|---|---|
| 配布先の CI | `standards/check-drift.mjs`（ずれ・欠け・**余り**・未登録） |
| ポータルの CI | `tools/check-distribution.mjs`（ずれ・欠け・**配り忘れ**） |

スキルの中の検査は、スキル自身が持っている。

```bash
node standards/skills/devlog-article/scripts/lint-devlog.mjs docs/devlog/<記事>.md
node standards/skills/note-article/scripts/lint-article.mjs  docs/note/<記事>.md
node standards/skills/giga-reviewer/scripts/lint-giga.mjs    .
```
