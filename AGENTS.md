# ChronoVeil — Agent 指南

本地运行的 AI 角色扮演聊天应用（Tauri 2 + React 19 + Fluent UI v9 + rusqlite/SQLite），Windows 下开发，个人自用、数据全本地。本仓库不维护设计文档；`docs/` 只放原始资料（应用设计概念、渲染引擎演示页）。

## 常用命令

包管理只用 pnpm（禁止 npm / package-lock.json）。

```bash
pnpm run dev        # 纯浏览器开发：mock 数据，无需 Rust 工具链（vite，端口 5173 strictPort）
pnpm run tauri dev  # 桌面壳（需 Rust 工具链；真实 IPC + ~/.chronoveil 数据）
pnpm run check      # 提交前的完整门禁：依赖守卫 + 依赖白名单 + IPC 登记 + Rust 边界 + vitest
pnpm run build      # tsc --noEmit && vite build（类型检查在这里）
pnpm run test       # vitest run（前端单测，jsdom；测试与源码同目录 *.test.ts(x)）
```

单独跑：`check:deps`（depcruise）/ `check:whitelist` / `check:ipc` / `check:rust`。Rust 侧测试与 TS bindings 再生成为 `cd src-tauri && cargo test`。没有 ESLint/Prettier，代码风格靠 tsc strict。

## 架构边界（有自动守卫，违反 = check 挂）

前端 `src/` 单向依赖 `app → features → components/engine → api`：

- `src/engine/` 渲染引擎纯 TS + DOM + CSS，**禁 React / Fluent**（必须能脱离 UI 用 vitest 测）。
- `src/features/` 之间禁止互相引用；跨 feature 复用下沉到 components / engine / api。
- `@tauri-apps/api` 与 invoke 只允许出现在 `src/api/`；浏览器 dev 由 `src/api/client.ts` 的 `isTauri` 切 mock（`src/api/mock/`）。
- `src/api/generated/bindings.ts` 是 tauri-specta 生成物，**勿手改**；改 Rust 命令签名后跑 `cargo test` 再生成。

Rust 四层（`src-tauri/src/`）：`interfaces → services → domain ← infra`；`lib.rs` / `state.rs` / `main.rs` 是组合根不受限。`domain`、`services` 禁用 tauri / rusqlite / reqwest。

## 改动时的登记点（改了必须同步，否则 check 挂）

- 新增 IPC 命令 → 登记 `config/ipc-command-whitelist.json`；wire DTO 用 `#[serde(rename_all = "camelCase")]`，错误统一 `IpcError`。
- 新增 npm 依赖 → 登记 `config/dependency-whitelist.json`。
- 新增 SQLite 迁移 → `src-tauri/migrations/` 加编号 SQL，并在 `infra/storage/migrations.rs` 的 `MIGRATIONS` 追加一行（不改历史条目，单迁移单事务）。
- tauri-specta / specta 版本必须钉死 `=`（rc 系列互相要求精确匹配）。
- UI 文案走 i18next：`src/i18n/zh.ts` 与 `en.ts` 要同步加 key（默认 zh）。

## 约定

- 注释 / 文档 / commit message 用中文。
- TypeScript strict 全开（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）。
- UI 用 Fluent UI v9 griffel 样式钩子（参照 `src/components/use*Styles.ts`）；会话清单以 `src/stores/ui.ts` 为单一数据源，刷新走 `refreshSessions` 单点重拉。
- 应用数据目录 `~/.chronoveil/`（`chronoveil.db` + `config.json`）；Rust 侧 home 可注入（`AppState::init_with_home`）便于测试。
