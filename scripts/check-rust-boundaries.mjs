#!/usr/bin/env node
/** 校验 Rust 四层边界（ADR-010）：interfaces → services → domain ← infra；domain/services 禁 tauri/rusqlite/reqwest（含 tauri_plugin_* 等下划线子 crate）。 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src-tauri/src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
if (!existsSync(SRC)) {
  console.log('[check-rust-boundaries] src-tauri 不存在，跳过');
  process.exit(0);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.rs')) files.push(full);
  }
  return files;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** layer 允许依赖的 crate:: 目标（含自身）；infra 只许进 domain，services 可用 domain/infra，interfaces 全可。 */
const ALLOWED = {
  domain: ['domain'],
  services: ['domain', 'infra', 'services'],
  infra: ['domain', 'infra'],
  // state 为组合根状态（state.rs）：命令层经 State<AppState> 取用（state.rs 契约，TASK-005 接线起生效）。
  interfaces: ['domain', 'infra', 'services', 'interfaces', 'state'],
};

const violations = [];

for (const file of walk(SRC)) {
  const rel = file.split(/[\\/]src-tauri[\\/]src[\\/]/)[1] ?? file;
  const layer = rel.split(/[\\/]/)[0].replace(/\.rs$/, '');
  if (!(layer in ALLOWED)) continue; // lib.rs / state.rs / main.rs 组合根，不限制
  const code = stripComments(readFileSync(file, 'utf8'));

  for (const m of code.matchAll(/\bcrate::(\w+)/g)) {
    if (!ALLOWED[layer].includes(m[1])) {
      violations.push(`${rel}: ${layer} 层不得引用 crate::${m[1]}`);
    }
  }
  if (layer === 'domain' || layer === 'services') {
    // 下划线子 crate 同族同禁（如 tauri_plugin_log / tauri_plugin_dialog）：`\b` 在
    // tauri 后遇 `_` 不构成边界会漏网，故捕获完整 crate 名并以前瞻拒绝后续字母数字。
    for (const m of code.matchAll(/^\s*(?:use\s+)?((?:tauri|rusqlite|reqwest)(?:_\w+)?)(?![A-Za-z0-9])/gm)) {
      violations.push(`${rel}: ${layer} 层禁依赖 ${m[1]}（ADR-010）`);
    }
  }
}

if (violations.length > 0) {
  console.error('[check-rust-boundaries] 违规：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('[check-rust-boundaries] ok');
