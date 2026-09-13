import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // 测试提速记录（2026-09-13）：全量 152s 中真测试仅 ~100s（累计口径），
    // 大头是 jsdom 环境重建（environment ~937s 累计）与 Fluent 依赖树重复
    // 转换（collect ~1761s 累计）。
    // - isolate: false 曾试跑：64 失败，全是 Griffel 全局样式表扫描断言在
    //   共享 worker 下跨文件串扰（useGhostIconButtonStyles.test 等）——样式
    //   表断言依赖隔离的全局 CSS 环境，isolate 必须保持 true（默认）。
    //   移除条件：样式表扫描类测试改造为可污染安全的形式后可重试。
    // - maxWorkers: '50%' 曾试跑：全量 277s，反而比默认全核 152s 慢——单跑
    //   速度损失大于多任务并行争抢的收益，不采纳；负载 flake 由「失败即隔离
    //   复跑确认」惯例处置（CharactersView 已有 20s 时距预算）。
    // - 已采纳：纯逻辑测试（15 个 .ts 文件）经文件头 // @vitest-environment
    //   node 跳过 jsdom 创建；events.test.ts 依赖 window mock Tauri，
    //   保持 jsdom。
  },
});
