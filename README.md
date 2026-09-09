# ChronoVeil

本地运行的 AI 角色扮演聊天应用（Tauri 2 + React + Fluent UI v9 + SQLite）。个人自用，一切数据本地化。

设计基线存放在 **relay-harbor** 项目（条目 + 关系 + ADR），本仓库不维护设计文档；`docs/` 仅保留原始资料：

- `docs/应用设计概念.md` — 概念总览
- `docs/streaming-animations.html` — 渲染引擎演示页（机制参照）

## 开发

```bash
pnpm install
pnpm run dev      # 纯浏览器开发（mock 数据，无需 Rust 工具链）
pnpm run check    # 依赖守卫 + IPC 登记 + Rust 边界 + 单测
pnpm run build
```

包管理用 pnpm（不再使用 npm 与 package-lock.json）。多工作树开发：依赖未变更时在 worktree 内用 `cmd /c mklink /J node_modules <主仓>\node_modules` 复用主仓依赖，瞬时就绪；依赖有变更时用 `pnpm install --frozen-lockfile`（首次约 3 分钟，对比 npm 的 7–8 分钟）。

桌面壳（`src-tauri/`，`pnpm run tauri dev`）在阶段 3 接入后端时启用。

## 结构

见 relay-harbor「架构与部署」文档的代码结构章节（ADR-010）：前端 `src/` 单向依赖 `app → features → components/engine → api`，渲染引擎 `src/engine/` 纯 TS + DOM + CSS 禁 React；Rust 四层 `interfaces → services → domain ← infra`，`state.rs` 组合根。改动代码前先查 relay-harbor 对应设计条目。
