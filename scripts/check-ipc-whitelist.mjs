#!/usr/bin/env node
/** 校验 IPC 命令登记：invoke 只出现在 src/api/，且命令名都在 config/ipc-command-whitelist.json 中（ADR-010）。 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const INVOKE_RE = /\binvoke\s*(?:<[^>]*>)?\(\s*['"]([\w:]+)['"]/g;
// tauri-specta 生成的 bindings 以别名调用：await TAURI_INVOKE("cmd", {...})
const BINDINGS_INVOKE_RE = /\bTAURI_INVOKE\(\s*['"]([\w:]+)['"]/g;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const whitelist = JSON.parse(readFileSync(new URL('../config/ipc-command-whitelist.json', import.meta.url), 'utf8'));
const registered = new Set(whitelist.commands ?? []);
const violations = [];
const found = new Set();

for (const file of walk(SRC)) {
  const rel = file.split(/[\\/]src[\\/]/)[1] ?? file;
  const inApi = rel.startsWith('api');
  const content = readFileSync(file, 'utf8');
  for (const m of content.matchAll(INVOKE_RE)) {
    const cmd = m[1];
    if (cmd.startsWith('plugin:')) continue;
    if (!inApi) violations.push(`${rel}: invoke 出现在 src/api 之外`);
    found.add(cmd);
    if (!registered.has(cmd)) violations.push(`${rel}: 命令 "${cmd}" 未在 ipc-command-whitelist.json 登记`);
  }
}

// bindings 已生成（TASK-005 起）：生成命令 ↔ 登记表双向比对，防止 collect_commands 漂移。
const bindings = new URL('../src/api/generated/bindings.ts', import.meta.url);
let bindingsNote = 'bindings 未生成（tauri-specta 阶段 3 接入后自动比对）';

if (existsSync(bindings)) {
  const content = readFileSync(bindings, 'utf8');
  const bindingCmds = new Set([...content.matchAll(BINDINGS_INVOKE_RE)].map((m) => m[1]));
  for (const cmd of bindingCmds) {
    if (!registered.has(cmd)) {
      violations.push(`api/generated/bindings.ts: 命令 "${cmd}" 未在 ipc-command-whitelist.json 登记`);
    }
  }
  for (const cmd of registered) {
    if (!bindingCmds.has(cmd)) {
      violations.push(`config/ipc-command-whitelist.json: 命令 "${cmd}" 未出现在 tauri-specta bindings（collect_commands 与登记表漂移）`);
    }
  }
  bindingsNote = `bindings 双向比对通过（${bindingCmds.size} 个命令）`;
}

if (violations.length > 0) {
  console.error('[check-ipc-whitelist] 违规：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
const directNote = found.size > 0 ? `直接 invoke ${found.size} 处` : '无直接 invoke（统一走 bindings）';
console.log(`[check-ipc-whitelist] ok（${directNote}；${bindingsNote}）`);
