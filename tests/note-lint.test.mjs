/**
 * note の記事の検査。
 *
 * 基準は連載の実例（GIGAyama/Qalc の note 記事、本文約7,900字・画面21点）から起こした。
 * だから確かめるべきことは2つある。
 *   ・実例と同じ形の記事が通ること（厳しすぎると、正しい記事が書けなくなる）
 *   ・実例と違う形の記事が落ちること（ゆるいと、何も見ていないのと同じ）
 * 片方だけでは信用できない。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { lintArticle, unsourcedNumbers } from '../scripts/lib/note-lint.mjs';

const style = JSON.parse(fs.readFileSync(new URL('../config/note-style.json', import.meta.url), 'utf8'));
const guardrails = JSON.parse(fs.readFileSync(new URL('../config/guardrails.json', import.meta.url), 'utf8'));
const monetization = { enabled: false };

/** 実例と同じ形の記事を組み立てる。字数は下限をわずかに超えるようにする。 */
function goodArticle(over = {}) {
    const filler =
        '計算練習の時間になると、教室はいくつかに分かれます。さっさと解き終わって手持ちぶさたになる子と、一問目で鉛筆が止まったまま時間だけが過ぎていく子です。' +
        'その両方を横目に見ながら丸をつけることになる先生のことも考えて、手のかからない形にしたいと思いました。';
    // 6節で 7,000 字を超えるようにする。実例は約7,900字だった。
    const body = filler.repeat(10);

    const sections = style.sections
        .filter((s) => !s.generated)
        .map((s) => `## ${s.heading}\n\n${body}\n`);

    const markdown = [
        `# ${style.series} #◯ 「せんせい、わかりません」で止まらない。考える図が出てくる計算学習アプリ「Qalc」`,
        '',
        ...sections,
        `## 🏷 ハッシュタグ`,
        '',
        '#小学校 #算数 #GIGAスクール',
        '',
    ].join('\n');

    return {
        article: { title: '「せんせい、わかりません」で止まらない。考える図が出てくる計算学習アプリ「Qalc」' },
        markdown,
        ...over,
    };
}

function lintOf(over = {}) {
    const { article, markdown } = goodArticle(over);
    return lintArticle({ article, markdown, style, guardrails, monetization });
}

test('実例の記事は、そのまま検査を通る', () => {
    // これがいちばん大事な検査。ここが落ちるなら、基準のほうが間違っている。
    const path = new URL('./fixtures/qalc-note-article.md', import.meta.url);
    if (!fs.existsSync(path)) return; // 実例を置いていない環境では飛ばす

    const markdown = fs.readFileSync(path, 'utf8');
    const title = markdown.split('\n')[0];
    const problems = lintArticle({ article: { title }, markdown, style, guardrails, monetization });
    assert.deepEqual(problems, [], `実例が落ちています: ${JSON.stringify(problems, null, 2)}`);
});

test('同じ形に組んだ記事は通る', () => {
    assert.deepEqual(lintOf(), []);
});

/* ── 形（装飾） ─────────────────────────────── */

test('太字を使うと落ちる', () => {
    const { markdown } = goodArticle();
    const problems = lintArticle({
        article: { title: 'あ「い」う「え」' },
        markdown: markdown.replace('計算練習', '**計算練習**'),
        style,
        guardrails,
        monetization,
    });
    assert.ok(problems.some((p) => p.includes('太字')), JSON.stringify(problems));
});

test('表を使うと落ちる', () => {
    const { article, markdown } = goodArticle();
    const problems = lintArticle({
        article,
        markdown: `${markdown}\n| 学年 | 問題数 |\n| --- | --- |\n`,
        style,
        guardrails,
        monetization,
    });
    assert.ok(problems.some((p) => p.includes('表')), JSON.stringify(problems));
});

test('区切り記号を使うと落ちる', () => {
    const { article, markdown } = goodArticle();
    for (const symbol of ['→', '／', '▲']) {
        const problems = lintArticle({
            article,
            markdown: markdown.replace('教室は', `教室${symbol}は`),
            style,
            guardrails,
            monetization,
        });
        assert.ok(problems.some((p) => p.includes(symbol)), `${symbol} を見逃しています`);
    }
});

test('本文に絵文字があると落ちる', () => {
    const { article, markdown } = goodArticle();
    const problems = lintArticle({
        article,
        markdown: markdown.replace('計算練習の時間', '計算練習の時間😊'),
        style,
        guardrails,
        monetization,
    });
    assert.ok(problems.some((p) => p.includes('絵文字')), JSON.stringify(problems));
});

test('見出しの絵文字は落とさない', () => {
    // 見出しには絵文字が付いている。ここを弾くと、正しい記事が1つも通らない。
    assert.ok(!lintOf().some((p) => p.includes('絵文字')));
});

