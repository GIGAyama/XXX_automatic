/**
 * 使うモデルの選び方のテスト。
 *
 * ここが狂うと、気づかないうちに preview 版で毎週の投稿を書いていた、
 * あるいは古い版のまま止まっていた、ということが起きる。
 * どちらも「動いてはいる」ので、気づくまでに時間がかかる種類の壊れ方である。
 *
 * 新しい版が出たときに本当に追従するかを確かめたいので、
 * まだ存在しない gemini-3 系を混ぜたケースを置いてある。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { describeModel, rankModels, readPolicy, shortName, usableModels } from '../scripts/lib/gemini-models.mjs';

/** API が返す形をまねる。 */
function model(name, methods = ['generateContent', 'countTokens']) {
    return { name: `models/${name}`, supportedGenerationMethods: methods };
}

const TYPICAL = [
    model('gemini-2.0-flash'),
    model('gemini-2.5-flash'),
    model('gemini-2.5-flash-lite'),
    model('gemini-2.5-flash-preview-05-20'),
    model('gemini-2.5-pro'),
    model('gemini-flash-latest'),
    model('gemini-embedding-001', ['embedContent']),
    model('imagen-4.0-generate-001', ['predict']),
    model('veo-3.0-generate-001', ['predictLongRunning']),
    model('gemini-2.5-flash-image'),
    model('gemma-3-27b-it'),
];

test('models/ の接頭辞を落とす', () => {
    assert.equal(shortName('models/gemini-2.5-flash'), 'gemini-2.5-flash');
    assert.equal(shortName('gemini-2.5-flash'), 'gemini-2.5-flash');
});

test('名前から系統と版を読み取る', () => {
    assert.deepEqual(describeModel('gemini-2.5-flash'), {
        id: 'gemini-2.5-flash',
        family: 'flash',
        major: 2,
        minor: 5,
        rolling: false,
        dated: false,
        stable: true,
    });

    const lite = describeModel('models/gemini-2.5-flash-lite');
    assert.equal(lite.family, 'flash-lite', 'flash-lite が flash に吸われています');

    const pro = describeModel('gemini-3-pro');
    assert.equal(pro.family, 'pro');
    assert.equal(pro.major, 3);
    assert.equal(pro.minor, 0);
});

test('preview / exp を安定版と見なさない', () => {
    assert.equal(describeModel('gemini-2.5-flash-preview-05-20').stable, false);
    assert.equal(describeModel('gemini-2.0-flash-exp').stable, false);
    assert.equal(describeModel('gemini-2.5-flash').stable, true);
});

test('中身が入れかわる別名と、日付つきの断面を見分ける', () => {
    assert.equal(describeModel('gemini-flash-latest').rolling, true);
    assert.equal(describeModel('gemini-2.5-flash').rolling, false);
    assert.equal(describeModel('gemini-2.5-flash-preview-05-20').dated, true);
    assert.equal(describeModel('gemini-2.5-flash-001').dated, true);
    assert.equal(describeModel('gemini-2.5-flash').dated, false);
});

test('文章を書かせられないモデルを外す', () => {
    const ids = usableModels(TYPICAL).map((m) => shortName(m.name));
    for (const excluded of [
        'gemini-embedding-001',
        'imagen-4.0-generate-001',
        'veo-3.0-generate-001',
        'gemini-2.5-flash-image',
        'gemma-3-27b-it',
    ]) {
        assert.ok(!ids.includes(excluded), `${excluded} が候補に残っています`);
    }
    assert.ok(ids.includes('gemini-2.5-flash'));
});

test('generateContent を持たないものは外す', () => {
    const ids = usableModels([model('gemini-9.9-flash', ['countTokens'])]).map((m) => shortName(m.name));
    assert.deepEqual(ids, []);
});

test('既定では flash 系の安定版のうち、いちばん新しいものを選ぶ', () => {
    assert.equal(rankModels(TYPICAL)[0], 'gemini-2.5-flash');
});

