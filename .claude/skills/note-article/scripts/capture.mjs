/* eslint-disable */
/* 実ブラウザでアプリを操作してスクリーンショットを撮るための土台。
 *
 *   node capture.mjs <シナリオファイル> [--base URL] [--out ディレクトリ] [--strict]
 *
 * シナリオ側は「どのボタンを押して、どこで撮るか」だけを書けばよい。
 * Chromium の場所さがし、ふりがなを落とした文字照合、React の input への
 * 値入れ、複数端末の同時起動といった面倒は、こちらで引きうける。
 *
 * ── この土台がいちばん力を入れていること
 * 撮影で本当に困るのは、失敗そのものではなく「失敗に気づかないまま最後まで進む」こと。
 * 押せていないのに撮り続けて、同じ画面が20枚並ぶ。だから次のようにしてある。
 *
 *   1. click は押せなかったら例外で止まる。押せる文字の一覧を添えて落ちる
 *   2. shot は画面が止まるまで待ってから撮る。止まらなければ警告を出す
 *   3. shot は直前の絵と見くらべて、同じなら警告を出す
 *   4. 画面のエラーを集めて、最後にまとめて見せる。--strict なら異常終了する
 *   5. 撮ったものは report.json に残る。どの画面を撮ったかが記事を書くときの資料になる
 *
 * ── シナリオの書きかた
 *
 *   // shots.mjs
 *   export const viewport = { width: 390, height: 940 };  // 省略可
 *   export default async ({ open, log }) => {
 *     const p = await open('main');            // 1台ぶんのブラウザを開く
 *     await p.shot('01-home');
 *     log(await p.buttons());                  // 次に何を押せるか分からないときはこれ
 *
 *     await p.clickTo('スコアアタック', '学年をえらぶ');  // 押して、画面が変わるまで待つ
 *     await p.shot('02-select', { expect: '3年' });      // その文字が無ければ撮らずに落ちる
 *   };
 *
 * 複数端末が要るとき（P2P のマルチプレイなど）は open を何回も呼ぶ。
 * それぞれ独立したブラウザのプロファイルになるので、保存データも混ざらない。
 *
 *   const host = await open('リーダー');
 *   const kids = [];
 *   for (const name of ['たろう', 'はなこ']) kids.push(await open(name));
 *
 * ── 使える道具
 *   click(文字, {nth, exact, optional, scroll})   押す。押せなければ落ちる
 *   clickTo(文字, 変わったら出る文字)              押して、画面が変わるのを見届ける
 *   waitFor(文字, ms)                              その文字が出るまで待つ
 *   expect(文字)                                   出ていなければ落ちる
 *   buttons() / text(n) / has(文字)                いま何が押せるか、何が書いてあるか
 *   setInput(index か selector, 値) / setRange(値, nth)
 *   type(文字列) / press(キー)
 *   scrollTo(文字, {optional})                    寄せる。寄せられなければ落ちる
 *   resize(w, h) / sleep(ms)
 *   freeze() / unfreeze()                          アニメーションを止める、戻す
 *   shot(名前, {expect, fullPage, note})           撮る
 *   eval(fn, arg)                                  抜け道
 */
import { existsSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

/* playwright は、このスクリプトの隣ではなく「作業中のリポジトリ」に入っている。
 * ふつうに import すると、スキルの置き場所から node_modules をさがしにいって
 * 見つからない。作業ディレクトリを起点に解決しなおす。 */
const chromium = await (async () => {
  try {
    return createRequire(join(process.cwd(), 'x.js'))('playwright').chromium;
  } catch (e) {
    try {
      return (await import('playwright')).chromium;
    } catch (e2) {
      console.error('playwright が見つからない。リポジトリの中で次を実行してから、もう一度。');
      console.error('  npm i --no-save playwright');
      process.exit(2);
    }
  }
})();

// ---------------------------------------------------------------- Chromium さがし
const findChromium = () => {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined; // playwright に任せる
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const dir of dirs) {
    for (const rel of [
      'chrome-linux/chrome',
      'chrome-linux64/chrome',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-win/chrome.exe',
    ]) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------- 引数
const args = process.argv.slice(2);
const FLAGS = ['base', 'out'];
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const STRICT = args.includes('--strict');
const scenarioPath = args.find((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = args[i - 1];
  return !(prev && prev.startsWith('--') && FLAGS.includes(prev.slice(2)));
});
if (!scenarioPath) {
  console.error('使いかた: node capture.mjs <シナリオファイル> [--base URL] [--out ディレクトリ] [--strict]');
  process.exit(2);
}
const BASE = flag('base', process.env.BASE || 'http://127.0.0.1:4180/');
const OUT = resolve(flag('out', process.env.OUT || './shots'));
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- ページ内で走る道具
// ふりがな（<rt>）とルビ用のかっこ（<rp>）を落としてから文字を比べる。
// 「へやに入る」を探しているのに、DOM 上は「へやに入はいる」になっている、が普通に起きる。
//
// 見えていないもの、押せないものは最初から候補から外す。ここを緩くすると、
// 画面の裏に隠れている前の画面のボタンを押してしまい、撮れる絵が静かに狂う。
const IN_PAGE = `(() => {
  const norm = (el) => {
    const c = el.cloneNode(true);
    if (c.querySelectorAll) c.querySelectorAll('rt, rp').forEach((r) => r.remove());
    return ((c.textContent || el.getAttribute('aria-label') || '')).replace(/\\s+/g, '').trim();
  };
  const shown = (e) => {
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
    if (e.closest('[aria-hidden="true"], [inert]')) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 4 || r.height <= 4) return false;
    if (r.bottom < -200 || r.right < -200) return false;
    const s = getComputedStyle(e);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    if (s.pointerEvents === 'none') return false;
    return true;
  };
  const clickables = () => [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], summary, label, input[type=checkbox], input[type=radio], select')].filter(shown);
  /* 指で触ったのと同じ順に出す。el.click() は click しか出さないので、
     onPointerDown だけを見ているボタンは「押せたのに何も起きない」になる。
     反応を速くしたいアプリ（子ども向けのキーパッドなど）はこの作りが多い。
     本物のタップでも click は続けて出るので、両方出すほうが実機に近い。

     ⚠️ pointerdown を preventDefault したら、そこで止める。本物のブラウザも
        そうしていて、「pointerdown で処理して click は止める」作りのアプリを
        二重に動かさないための分かれ道になっている。 */
  const tap = (el) => {
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const opts = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, ...at };
    const P = window.PointerEvent || window.MouseEvent;
    const live = el.dispatchEvent(new P('pointerdown', { ...opts, buttons: 1, pointerType: 'touch' }));
    if (live) el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
    el.dispatchEvent(new P('pointerup', { ...opts, buttons: 0, pointerType: 'touch' }));
    if (live) {
      el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
      el.click();
    }
  };
  const findAll = (label, exact) => {
    const t = String(label).replace(/\\s+/g, '');
    const c = clickables();
    const eq = c.filter((e) => norm(e) === t);
    if (eq.length) return { tier: 'exact', els: eq };
    if (exact) return { tier: null, els: [] };
    const sw = c.filter((e) => norm(e).startsWith(t));
    if (sw.length) return { tier: 'startsWith', els: sw };
    const inc = c.filter((e) => norm(e).includes(t));
    return { tier: inc.length ? 'includes' : null, els: inc };
  };
  /* click() と同じで、ふりがなを落としてから返す。
     落とさないと、押せる文字（click）と待てる文字（waitFor / expect）が
     食い違う。DOM は「へやに入はいる」なので、シナリオに書いた
     「へやに入る」で押せるのに待てない、という形になる。
     innerText は行の切れ目を保つので、clone ではなく CSS で消す。 */
  const visibleText = () => {
    const st = document.createElement('style');
    st.textContent = 'rt,rp{display:none!important}';
    (document.head || document.documentElement).appendChild(st);
    try {
      const t = document.body.innerText || '';
      return t.replace(/\\n{2,}/g, '\\n').trim();
    } finally {
      st.remove();
    }
  };
  return { norm, shown, clickables, findAll, visibleText, tap };
})()`;

// ---------------------------------------------------------------- 記録
/* 前回の結果が残っていれば、撮り比べる。撮り直しのとき、どの画面が変わったのかが
 * 分かると、本文のどこを直せばいいかが決まる。全部撮り直したのに本文を直し忘れる、
 * という失敗がいちばん多い。 */
const baseline = (() => {
  try { return JSON.parse(readFileSync(join(OUT, 'report.json'), 'utf8')); } catch { return null; }
})();
const before = new Map((baseline?.shots || []).map((s) => [s.name, s]));

const manifest = [];
const problems = [];
const errorsByPage = new Map();
const note = (kind, label, msg) => {
  problems.push({ kind, page: label, msg });
  console.warn(`  ⚠ [${label}] ${msg}`);
};
const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- 1台ぶんのラッパ
const wrap = (page, label) => {
  let lastImage = null;
  let lastFingerprint = null;
  const trail = [];

  const api = {
    label,
    raw: page,
    trail,

    /** 文字でボタンを押す。押せなければ例外で止まる。ふりがなは無視して比べる */
    async click(text, { nth = 0, exact = false, optional = false, scroll = true } = {}) {
      const res = await page.evaluate(([src, t, n, ex, doScroll]) => {
        const { findAll, norm, clickables, tap } = eval(src);
        const { tier, els } = findAll(t, ex);
        if (!els.length) return { ok: false, candidates: clickables().map(norm).filter(Boolean).slice(0, 24) };
        const el = els[Math.min(n, els.length - 1)];
        if (doScroll) el.scrollIntoView({ block: 'center' });
        tap(el);
        return { ok: true, tier, count: els.length, label: norm(el) };
      }, [IN_PAGE, text, nth, exact, scroll]);

      if (!res.ok) {
        if (optional) return false;
        throw new Error(
          `[${label}] 押せなかった: ${text}\n  いま押せるもの: ${res.candidates.join(' / ') || '（なし）'}\n`
          + '  一覧に出ていないなら、次のどちらか。\n'
          + '    ・画面の外にある（内側にスクロール容器がある画面。p.scrollTo で寄せてから押す）\n'
          + '    ・role="button" の無い <div onClick>（候補にならない。p.eval で直に押す）'
        );
      }
      if (res.tier === 'includes') note('あいまい一致', label, `「${text}」を部分一致で押した。実際は「${res.label}」`);
      if (res.count > 1 && nth === 0) note('候補が複数', label, `「${text}」に当てはまるものが${res.count}個ある。nth を指定したほうがいい`);
      trail.push(`押した: ${res.label}`);
      return true;
    },

    /** 押して、画面が変わったことを見届ける。変わらなければ落ちる */
    async clickTo(text, expectText, { timeoutMs = 8000, ...opts } = {}) {
      await api.click(text, opts);
      if (!(await api.waitFor(expectText, timeoutMs))) {
        const now = await api.buttons();
        throw new Error(
          `[${label}] 「${text}」を押したが「${expectText}」が出ない。画面が変わっていない可能性がある\n  いま押せるもの: ${now.join(' / ')}`
        );
      }
      return true;
    },

    /** その文字が出るまで待つ。出なければ false */
    async waitFor(text, timeoutMs = 8000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await api.has(text)) return true;
        await page.waitForTimeout(250);
      }
      return false;
    },

    /** 画面のどこかにその文字があるか。ボタンでなくてもよい */
    has(text) {
      return page.evaluate(([src, t]) => {
        const { findAll, visibleText } = eval(src);
        const k = String(t).replace(/\s+/g, '');
        return findAll(t, false).els.length > 0 || visibleText().replace(/\s+/g, '').includes(k);
      }, [IN_PAGE, text]);
    },

    /** 出ていなければ落ちる。撮る前の確認に使う */
    async expect(text) {
      if (!(await api.waitFor(text, 6000))) {
        throw new Error(`[${label}] 期待した文字が画面にない: ${text}\n  いまの画面:\n${await api.text(400)}`);
      }
      return true;
    },

    /** 押せるものの文字を全部返す。次に何を押せばいいか分からないときに使う */
    buttons() {
      return page.evaluate((src) => {
        const { clickables, norm } = eval(src);
        return clickables().map(norm).filter(Boolean);
      }, IN_PAGE);
    },

    /** 画面の文字。既定は先頭800字 */
    text(limit = 800) {
      return page.evaluate(([src, n]) => eval(src).visibleText().slice(0, n), [IN_PAGE, limit]);
    },

    /* React の input は el.value = x では state が動かない。
       ネイティブの setter を呼んでから input イベントを投げる必要がある */
    setInput(indexOrSelector, value) {
      return page.evaluate(([sel, v]) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const el = typeof sel === 'number' ? document.querySelectorAll('input')[sel] : document.querySelector(sel);
        if (!el) return false;
        setter.call(el, String(v));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, [indexOrSelector, value]);
    },

    /** スライダー（input[type=range]）を動かす */
    setRange(value, nth = 0) {
      return page.evaluate(([v, n]) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const el = document.querySelectorAll('input[type=range]')[n];
        if (!el) return false;
        setter.call(el, String(v));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, [value, nth]);
    },

    /** キーボードから打つ。手書き入力や数字パッドのあるアプリで使う */
    type: (s, delay = 60) => page.keyboard.type(String(s), { delay }),
    press: (k) => page.keyboard.press(k),

    /** 目当ての文字が画面に入るまでスクロールする。寄せられなければ落ちる */
    async scrollTo(text, { optional = false } = {}) {
      const res = await page.evaluate(([src, t]) => {
        const { findAll, norm } = eval(src);
        const want = String(t).replace(/\s+/g, '');
        /* 子の数でふるいにかけるのは、中身の多い入れ物（画面まるごとの <div>）を
           掴んで見当ちがいのところへ寄せないため。
           ⚠️ **ルビは数に入れない。** ふりがなは字の飾りであって入れ物の構造では
              ないのに、<ruby> は 1 語に 1 つ増える。数に入れると、ふりがなを
              振った見出しほど先にはじかれる ── いちばん寄せたいものが、
              いちばん当たらない。マイ漢字タウンの「今日のミッション」は
              children が 7 で、7 つとも <ruby> だった（2026-08-30 に実測）。 */
        const boxiness = (e) => [...e.children].filter((c) => c.tagName !== 'RUBY').length;
        const hit = findAll(t, false).els[0];
        const el = hit || [...document.querySelectorAll('h1,h2,h3,h4,p,div,span')]
          .find((e) => norm(e).includes(want) && boxiness(e) < 6);
        if (!el) {
          return { ok: false, near: [...document.querySelectorAll('h1,h2,h3,h4,p,span')]
            .map(norm).filter(Boolean).slice(0, 24) };
        }
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        return { ok: true, label: norm(el) };
      }, [IN_PAGE, text]);

      /* ⚠️ 当たらなかったときに false を返して黙って先へ進まないこと。
         2026-08-30 に、寄せたつもりの画面が動かないまま次の shot() が撮られ、
         設定画面の同じ絵が 4 枚並んだ。撮り手は本文を書くまで気づけない。
         「同じ絵」の警告は出るが、それが出るのは 3 手あとで、しかも
         「押せていない可能性がある」と、押した側のせいに読める。
         当たらなかったその行で、その名前を出して落とすほうが早い。 */
      if (!res.ok) {
        if (optional) return false;
        throw new Error(
          `[${label}] 寄せられなかった: ${text}\n  いま画面にある字: ${res.near.join(' / ') || '（なし）'}\n`
          + '  当たらないときは、まず ルビを外した字で書いているか確かめる\n'
          + '  （references/screenshots.md の 1 節）。\n'
          + '  寄せられなくても続けてよいときだけ scrollTo(text, { optional: true })。'
        );
      }
      return true;
    },

    /** 画面の大きさを変える。縦長にすると1枚に収まる画面がある */
    async resize(width, height) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(600);
    },

    /** アニメーションを止める。演出の途中が写ってしまうときの逃げ道。
     *  お祝いの演出そのものを撮りたいときは使わない */
    freeze: () => page.addStyleTag({ content: '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}' }).then(() => true),
    unfreeze: () => page.evaluate(() => [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('animation-play-state:paused')).forEach((s) => s.remove())),

    sleep: (ms) => page.waitForTimeout(ms),

    /** 画面が落ちつくのを待つ。フォント、画像、描画の3つ */
    async settle() {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => {});
      await page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => i.decode().catch(() => {})))).catch(() => {});
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
    },

    /** 撮る。
     *  expect を渡すと、その文字が画面にあることを確かめてからでないと撮らない。
     *  画面が止まるまで撮り直し、直前の絵と同じなら警告する。 */
    async shot(name, { expect, fullPage = false, tries = 3, note: memo } = {}) {
      if (expect) await api.expect(expect);
      await api.settle();

      let buf = await page.screenshot({ fullPage });
      let stable = false;
      for (let i = 1; i < tries; i++) {
        await page.waitForTimeout(280);
        const again = await page.screenshot({ fullPage });
        if (sha(again) === sha(buf)) { stable = true; buf = again; break; }
        buf = again;
      }
      if (!stable && tries > 1) note('動いている', label, `${name}.png は撮影中も画面が変わり続けている。演出の途中かもしれない`);

      const hash = sha(buf);
      const screen = (await api.text(300)).replace(/\s+/g, ' ').trim();
      const fp = sha(screen);

      if (lastImage === hash) note('同じ絵', label, `${name}.png が直前の1枚と完全に同じ。押せていない可能性がある`);
      else if (lastFingerprint === fp && fp) note('同じ画面', label, `${name}.png は直前と同じ画面に見える`);
      lastImage = hash;
      lastFingerprint = fp;

      const file = join(OUT, `${name}.png`);
      writeFileSync(file, buf);
      const size = statSync(file).size;
      manifest.push({ name: `${name}.png`, page: label, bytes: size, hash, screen: screen.slice(0, 120), note: memo || null, trail: trail.slice(-4) });
      console.log(`  撮った  ${name}.png  ${(size / 1024).toFixed(0)}KB  ${screen.slice(0, 40)}`);
      return file;
    },

    /** ページ内で自由に評価する。凝ったことをしたいとき用の抜け道 */
    eval: (fn, arg) => page.evaluate(fn, arg),
  };
  return api;
};

