# ChronoVeil — Agent 指南

本地运行的 AI 角色扮演聊天应用（Tauri 2 + React 19 + Fluent UI v9 + rusqlite/SQLite），Windows 下开发，个人自用、数据全本地。本仓库不维护设计文档；`docs/` 只放原始资料（应用设计概念、渲染引擎演示页）。

## 常用命令

包管理只用 pnpm（禁止 npm / package-lock.json）。

```bash
pnpm run dev        # 纯浏览器开发：mock 数据，无需 Rust 工具链（vite，端口 5173 strictPort）
pnpm run tauri dev  # 桌面壳（需 Rust 工具链；真实 IPC + ~/.chronoveil 数据）
pnpm run check      # 提交前的完整门禁：依赖守卫 + 依赖白名单 + IPC 登记 + Rust 边界 + tsc + vitest
pnpm run build      # tsc --noEmit && vite build（类型检查在这里）
pnpm run test       # vitest run（前端单测，jsdom；测试与源码同目录 *.test.ts(x)）
```

单独跑：`check:deps`（depcruise）/ `check:whitelist` / `check:ipc` / `check:rust`。Rust 侧测试与 TS bindings 再生成为 `cd src-tauri && cargo test`。没有 ESLint/Prettier，代码风格靠 tsc strict。

## 仓库结构速览

- `src/app/` 应用壳（`layout/`、`providers/`）｜`src/features/` 按领域分 `characters` / `chat` / `settings`（互相禁引）｜`src/components/` 跨 feature 复用 UI 与 griffel 样式钩子｜`src/engine/` 渲染引擎（纯 TS + DOM）｜`src/api/` IPC 封装（`generated/` 生成物、`mock/` 浏览器假后端）｜`src/stores/` zustand 全局态（`ui.ts` 会话单一数据源）｜`src/i18n/` zh/en 词典｜`src/lib/` 纯工具。
- `src-tauri/src/` 四层 `interfaces / services / domain / infra`；`src-tauri/migrations/` 编号 SQL；`config/` 依赖与 IPC 白名单；`scripts/` check 子命令脚本；`docs/` 设计资料与阶段性报告（非规范）；`.auto-iter/` 为 dev-toolkit 迭代工具的本地运行状态（不提交、非业务代码）。

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
- 新增「遍历 `document.styleSheets` / `cssRules`」类样式扫描断言的测试 → 必须同步登记 `vitest.config.ts` 的 `isolated-styles` project（include 加文件、shared 组 exclude 加同文件），否则在 shared 组（isolate: false）跨文件串扰失败。

## 约定

- 注释 / 文档 / commit message 用中文。
- TypeScript strict 全开（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）。
- UI 用 Fluent UI v9 griffel 样式钩子（参照 `src/components/use*Styles.ts`）；会话清单以 `src/stores/ui.ts` 为单一数据源，刷新走 `refreshSessions` 单点重拉。
- 应用数据目录 `~/.chronoveil/`（`chronoveil.db` + `config.json`）；Rust 侧 home 可注入（`AppState::init_with_home`）便于测试。
- **源文件硬上限 500 行**：任何源文件（.rs/.ts/.tsx，测试与生成物除外）超过 500 行必须在本次改动中考虑重构拆分（按领域/职责切子模块），并在返回/commit 中说明拆分方案或豁免理由；新建文件直接不得超过 500 行。

## 已知坑与例行处置（踩过实坑的固化，违者 reviewer 必拦）