/* ── 分量 ──────────────────────────────────── */

test('短すぎる記事は落ちる', () => {
    const markdown = ['# タイトル「あ」「い」', '', '## 🏫 はじめに', '', 'みじかい本文です。'].join('\n');
    const problems = lintArticle({ article: { title: 'あ「い」う「え」' }, markdown, style, guardrails, monetization });
    assert.ok(problems.some((p) => p.includes('本文が') && p.includes('字です')), JSON.stringify(problems));
});

test('字数の判定に画像の記法を数えない', () => {
    // 画像を並べれば字数が増える、という数え方だと意味がない。
    const { article, markdown } = goodArticle();
    const withImages = markdown + '\n' + '![とても長いキャプションの画像です](images/01-home.png)\n'.repeat(30);
    const problems = lintArticle({ article, markdown: withImages, style, guardrails, monetization });
    assert.ok(!problems.some((p) => p.includes('多い')), JSON.stringify(problems));
});

/* ── 骨格 ──────────────────────────────────── */

test('決まった見出しが欠けていると落ちる', () => {
    const { article, markdown } = goodArticle();
    const problems = lintArticle({
        article,
        markdown: markdown.replace('## ✨ 導入のメリット', '## 導入のいいところ'),
        style,
        guardrails,
        monetization,
    });
    assert.ok(problems.some((p) => p.includes('✨ 導入のメリット')), JSON.stringify(problems));
});

test('見出しの順が入れかわると落ちる', () => {
    // note は見出しから目次を作る。並びがそのまま記事の骨格になる。
    const { article } = goodArticle();
    const body = 'あ'.repeat(1200);
    const order = ['📝 まとめ', '🏫 はじめに', '📱 このアプリでできること', '✨ 導入のメリット', '🛠️ 【管理者向け】導入手順', '📖 【利用者向け】使い方のガイド'];
    const markdown = ['# タイトル', '', ...order.map((h) => `## ${h}\n\n${body}\n`), '## 🏷 ハッシュタグ', '', '#小学校'].join('\n');
    const problems = lintArticle({ article, markdown, style, guardrails, monetization });
    assert.ok(problems.some((p) => p.includes('がありません')), JSON.stringify(problems));
});

test('目玉の節は2本まで足せる', () => {
    const { article, markdown } = goodArticle();
    const extra = `## 💡 目玉の機能\n\n${'あ'.repeat(900)}\n\n## 🤝 もうひとつ\n\n${'い'.repeat(900)}\n`;
    const withExtra = markdown.replace('## ✨ 導入のメリット', `${extra}\n## ✨ 導入のメリット`);
    const problems = lintArticle({ article, markdown: withExtra, style, guardrails, monetization });
    assert.ok(!problems.some((p) => p.includes('目次が散らかります')), JSON.stringify(problems));
});

test('目玉の節が3本になると落ちる', () => {
    const { article, markdown } = goodArticle();
    const extra = ['💡 ひとつ', '🤝 ふたつ', '🎯 みっつ'].map((h) => `## ${h}\n\n${'あ'.repeat(600)}\n`).join('\n');
    const withExtra = markdown.replace('## ✨ 導入のメリット', `${extra}\n## ✨ 導入のメリット`);
    const problems = lintArticle({ article, markdown: withExtra, style, guardrails, monetization });
    assert.ok(problems.some((p) => p.includes('目次が散らかります')), JSON.stringify(problems));
});

test('手順の節では箇条書きを使ってよい', () => {
    const { article, markdown } = goodArticle();
    const withList = markdown.replace(
        '## 📖 【利用者向け】使い方のガイド\n',
        '## 📖 【利用者向け】使い方のガイド\n\n1. アドレスを開きます\n2. 学年を選びます\n'
    );
    const problems = lintArticle({ article, markdown: withList, style, guardrails, monetization });
    assert.ok(!problems.some((p) => p.includes('箇条書き')), JSON.stringify(problems));
});

test('手順の節の外で箇条書きを使うと落ちる', () => {
    const { article, markdown } = goodArticle();
    const withList = markdown.replace(
        '## ✨ 導入のメリット\n',
        '## ✨ 導入のメリット\n\n- 一つ目のいいこと\n- 二つ目のいいこと\n'
    );
    const problems = lintArticle({ article, markdown: withList, style, guardrails, monetization });
    assert.ok(problems.some((p) => p.includes('箇条書き')), JSON.stringify(problems));
});

/* ── 言葉 ──────────────────────────────────── */

test('専門用語は言いかえを添えて落とす', () => {
    const { article, markdown } = goodArticle();
    const problems = lintArticle({
        article,
        markdown: markdown.replace('計算練習', 'ローカルストレージ'),
        style,
        guardrails,
        monetization,
    });
    const hit = problems.find((p) => p.includes('ローカルストレージ'));
    assert.ok(hit, JSON.stringify(problems));
    assert.ok(hit.includes('その端末のなかだけに残ります'), '言いかえ先を出していません');
});

