#!/usr/bin/env node
/** 校验 package.json 依赖与 config/dependency-whitelist.json 一致（ADR-010：新增依赖须登记）。 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const whitelist = JSON.parse(readFileSync(new URL('../config/dependency-whitelist.json', import.meta.url), 'utf8'));

const diffs = [];
for (const section of ['dependencies', 'devDependencies']) {
  const actual = new Set(Object.keys(pkg[section] ?? {}));
  const allowed = new Set(whitelist[section] ?? []);
  for (const name of actual) {
    if (!allowed.has(name)) diffs.push(`未登记的 ${section}: ${name}`);
  }
  for (const name of allowed) {
    if (!actual.has(name)) diffs.push(`已登记但未安装的 ${section}: ${name}`);
  }
}

if (diffs.length > 0) {
  console.error('[check-dependency-whitelist] 不一致：');
  for (const d of diffs) console.error(`  - ${d}`);
  console.error('新增依赖请先加入 config/dependency-whitelist.json 再 npm install。');
  process.exit(1);
}
console.log('[check-dependency-whitelist] ok');