- **mock 落库契约**：mock 层持久化 `calendarConfig` 必须 snake_case 键（`days_per_month` / `day_names`，对齐 `parseCalendarJson` 消费契约）；wire DTO（camelCase）与存储态（snake_case）是两种形态，禁止混存直落。
- **同构声明要证据**：断言「与 X 同构 / 逐位一致 / 语义相同」时必须附逐字段对照证据（diff 或测试断言），不接受无证据的口头同构。
- **跨文件常量互指**：同一约束的边界常量在多处出现（如历法月天数 1..=999 同时存在于校验、持久化与 AI 钳制路径）时，必须注释互指，优先编译期引用单一事实源。
- **数据迁移兼容性暂不适用（用户指令 2026-09-12）**：应用未发布、无存量数据要保护——schema 可破坏性变更（改列/删列/重建），行为变更不需要迁移桥接，迁移文件只需保证全新库能按序建到最新。**移除条件：用户说明已发布需要考虑存量数据时，本条失效**，届时所有 schema 变更恢复「旧数据可升级」约束。
- **cargo fmt --check 基线不净（工具链漂移，2026-09-12 实锤）**：本机 rustfmt（style-edition 2024）对全仓库约 497 文件报红，含 `build.rs` 等从未触碰的基线文件——格式基线是旧版 rustfmt 产物。例行处置：验证链以 `cargo clippy --all-targets -- -D warnings` + `cargo test` 为准，`cargo fmt --check` 不作门禁；**禁止顺手全仓库重排**（会污染纯搬移 diff 的可比对性）。移除条件：用户拍板统一升级格式基线（一次性专批全仓库 rustfmt，此后恢复 fmt 门禁）。
- **clippy 门禁必须带 --all-targets**：`cargo clippy -- -D warnings` 不覆盖 `#[cfg(test)]` 代码——Task-34 外置的 `calendar_draft/tests.rs` lint 因此漏网，三日后被后续任务门禁暴露。例行处置：任何声称「clippy 全绿」的验证报告必须确认命令含 `--all-targets`。
- **vitest shared 组 isolate: false（2026-09-13 提速实锤）**：除 `isolated-styles` 组 8 个文件外，同 worker 内 jsdom 环境与 Fluent 依赖树跨文件复用；RTL 不自动 cleanup（vitest globals 未开），受前序文件 DOM 残留影响的测试文件须自行 `afterEach(cleanup)`。纯逻辑 .ts 测试可在文件头加 `// @vitest-environment node` 跳过 jsdom 创建；依赖 window / Tauri mock 的测试（如 `src/api/events.test.ts`）必须保持 jsdom。

<!-- user-guidelines:start -->
<!-- stacks: rust, typescript, react, tauri -->

## 代码组织

- 严格按分层组织目录，禁止跨层直接引用。
- 一个类一个文件，文件名与类名一致；即使类只有十几行也不与其他类合并。
- 新建文件必须对应一个说得清的真实概念。

## 简单性

- 直接调用现有 API；禁止为“以后可能要换”添加中间层、包装类或预留扩展点。
- 重复出现两处以内不提取公共函数，不为单一调用方做抽象。
- 优先最小可用的直接实现；复杂度必须有真实需求背书。

## 错误处理纪律

- catch/except 块必须记录日志或重新抛出；禁止空捕获，禁止吞错后返回默认值假装成功。
- 错误日志使用项目统一 logger，必须携带上下文：操作、关键输入摘要、失败原因。
- 只防御有证据的错误；调用方契约保证的前提不做空检查。
- 新增防御代码必须附带能触发它的失败测试。

## 注释与文档

- 注释解释原因、不变量、约束与取舍，不复述代码表面行为。
- 修改行为时同步更新相关注释；过期注释视为缺陷。
- TODO/FIXME 必须写明未完成原因与移除条件，禁止只写占位描述。
- lint、类型或安全检查的抑制注释必须说明理由，并限制在最小范围。

## 测试与验收

- 行为变化配套相应测试；无法测试时说明原因和替代验证方式。
- 验收条件必须可判定：能落成命令或断言，不依赖“看起来没问题”。

## Rust 专项规范

### 模块与依赖边界

- 一个类型或组件一个模块文件；模块目录与 mod 声明一致，不把多个无关类型塞进一个文件。
- bin 与 lib 分离；纯逻辑与 IO 分层，IO 边界集中在最外层模块。
- 错误类型一个概念一个文件，与领域模型同层放置。

### 类型、数据与接口契约

- rustfmt 默认配置，不局部改写；没有调用方的项不 pub，保持私有。
- `unsafe` 块必须写 `// SAFETY:` 注释说明成立前提；公开 unsafe API 写 `# Safety` 文档段。

### 状态、并发与资源生命周期

- 跨线程共享按最小范围选型 Arc/Mutex/RwLock；锁内禁止跨 await 点。
- Drop 只做资源释放，不做可能失败的外部交互；外部交互放显式 close/shutdown 方法。
- spawn 的任务有明确取消路径；JoinHandle 必须被等待、传播错误或注释写明放弃理由。

### 错误、安全与可观测性

- 库代码定义领域错误类型（项目未选型时用 thiserror）；应用层才允许 anyhow。
- 禁止 `let _ =` 与 `.ok()` 吞错；确需忽略必须注释写明理由。
- 日志遵循项目统一 logger，未配置时用 tracing；错误必须携带上下文（操作、来源、原因）。

