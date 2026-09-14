// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// 动效 token 守卫（2026-09-13 M1 token 收敛）。三类断言：
// 1. token 值锁存：曲线镜像 @fluentui/tokens 同名全局 token（同构声明
//    附逐值对照，motion.ts 注释与断言互证）；
// 2. 全仓扫描：src 内动画/过渡的时长与曲线字面量只允许出现在
//    motion.ts（TS 单一事实源）与 app.css :root 的 --cv-* 变量区
//    （CSS 引不到 TS 的互指镜像），范围外遗留豁免按文件+次数锁死，
//    新增即挂；
// 3. CSS↔TS parity：app.css 的 --cv-* 变量与 motion.ts 对应常量
//    归一化相等（注释只是线索，测试才是硬约束）。
// engine/** 不扫描：渲染引擎是独立动画系统（engine.css 自带 token，
// 本任务只读对照，收敛走 engine 自己的议题）。
// 源码经 import.meta.glob 裸文本加载（eager + ?raw）：TS 侧不引 node:fs；
// app.css 因 vitest css:false 门控取不到 ?raw 内容，单独经 node:fs 读取
//（类型面见 motion.test-env.d.ts）。
import { readFileSync } from 'node:fs';
import { webLightTheme } from '@fluentui/react-components';
import { describe, expect, it } from 'vitest';
import {
  ACCELERATE_CURVE,
  CROSSFADE_MS,
  DECELERATE_CURVE,
  DROPDOWN_POP_MS,
  EDITOR_BACKDROP_IN_MS,
  EDITOR_BODY_IN_DELAY_MS,
  EDITOR_BODY_IN_MS,
  EDITOR_BODY_OUT_MS,
  EDITOR_FADE_MS,
  ENTER_STAGGER_CAP_MS,
  ENTER_STAGGER_MS,
  INDICATOR_MOVE_MS,
  MORPH_OUT_MS,
  POP_IN_MS,
  SPRING_CURVE,
} from './motion';

/** src 全部 TS/TSX 源码（含测试，扫描前按规则过滤）→ 相对 src/ 的路径。 */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('/src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([key, content]) => [key.replace(/^\/src\//, ''), content]),
);

/** app.css 原文（vitest 对 CSS 的 ?raw 一律给空串，必须走文件系统）。 */
const APP_CSS = readFileSync(`${process.cwd()}/src/app/app.css`, 'utf8');

/** 去空白归一化：CSS 值书写风格（空格）不参与等值判断。 */
function normalize(value: string): string {
  return value.replace(/\s+/g, '');
}

describe('动效 token 值锁存（对照表随提交走，改动必须显式过审）', () => {
  it('曲线镜像 @fluentui/tokens 全局 token（逐值对照；曲线是主题无关静态值，取 light 主题为源）', () => {
    expect(normalize(DECELERATE_CURVE)).toBe(normalize(webLightTheme.curveDecelerateMid));
    expect(normalize(ACCELERATE_CURVE)).toBe(normalize(webLightTheme.curveAccelerateMid));
  });

  it('弹簧曲线与时长档取收敛后的共识值（400 归并 + 编辑器淡化编排原值）', () => {
    expect(SPRING_CURVE).toBe('cubic-bezier(0.34, 1.56, 0.64, 1)');
    expect(POP_IN_MS).toBe(400); // 原 card-enter-pop 480 / palette-pop-in 400 / FLIP 400 归并
    expect(MORPH_OUT_MS).toBe(200);
    expect(EDITOR_FADE_MS).toBe(200);
    expect(EDITOR_BACKDROP_IN_MS).toBe(280);
    expect(CROSSFADE_MS).toBe(200); // 思考两态收尾过渡档（M4，单侧消费见 motion.ts 注释）
    expect(EDITOR_BODY_IN_MS).toBe(160);
    expect(EDITOR_BODY_IN_DELAY_MS).toBe(90);
    expect(EDITOR_BODY_OUT_MS).toBe(70);
    expect(INDICATOR_MOVE_MS).toBe(400);
    expect(DROPDOWN_POP_MS).toBe(150); // 下拉推钮开合档（小浮层跟手档）
    expect(ENTER_STAGGER_MS).toBe(24); // 原 sidebar 16 / 海报墙 60 统一
    expect(ENTER_STAGGER_CAP_MS).toBe(360); // 原 sidebar 240 / 海报墙无封顶 统一
  });
});

