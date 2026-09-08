/** 前端依赖守卫（ADR-010）：单向依赖 app → features → components/engine → api，engine 禁 React。 */
module.exports = {
  options: {
    // pnpm 的 node_modules 条目是指向 .pnpm 虚拟 store 的 junction/symlink：
    // 保留 symlink 逻辑路径（node_modules/@tauri-apps/...）做规则匹配，
    // 否则 realpath 会让规则看到 node_modules/.pnpm/... 而误报。
    preserveSymlinks: true,
  },
  forbidden: [
    {
      name: 'engine-no-framework',
      comment: 'ADR-010：渲染引擎是纯 TS + DOM + CSS 层（CMP-001），禁 React / Fluent，保证可脱离 UI 用 vitest 测试。',
      severity: 'error',
      from: { path: '^src/engine' },
      to: { path: 'node_modules/(react|react-dom|@fluentui)' },
    },
    {
      name: 'no-app-from-lower',
      comment: 'ADR-010：依赖单向 app → features → components/engine → api，下层不得反向引用应用壳。',
      severity: 'error',
      from: { path: '^src/(features|components|engine|api)/' },
      to: { path: '^src/app' },
    },
    {
      name: 'features-isolated',
      comment: 'ADR-010：feature 之间禁止互相引用，跨域复用下沉 components / engine / api；同 feature 内部互引允许（TASK-006 起 chat 拆多文件，修复本规则从未生效的同 feature 误报：dependency-cruiser 的组占位符语法是 $1，原 \\k<feature> 不被替换导致 pathNot 永不命中——跨 feature 禁令不受影响，为语义修正而非放松）。',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/', pathNot: '^src/features/$1/' },
    },
    {
      name: 'api-no-upper',
      comment: 'ADR-010：api 是最底层的数据入口，不得引用 features / app。',
      severity: 'error',
      from: { path: '^src/api/' },
      to: { path: '^src/(features|app)' },
    },
    {
      name: 'tauri-only-in-api',
      comment: 'ADR-010：invoke 与 @tauri-apps/api 只允许出现在 src/api/（from 侧只盯第一方 src/，@tauri-apps 包自身内部引用不在第一方范围内）。',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/api/' },
      to: { path: 'node_modules/@tauri-apps' },
    },
  ],
};