### 测试与可判定验收

- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test` 全过；项目声明的警告策略优先。

### 反模式与替代方案

- 禁止为“泛型灵活性”提前抽象，先写具体实现，出现第二个用例再泛化。
- 非测试、非启动不变量代码禁止 unwrap/expect，改用 `?` 或显式错误分支。
- Option 已表达的可空不再叠加默认值装成功；缺失就是错误路径。

## JavaScript / TypeScript 专项规范

### 模块与依赖边界

- 一个类、组件或模块一个文件；目录按领域划分，类型定义跟随所属领域文件。
- 禁止 index.ts 大杂烩转出口；仅公共 API 入口允许统一导出。

### 类型、数据与接口契约

- TypeScript 开 strict；模块内部实现默认不导出，导出即 API。
- 禁止 any；外部未知数据用 unknown 加类型收窄。
- `@ts-expect-error` 必须写原因与移除条件；禁止无解释的 `@ts-ignore`。

### 状态、并发与资源生命周期

- Promise 错误必须处理或显式上抛；禁止无人 await 的孤儿 Promise。
- 订阅、定时器、事件监听在所属作用域结束时清理；进程级句柄显式关闭。
- 异步竞态用取消标记或 AbortController 收敛，禁止靠时序碰运气。

### 错误、安全与可观测性

- 自定义 Error 子类携带上下文；catch 后禁止返回默认值装成功。
- 日志统一走 logger，禁止裸 console（一次性脚本除外）。

### 测试与可判定验收

- 类型检查、单测全过。

### 反模式与替代方案

- 禁止 `?.` 链式防御替代真实判空责任，改为显式收窄。
- 禁止 as 断言绕过类型检查，用收窄或修正类型定义。
- 禁止为兼容两种形态扩散联合类型，先统一输入。

## React 专项规范

### 模块与依赖边界

- 一个组件一个文件，文件名与组件名一致（PascalCase）。
- 组件、hooks、工具分目录；页面组件与可复用 UI 组件分层，不互相引用错层。

### 类型、数据与接口契约

- 函数组件 + Hooks；props 显式类型声明。
- useMemo、useCallback 仅在实测有需要时添加，不预防性包裹。
- Effect 依赖数组的非显然取舍（刻意省略、ref 逃逸）必须注释写明理由。

### 状态、并发与资源生命周期

- 状态归属唯一所有者；禁止 useState 存可由 props 或已有状态推导的值。
- Effect 里的订阅、定时器、异步任务在清理函数中取消，禁止卸载后 setState。
- 异步结果按请求时序或取消标记收敛，禁止旧响应覆盖新请求。

### 错误、安全与可观测性

- 数据获取失败必须落到 UI 状态（错误边界或错误态渲染），禁止静默渲染空内容。
- Effect 内的异步错误必须处理，禁止浮空 rejection。

### 测试与可判定验收

- 行为变化配套组件测试或 E2E。

### 反模式与替代方案

- Effect 只做同步外部系统的事，事件逻辑写在事件处理里。
- props 透传超过两层就提 context 或重组组件，不硬穿。

## Tauri 2 专项规范

### 模块与依赖边界

- 前端与 Rust 侧各自遵循自身栈规范；IPC 命令一个领域一个模块文件。

### 类型、数据与接口契约

- 命令参数与返回值用显式类型（serde 序列化），禁止裸 JSON 透传。
- IPC 命令名用 camelCase（Rust 侧 snake_case 由框架映射），一个命令只做一件事。
- IPC 结构变更视为破坏性契约变化，两侧同步修改。

### 状态、并发与资源生命周期

- 长任务用事件流报告进度并支持取消，禁止命令内闷跑。
- 跨线程共享的 Rust 状态经框架托管（State），禁止裸全局变量。
- 窗口、托盘、监听器等资源在关闭路径显式释放，前端卸载时注销监听。

### 错误、安全与可观测性

- Rust 侧错误必须序列化传给前端并可见，禁止静默；前端对 invoke 的 rejection 必须处理。
- 两侧各自统一 logger；关键操作日志可对照定位。
- IPC 权限与能力配置遵循最小授权，超出默认授权必须注释写明理由。

### 测试与可判定验收

- Rust 单测与前端测试各自全过；IPC 契约变化时两侧同步补测试。

### 反模式与替代方案

- 禁止前端长期镜像后端持有的状态，以后端为准重新拉取。

<!-- user-guidelines:end -->