describe('清单浮现错峰单源（M2）', () => {
  const SIDEBAR = SOURCES['app/layout/Sidebar.tsx'] ?? '';
  const REVEAL = SOURCES['components/useRevealOnScroll.ts'] ?? '';

  it('两处消费方源码均在扫描集内（路径漂移时守卫先行失明报警）', () => {
    expect(SIDEBAR).not.toBe('');
    expect(REVEAL).not.toBe('');
  });

  it('均从 motion.ts 导入错峰档，无本地重复声明（防回潮）', () => {
    const noLocalDecl = (source: string): boolean =>
      !/(?:const|let)\s+(?:ENTER_STAGGER_MS|ENTER_STAGGER_CAP_MS|BATCH_STEP_MS)\b/.test(source);
    expect(noLocalDecl(SIDEBAR), 'Sidebar 不得本地声明 stagger 常量').toBe(true);
    expect(noLocalDecl(REVEAL), 'useRevealOnScroll 不得本地声明 stagger 常量').toBe(true);

    expect(
      SIDEBAR,
      'Sidebar 应从 components/motion 导入 ENTER_STAGGER_MS',
    ).toMatch(/import\s*\{[^}]*ENTER_STAGGER_MS[^}]*\}\s*from\s*'\.\.\/\.\.\/components\/motion'/);
    expect(
      REVEAL,
      'useRevealOnScroll 应从 ./motion 导入 ENTER_STAGGER_MS',
    ).toMatch(/import\s*\{[^}]*ENTER_STAGGER_MS[^}]*\}\s*from\s*'\.\/motion'/);
  });
});

// —— 全仓扫描 ——

/** 动画/过渡时长字面量（Griffel 属性、WAAPI options、CSS 简写串）。 */
const DURATION_PATTERNS = [
  /(?:animation(?:Duration|Delay)|transition(?:Duration|Delay)):\s*['"`]\s*\d[^'"`]*['"`]/g,
  /[^-a-zA-Z]duration:\s*\d/g, // WAAPI { duration: 400 }
  /(?:animation|transition)\s*:\s*['"`][^'"`]*\d/g, // 简写字符串 'transform 200ms …'
] as const;
const CURVE_PATTERN = /cubic-bezier\(/g;

/** 范围外遗留豁免（本任务禁止修改的文件，按文件锁死既有命中数：
    数量不符 = 有新增字面量，守卫必须挂）。 */
const KNOWN_OUT_OF_SCOPE: Record<string, number> = {
  // reduce 急停值（0.01ms kill-switch，带 reduce 门控，收敛归布局侧议题）
  'app/layout/ActivityBar.tsx': 1,
  // 「正在回忆…」脉动 1.4s（带 reduce 门控的独立节奏，非共享语言）
  'features/chat/ActivityBar.tsx': 1,
};

interface Hit {
  line: number;
  text: string;
}

function collectHits(content: string, patterns: readonly RegExp[]): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(re)) {
      const line = content.slice(0, match.index ?? 0).split('\n').length;
      hits.push({ line, text: match[0] });
    }
  }
  return hits;
}

describe('全仓动效字面量守卫', () => {
  it('src 内动画时长/曲线字面量仅存在于 motion.ts 与 app.css :root 变量区', () => {
    const violations: Array<Hit & { file: string }> = [];

    // —— TS/TSX（glob 裸文本）——
    for (const [rel, content] of Object.entries(SOURCES)) {
      if (rel.startsWith('engine/') || /\.test\.(ts|tsx)$/.test(rel)) continue;
      if (rel === 'components/motion.ts') continue; // TS 单一事实源

      const hits = collectHits(content, [...DURATION_PATTERNS, CURVE_PATTERN]).map((h) => ({
        file: rel,
        ...h,
      }));
      const allowed = KNOWN_OUT_OF_SCOPE[rel];
      if (allowed !== undefined) {
        // 豁免文件锁死数量与内容，防止未来偷偷加字面量
        expect(hits, `豁免文件 ${rel} 的字面量数量发生变化`).toHaveLength(allowed);
      } else {
        violations.push(...hits);
      }
    }

    // —— app.css（文件系统原文）：唯一合法处是 :root 的 --cv-* 变量区，
    //    块内放行，块外禁字面量 ——
    const rootBlocks = APP_CSS.match(/:root\s*\{[^}]*\}/g) ?? [];
    const cssOutsideRoot = rootBlocks.reduce((acc, block) => acc.replace(block, ''), APP_CSS);
    violations.push(
      ...collectHits(cssOutsideRoot, [...DURATION_PATTERNS, CURVE_PATTERN]).map((h) => ({
        file: 'app/app.css',
        ...h,
      })),
    );

    expect(
      violations,
      `发现未收敛的动效字面量（应改用 motion.ts token 或 app.css --cv-* 变量）：\n${violations
        .map((v) => `${v.file}:${v.line} ${v.text}`)
        .join('\n')}`,
    ).toHaveLength(0);
  });

  it('app.css :root 的 --cv-* 变量与 motion.ts 常量 parity', () => {
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(APP_CSS)?.[1] ?? '';
    expect(rootBlock).not.toBe('');

    const readVar = (name: string): string => {
      const value = new RegExp(`--cv-${name}\\s*:\\s*([^;]+);`).exec(rootBlock)?.[1]?.trim();
      expect(value, `app.css :root 缺少 --cv-${name} 定义`).toBeTruthy();
      return value ?? '';
    };

    expect(normalize(readVar('spring-curve'))).toBe(normalize(SPRING_CURVE));
    expect(readVar('pop-in-ms')).toBe(`${POP_IN_MS}ms`);
    expect(readVar('dropdown-pop-ms')).toBe(`${DROPDOWN_POP_MS}ms`);
    // 页面渐入档仅 CSS 消费，无 TS 对应常量，只锁存在与取值
    expect(readVar('page-enter-ms')).toBe('400ms');
  });
});
