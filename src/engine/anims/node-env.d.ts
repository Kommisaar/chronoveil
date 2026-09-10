/**
 * 测试专用最小 node 环境声明（TASK-06）：tsconfig 的 types 仅含 vite/client，
 * 仓库不装 @types/node；anims 元数据一致性测试需要 node:fs 读取 engine.css 原文。
 * 运行时由 vitest 的 node 环境提供真实实现，此处仅为通过 tsc 严格门禁。
 * 依赖 pnpm test / pnpm run build 均以仓库根为 cwd。
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
}

declare module 'node:path' {
  export function resolve(...segments: string[]): string;
}

declare const process: {
  cwd(): string;
};