test('新しい版が出たら、何も直さなくてもそちらに移る', () => {
    // これがこの仕組みの目的そのもの。
    const withNext = [...TYPICAL, model('gemini-3-flash')];
    assert.equal(rankModels(withNext)[0], 'gemini-3-flash');

    const withMinor = [...withNext, model('gemini-3.5-flash')];
    assert.equal(rankModels(withMinor)[0], 'gemini-3.5-flash');
});

test('既定では preview を選ばない', () => {
    // preview のほうが版が新しくても、安定版があるならそちらを使う。
    const list = [model('gemini-2.5-flash'), model('gemini-3-flash-preview-01-01')];
    assert.equal(rankModels(list)[0], 'gemini-2.5-flash');
});

test('allowPreview を立てれば preview も候補に入る', () => {
    const list = [model('gemini-2.5-flash'), model('gemini-3-flash-preview-01-01')];
    assert.equal(rankModels(list, { allowPreview: true })[0], 'gemini-3-flash-preview-01-01');
});

test('中身が入れかわる別名は既定で選ばない', () => {
    // gemini-flash-latest は「いちばん新しい」を名乗るが、preview を指していることがある。
    // こちらが何もしていないのに生成の質が変わるのは困る。
    assert.ok(!rankModels(TYPICAL).includes('gemini-flash-latest'));
});

test('系統を指定できる', () => {
    assert.equal(rankModels(TYPICAL, { prefer: 'pro' })[0], 'gemini-2.5-pro');
    assert.equal(rankModels(TYPICAL, { prefer: 'flash-lite' })[0], 'gemini-2.5-flash-lite');
});

test('同じ版なら、日付や枝番の付かない名前を選ぶ', () => {
    const list = [model('gemini-2.5-flash-001'), model('gemini-2.5-flash')];
    assert.equal(rankModels(list)[0], 'gemini-2.5-flash');
});

test('欲しい系統が1つも無くても、使えるものは候補に残す', () => {
    // pro しか無い日に「flash が無いので生成できません」で止まるのは筋が悪い。
    const list = [model('gemini-2.5-pro')];
    assert.deepEqual(rankModels(list, { prefer: 'flash' }), ['gemini-2.5-pro']);
});

test('候補が1つも無ければ空を返す（呼び出し側が控えに落とせる）', () => {
    assert.deepEqual(rankModels([]), []);
    assert.deepEqual(rankModels([model('gemini-embedding-001', ['embedContent'])]), []);
    assert.deepEqual(rankModels(null), []);
});

test('壊れた応答でも落ちない', () => {
    assert.doesNotThrow(() => rankModels([{}, { name: null }, 'ごみ']));
});

test("geminiModel が 'auto' なら自動選択、モデル名なら固定", () => {
    const auto = readPolicy({ geminiModel: 'auto' });
    assert.equal(auto.auto, true);
    assert.equal(auto.pinned, null);

    const pinned = readPolicy({ geminiModel: 'gemini-2.5-flash' });
    assert.equal(pinned.auto, false);
    assert.equal(pinned.pinned, 'gemini-2.5-flash');
});

test('設定が空でも既定値で動く', () => {
    const policy = readPolicy({});
    assert.equal(policy.auto, true);
    assert.equal(policy.prefer, 'flash');
    assert.equal(policy.allowPreview, false);
    assert.equal(policy.fallback, 'gemini-2.5-flash');
});

test('実際の config が読める形になっている', () => {
    // ここが崩れると、週次が走ってはじめて分かる。
    const accounts = JSON.parse(fs.readFileSync(new URL('../config/accounts.json', import.meta.url), 'utf8'));
    const policy = readPolicy(accounts);
    assert.ok(policy.auto || policy.pinned, 'geminiModel が読めません');
    assert.ok(['flash', 'pro', 'flash-lite'].includes(policy.prefer), `geminiModelPrefer が変です: ${policy.prefer}`);
    assert.ok(policy.fallback.startsWith('gemini-'), `geminiModelFallback が変です: ${policy.fallback}`);
});