// ---------------------------------------------------------------- 走らせる
const scenarioUrl = pathToFileURL(isAbsolute(scenarioPath) ? scenarioPath : resolve(scenarioPath)).href;
const scenario = await import(scenarioUrl);
const vp = scenario.viewport || { width: 390, height: 940 };

const browser = await chromium.launch({ executablePath: findChromium() });
const opened = [];

const open = async (label = `page${opened.length + 1}`, opts = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: opts.width || vp.width, height: opts.height || vp.height },
    deviceScaleFactor: opts.deviceScaleFactor ?? 2,   // 2倍で撮ると note で拡大しても粗くならない
    locale: opts.locale || 'ja-JP',
    timezoneId: opts.timezoneId || 'Asia/Tokyo',
    reducedMotion: opts.reducedMotion,               // 'reduce' で演出を弱められる
  });
  const page = await ctx.newPage();
  errorsByPage.set(label, []);
  const record = (m) => { errorsByPage.get(label).push(m); console.error(`  ✗ [${label}] ${m.slice(0, 220)}`); };
  page.on('pageerror', (e) => record(`画面のエラー: ${String(e)}`));
  page.on('console', (m) => { if (m.type() === 'error') record(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => record(`読み込み失敗: ${r.url().slice(0, 120)}`));
  await page.goto(opts.url || BASE, { waitUntil: 'networkidle' });
  // 出だしのアニメーションが終わるのを待つ。600ms では足りず、要素を数え落とした過去がある
  await page.waitForTimeout(opts.settleMs ?? 2200);
  const api = wrap(page, label);
  opened.push(api);
  return api;
};

const log = (...a) => console.log(...a);

let failed = false;
try {
  await scenario.default({ open, log, base: BASE, out: OUT, pages: opened });
} catch (e) {
  console.error(`\nシナリオが落ちた:\n${e.message || e}`);
  failed = true;
} finally {
  await browser.close().catch(() => {});
}

// ---------------------------------------------------------------- あとしまつ
const allErrors = [...errorsByPage.entries()].flatMap(([p, list]) => list.map((m) => ({ page: p, msg: m })));
const totalBytes = manifest.reduce((a, m) => a + m.bytes, 0);

writeFileSync(join(OUT, 'report.json'), JSON.stringify({
  base: BASE, at: new Date().toISOString(), shots: manifest, problems, pageErrors: allErrors,
}, null, 2));

console.log(`\n── まとめ`);
console.log(`  ${manifest.length}枚  ${(totalBytes / 1024 / 1024).toFixed(1)}MB  出力先 ${OUT}`);
const heavy = manifest.filter((m) => m.bytes > 3 * 1024 * 1024);
if (heavy.length) console.log(`  重い画像  ${heavy.map((m) => m.name).join(', ')}  note に上げる前に小さくする`);
if (problems.length) console.log(`  気になるところ  ${problems.length}件。report.json を見る`);

if (before.size) {
  const changed = manifest.filter((m) => before.has(m.name) && before.get(m.name).hash !== m.hash);
  const same = manifest.filter((m) => before.has(m.name) && before.get(m.name).hash === m.hash);
  const added = manifest.filter((m) => !before.has(m.name));
  const gone = [...before.keys()].filter((n) => !manifest.some((m) => m.name === n));
  console.log(`\n  前回と比べて  変わった${changed.length}／同じ${same.length}／新しい${added.length}／撮らなかった${gone.length}`);
  for (const m of changed.slice(0, 20)) console.log(`    変わった  ${m.name}  ${m.screen.slice(0, 36)}`);
  for (const m of added) console.log(`    新しい    ${m.name}`);
  for (const n of gone) console.log(`    撮らなかった  ${n}  記事がまだ参照しているなら消さない`);
  if (changed.length) console.log('    変わった画面については、本文の書きぶりが古くなっていないか読み直す');
}
if (allErrors.length) {
  console.log(`\n  画面のエラー ${allErrors.length}件。壊れている機能がないか確かめる`);
  for (const e of allErrors.slice(0, 12)) console.log(`    [${e.page}] ${e.msg.slice(0, 160)}`);
}
console.log(`  一覧は ${join(OUT, 'report.json')}\n`);

if (failed) process.exitCode = 1;
else if (STRICT && allErrors.length) process.exitCode = 1;
