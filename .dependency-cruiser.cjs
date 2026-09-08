/** 前端依赖守卫（ADR-010）：单向依赖 app → features → components/engine → api，engine 禁 React。 */
module.exports = {
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
      comment: 'ADR-010：feature 之间禁止互相引用，跨域复用下沉 components / engine / api。',
      severity: 'error',
      from: { path: '^src/features/(?<feature>[^/]+)' },
      to: { path: '^src/features/', pathNot: '^src/features/\\k<feature>/' },
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
      comment: 'ADR-010：invoke 与 @tauri-apps/api 只允许出现在 src/api/。',
      severity: 'error',
      from: { pathNot: '^src/api/' },
      to: { path: 'node_modules/@tauri-apps' },
    },
  ],
};