test('定型の前置きは落ちる', () => {
    const { article, markdown } = goodArticle();
    const problems = lintArticle({
        article,
        markdown: markdown.replace('計算練習の時間', '結論から言うと、計算練習の時間'),
        style,
        guardrails,
        monetization,
    });
    assert.ok(problems.some((p) => p.includes('結論から言うと')), JSON.stringify(problems));
});

test('「児童」は落ちる（この連載では「子どもたち」）', () => {
    const { article, markdown } = goodArticle();
    const problems = lintArticle({
        article,
        markdown: markdown.replace('子と、', '児童と、'),
        style,
        guardrails,
        monetization,
    });
    assert.ok(problems.some((p) => p.includes('児童')), JSON.stringify(problems));
});

test('ハッシュタグの行は言葉の検査から外す', () => {
    // 「#個別最適な学び」は学習指導要領の言葉で、実例の記事にも入っている。
    // 抽象語として弾くと、正しい記事が落ちる。
    const { article, markdown } = goodArticle();
    const withTags = markdown.replace('#小学校 #算数 #GIGAスクール', '#小学校 #個別最適な学び #GIGAスクール');
    const problems = lintArticle({ article, markdown: withTags, style, guardrails, monetization });
    assert.deepEqual(problems, []);
});

/* ── 教室での出来事 ─────────────────────────── */

test('教室で見たこととして書くと落ちる', () => {
    // 文章を作っているのは機械で、その日その教室で何が起きたかを知らない。
    // ここを通すと、本人の名前で嘘が出る。
    for (const bad of [
        'うちのクラスでは、静かになりました。',
        '実際に使ってみたら、手が止まらなくなりました。',
        '子どもたちが自分から開いてくれました。',
        '先週の授業でためしました。',
    ]) {
        const { article, markdown } = goodArticle();
        const problems = lintArticle({
            article,
            markdown: markdown.replace('計算練習の時間になると、', bad),
            style,
            guardrails,
            monetization,
        });
        assert.ok(problems.some((p) => p.includes('ご自身で足して')), `見逃しています: ${bad}`);
    }
});

test('一般の困りごととして書くのは通る', () => {
    // 「計算練習の時間、手が止まる子がいます」は誰の教室でも起きること。
    // ここまで弾くと、書けることが無くなる。
    const { article, markdown } = goodArticle();
    const problems = lintArticle({
        article,
        markdown: markdown.replace(
            '計算練習の時間になると、',
            '計算練習の時間には、手が止まってしまう子がいます。そういう場面を思いうかべて作りました。'
        ),
        style,
        guardrails,
        monetization,
    });
    assert.deepEqual(problems, []);
});

/* ── タイトル ─────────────────────────────── */

test('鉤かっこの無いタイトルは落ちる', () => {
    const { markdown } = goodArticle();
    const problems = lintArticle({
        article: { title: '計算学習アプリを作りました' },
        markdown,
        style,
        guardrails,
        monetization,
    });
    assert.ok(problems.some((p) => p.includes('タイトルの型')), JSON.stringify(problems));
});

test('タイトルの長さは連載名を除いて数える', () => {
    // 連載名と番号は機械が前に付ける。それを含めて数えると、
    // 型どおりに書いたタイトルが必ず長すぎになる。
    const { markdown } = goodArticle();
    const title = `${style.series} #◯ 「せんせい、わかりません」で止まらない。考える図が出てくる計算学習アプリ「Qalc」`;
    const problems = lintArticle({ article: { title }, markdown, style, guardrails, monetization });
    assert.ok(!problems.some((p) => p.includes('長すぎます')), JSON.stringify(problems));
});

/* ── 数字の裏取り ───────────────────────────── */

test('資料に無い数字を挙げる', () => {
    // README が古いままだと、数字は平気で嘘になる。
    const source = '教育漢字1026字。119コース。';
    assert.deepEqual(unsourcedNumbers('教育漢字1026字を、119コースに分けてあります。', source), []);
    assert.deepEqual(unsourcedNumbers('全部で12796問あります。', source), ['12796']);
});

test('桁区切りのあるなしを同じものとして見る', () => {
    assert.deepEqual(unsourcedNumbers('約12,796問', '12796問'), []);
    assert.deepEqual(unsourcedNumbers('約12796問', '12,796問'), []);
});

test('1桁の数字は見ない（「三つ」「一つ目」に紛れるため）', () => {
    assert.deepEqual(unsourcedNumbers('3つのいいことがあります。', ''), []);
});

test('画像のキャプションに出る数字は見ない', () => {
    assert.deepEqual(unsourcedNumbers('![1年生の画面](images/01-home.png)', ''), []);
});
