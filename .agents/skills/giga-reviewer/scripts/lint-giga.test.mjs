import test from 'node:test';
import assert from 'node:assert/strict';
import { lintContent } from './lint-giga.mjs';

test('lintContent: Zero-CDN checks', () => {
  const badHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
        <script src="https://cdn.jsdelivr.net/npm/vue@3"></script>
      </head>
    </html>
  `;
  const resBad = lintContent('index.html', badHtml);
  assert.equal(resBad.errors.length, 2);
  assert.equal(resBad.errors[0].rule, 'zero-cdn');

  const goodHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="stylesheet" href="style.css">
        <script src="app.js"></script>
      </head>
    </html>
  `;
  const resGood = lintContent('index.html', goodHtml);
  assert.equal(resGood.errors.length, 0);
});

test('lintContent: Zero-PII checks', () => {
  const badHtml = `
    <form>
      <input type="text" id="student_name" placeholder="氏名を入力">
    </form>
  `;
  const resBad = lintContent('index.html', badHtml);
  assert.equal(resBad.errors.length, 2);
  assert.equal(resBad.errors[0].rule, 'zero-pii');

  const goodHtml = `
    <div id="player-select">
      <button data-avatar="cat">ねこ</button>
      <button data-avatar="dog">いぬ</button>
    </div>
  `;
  const resGood = lintContent('index.html', goodHtml);
  assert.equal(resGood.errors.length, 0);
});
