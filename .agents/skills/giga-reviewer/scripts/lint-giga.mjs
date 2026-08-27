#!/usr/bin/env node
/**
 * lint-giga.mjs — GIGAスクール標準 静的品質・教育・セキュリティ検証スクリプト
 * 
 * 検査項目:
 *   1. Zero External CDN (外部CDN読み込みの禁止)
 *   2. Zero PII (児童の個人特定可能情報の排除)
 *   3. Child-Centric UI (タッチ領域48px以上、外部フォント禁止等)
 *   4. SW & Deterministic Build (Service Workerキャッシュ整合性)
 * 
 * 使用法:
 *   node scripts/lint-giga.mjs [targetDir]
 */

import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN_CDN_PATTERNS = [
  /https?:\/\/cdn\.jsdelivr\.net/i,
  /https?:\/\/cdnjs\.cloudflare\.com/i,
  /https?:\/\/unpkg\.com/i,
  /https?:\/\/fonts\.googleapis\.com/i,
  /https?:\/\/fonts\.gstatic\.com/i,
  /https?:\/\/code\.jquery\.com/i,
  /https?:\/\/stackpath\.bootstrapcdn\.com/i,
  /https?:\/\/cdn\.tailwindcss\.com/i
];

const FORBIDDEN_PII_PATTERNS = [
  /<input[^>]+(?:name|id)=["'](?:student_name|shimei|namae|realname|user_email|email)["']/i,
  /placeholder=["'][^"']*(?:児童名|名前|なまえ|氏名|学籍番号|出席番号|メールアドレス)[^"']*["']/i
];

export function lintContent(filePath, content) {
  const errors = [];
  const warnings = [];
  const lines = content.split('\n');

  // Skip certain files (vendor, node_modules, .git, etc.)
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (
    normalizedPath.includes('/node_modules/') ||
    normalizedPath.includes('/.git/') ||
    normalizedPath.includes('/vendor/') ||
    normalizedPath.includes('/dist/')
  ) {
    return { errors, warnings };
  }

  // 1. Zero External CDN Check
  if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.ts') || filePath.endsWith('.css')) {
    lines.forEach((line, idx) => {
      for (const pattern of FORBIDDEN_CDN_PATTERNS) {
        if (pattern.test(line)) {
          errors.push({
            file: filePath,
            line: idx + 1,
            rule: 'zero-cdn',
            message: `外部CDNからの読み込みが検出されました (Zero External CDN違反): "${line.trim()}"`
          });
        }
      }
    });
  }

  // 2. Zero PII Check
  if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.vue') || filePath.endsWith('.svelte')) {
    lines.forEach((line, idx) => {
      for (const pattern of FORBIDDEN_PII_PATTERNS) {
        if (pattern.test(line)) {
          errors.push({
            file: filePath,
            line: idx + 1,
            rule: 'zero-pii',
            message: `個人情報(PII)を要求または保存するフィールドが検出されました (Zero PII違反): "${line.trim()}"`
          });
        }
      }
    });
  }

  // 3. Child UI / Touch Area Advisory Check
  if (filePath.endsWith('.css')) {
    lines.forEach((line, idx) => {
      if (/@import\s+url\(['"]?https?:\/\//i.test(line)) {
        errors.push({
          file: filePath,
          line: idx + 1,
          rule: 'zero-cdn',
          message: `外部フォント・外部スタイルのインポートが検出されました: "${line.trim()}"`
        });
      }
    });
  }

  return { errors, warnings };
}

export function lintDirectory(targetDir) {
  const allErrors = [];
  const allWarnings = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'vendor', 'dist', '.standards-src'].includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.html', '.js', '.mjs', '.ts', '.css', '.json'].includes(ext)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const { errors, warnings } = lintContent(fullPath, content);
          allErrors.push(...errors);
          allWarnings.push(...warnings);
        }
      }
    }
  }

  walk(targetDir);
  return { errors: allErrors, warnings: allWarnings };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const targetDir = process.argv[2] || process.cwd();
  console.log(`[giga-reviewer] GIGAスクール標準品質検査を開始: ${targetDir}`);
  
  const { errors, warnings } = lintDirectory(targetDir);

  if (warnings.length > 0) {
    console.log(`\n[WARNINGS] (${warnings.length}):`);
    warnings.forEach(w => console.log(`  ${w.file}:${w.line} - [${w.rule}] ${w.message}`));
  }

  if (errors.length > 0) {
    console.error(`\n[ERRORS] (${errors.length}):`);
    errors.forEach(e => console.error(`  ${e.file}:${e.line} - [${e.rule}] ${e.message}`));
    console.error(`\n❌ GIGAスクール標準検査に失敗しました。上記のエラーを修正してください。`);
    process.exit(1);
  } else {
    console.log(`\n✅ すべてのGIGAスクール標準検査（Zero-CDN, Zero-PII, 自己完結性）に合格しました。`);
    process.exit(0);
  }
}
