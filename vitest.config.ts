import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 依赖预打包清单：两个 project 都要引用（project 不继承顶层 test.deps，
// 漏配会退回逐模块执行 Fluent 依赖树，collect 累计从 ~115s 暴涨回 ~1700s）。
const depsOptimizer = {
  optimizer: {
    web: {
      enabled: true,
      include: [
        '@fluentui/react-components',
        '@fluentui/react-icons',
        'react-dom',
        'react-dom/client',
        'react-i18next',
        'i18next',
        'zustand',
        '@testing-library/react',
        '@testing-library/dom',
      ],
    },
  },
} as const;

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // 多 worktree 并行开发场景（2026-09-13 定值 6）：本机 22 核，默认全核
    // (~21 worker) 全量墙钟 48.5s / 累计 CPU ~770s；6 worker 墙钟 52s
    // （+7% 几乎无损）而累计 CPU ~259s（-66%）——isolate:false 分组后
    // 每 worker 的一次性成本（jsdom + 依赖树）不再随 worker 数重复放大，
    // 6 路已接近 tests 真执行/6 的并行下限，更多 worker 只是重复一次性
    // 成本。多个 worktree 同时跑测试时（3×6=18 进程）22 核内不争抢。
    // 单跑求极速可 CLI 覆盖：pnpm vitest run --maxWorkers=21。
    maxWorkers: 6,
    // projects 分两组（2026-09-13）。注意：project 不继承顶层 test 的
    // environment/deps 等，必须逐 project 显式写（漏写 environment 会
    // 静默回落 node 环境、漏写 deps 会让 collect 暴涨回 ~1700s）。
    // projects 分两组（2026-09-13）：
    // - isolated-styles：8 个含「遍历 document.styleSheets 找 cssRules」断言
    //   的文件，依赖每文件干净的 document，必须 isolate（默认 true）。
    //   新增此类断言的测试必须加进本组 include，否则在 shared 组串扰失败。
    // - shared：其余 49 个文件 isolate: false——同一 worker 内 jsdom 环境
    //   与 Fluent 依赖树只建一次，跨文件复用；RTL 每用例自动 cleanup
    //   （vitest globals 未开、RTL 不自动 cleanup），DOM 累积风险由实测
    //   兜底：49 文件多轮全量全过；新增测试若受前序文件 DOM 残留影响，
    //   在该文件自行 afterEach(cleanup)。isolate:false 全量曾实测 64 失败、
    //   全部落在这 8 个样式扫描文件，分组后其余文件不受影响。
    projects: [
      {
        test: {
          name: 'isolated-styles',
          environment: 'jsdom',
          include: [
            'src/components/useCardLiftStyles.test.tsx',
            'src/components/useGhostIconButtonStyles.test.tsx',
            'src/app/layout/useSidebarStyles.test.tsx',
            'src/features/characters/editor/pieces.motion.test.tsx',
            'src/features/chat/useChatViewStyles.test.tsx',
            'src/features/chat/ChatView.history.test.tsx',
            'src/features/chat/ledgerPanel.test.tsx',
            'src/features/chat/StreamingMessage.test.tsx',
          ],
          isolate: true,
          deps: depsOptimizer,
        },
      },
      {
        test: {
          name: 'shared',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'src/components/useCardLiftStyles.test.tsx',
            'src/components/useGhostIconButtonStyles.test.tsx',
            'src/app/layout/useSidebarStyles.test.tsx',
            'src/features/characters/editor/pieces.motion.test.tsx',
            'src/features/chat/useChatViewStyles.test.tsx',
            'src/features/chat/ChatView.history.test.tsx',
            'src/features/chat/ledgerPanel.test.tsx',
            'src/features/chat/StreamingMessage.test.tsx',
          ],
          isolate: false,
          deps: depsOptimizer,
        },
      },
    ],
    // 测试提速记录（2026-09-13，两轮）：起点全量 142s（累计 CPU ~770s），
    // 真测试仅 ~100s；大头是 collect ~1771s（isolate 下每个组件测试文件
    // 在干净 worker 里逐模块重新执行 Fluent/griffel 依赖树）与
    // environment ~594s（jsdom 环境重建）。终态：全量 ~52s / 累计 CPU
    // ~259s（6 worker 口径），571 用例全过。
    // - 已采纳：deps.optimizer.web 预打包重依赖（含 @testing-library）——
    //   collect 1771s → ~115s，单此一项全量墙钟 142s → ~49s。首次跑含
    //   esbuild 预打包成本（数秒，缓存于 node_modules/.vitest），此后
    //   稳态命中。
    // - 已采纳：projects 分组 isolate（见上）——shared 组 49 文件共享
    //   worker 环境与模块图，8 个样式扫描文件保持每文件隔离。
    // - 已采纳：maxWorkers: 6（见上）。
    // - happy-dom 替换 shared 组环境曾试跑：10 失败——matchMedia 缺省
    //   前提（useResolvedTheme 测试名即「本项目 jsdom 缺省」）、CSS
    //   变量/computedStyle 归一化（engine/theme）、对话框与滚动吸底
    //   交互差异；且 environment 仅 444s → 281s，收益不抵改断言的失真，
    //   弃用并移除依赖。
    // - isolate: false 无分组曾试跑：64 失败，全是 Griffel 全局样式表扫描
    //   断言在共享 worker 下跨文件串扰——分组采纳后此路径不再需要，
    //   仅当新增样式扫描断言文件时同步登记 isolated-styles 组。
    // - maxWorkers: '50%' 曾试跑（isolate:true 时代）：全量 277s，反而比
    //   默认全核 152s 慢——彼时每文件隔离、单跑速度损失大于并行争抢
    //   收益；isolate:false 分组后此权衡反转（6 worker 见上），历史数据
    //   仅存档。负载 flake 由「失败即隔离复跑确认」惯例处置
    //   （CharactersView 已有 20s 时距预算）。
    // - 已采纳（早前）：纯逻辑测试（15 个 .ts 文件）经文件头
    //   // @vitest-environment node 跳过 jsdom 创建；events.test.ts 依赖
    //   window mock Tauri，保持 jsdom。
  },
});
