/**
 * GIGA Standard v5（Part I）の検査を、この検査器の報告の形につなぐ。
 *
 * 検査そのものは正本（GIGAyama.github.io/standards/lib/giga-v5-checks.mjs）の
 * 写しが受け持つ。ここにあるのは、設定の読み方と報告の形の変換だけである。
 *
 * ⚠️ check-project.mjs から切り出してあるのは、あちらが「読みこんだら
 *    全部走って process.exit する」台本だからである。テストから触れない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runGigaChecks } from './giga-v5-checks.mjs';

/**
 * 正本に渡す設定を、いま見ている木から読む。
 *
 * ⚠️ 外側の定数にしてはいけない。--self-test は木ごと写して壊すので、
 *    写しの quality.config.json を壊しても効かず、「壊したのに落ちない」
 *    検査ができてしまう（100マス計算で実際に起きた）。
 */
export function standardConfigOf(root) {
    return JSON.parse(fs.readFileSync(path.join(root, 'quality.config.json'), 'utf8')).standard;
}

/**
 * 落ちた検査を、この検査器の報告の形（severity / code / message / file）に直す。
 * 正本の severity は P1 / P2 なので、error / warning に読みかえる。
 */
export function gigaIssuesOf(root, cfg = standardConfigOf(root)) {
    return runGigaChecks(root, cfg).flatMap((r) => (r.ok ? [] : [{
        severity: r.severity === 'P2' ? 'warning' : 'error',
        code: r.id,
        message: r.detail.join(' / '),
        file: cfg.entryHtml,
    }]));
}
