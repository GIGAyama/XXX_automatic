# スキルの正本

`.claude/skills/` に置いて使うスキルの、正本の置き場。

```
standards/skills/
├── devlog-article/    開発記録（giga-school.com/devlog/）を書く
└── note-article/      note の紹介記事「教室で使えるかもしれないもの作り」を書く
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

配布先のリポジトリでは `.claude/skills/<名前>/` に**写す**。
`standards-map.json` に `dirs` で 1 行書けば、あとは機械が見張る。

```json
{
  "dirs": [
    { "canonical": "skills/devlog-article", "local": ".claude/skills/devlog-article" },
    { "canonical": "skills/note-article",   "local": ".claude/skills/note-article" }
  ]
}
```

`files` と違って 1 ファイルずつ並べない。`dirs` は両方向に見るので、
**正本にファイルを 1 本足した瞬間、配布先ぜんぶが赤くなる。**
`files` で並べる方式だと、対応表を直し忘れたぶんが黙って配られない。

⚠️ **ポータル自身は写しを作らない。** `standards/` の中身が原本なので、
`.claude/skills/` からシンボリックリンクを張り、`standards-map.json` の
`unmanaged` に理由つきで書いてある。2 つになった時点で、どちらが正本か
分からなくなる。

## 配る先

コードの正本（ゲート・SW・受け渡し口）とは**配る先が違う**。

| | 配る先 | 台帳の書き方 |
|---|---|---|
| コードの正本 | 32 本 | `targets` |
| スキル | 42 本 | `targets` ＋ `skills.extra` |

`excluded` の 10 本が外れている理由はどれも「正本のコピーを1つも持たない」で、
これはコードの話。開発はどのリポジトリでも起きるので、スキルはそちらにも配る。
理由そのものは正しいので書き替えていない。かわりに軸を分けてある。

## 検査

| いつ | 何が見るか |
|---|---|
| 配布先の CI | `standards/check-drift.mjs`（ずれ・欠け・**余り**・未登録） |
| ポータルの CI | `tools/check-distribution.mjs`（ずれ・欠け・**配り忘れ**） |

⚠️ ポータル側からは配布先の「余分なファイル」が見えない。ディレクトリを
列挙する手だてが無いため（GitHub API は使わない約束）。そこは配布先の
`check-drift` が見る。役割を分けてある。

スキルの中の検査は、スキル自身が持っている。

```
node standards/skills/devlog-article/scripts/lint-devlog.mjs docs/devlog/<記事>.md
node standards/skills/note-article/scripts/lint-article.mjs  docs/note/<記事>.md
```

⚠️ `note-article` の `lint-article.mjs` は開発記録には流用できない。理由は
`devlog-article/SKILL.md` の「4. 機械で確かめる」に書いてある。
