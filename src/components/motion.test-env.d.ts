// 动效守卫测试（motion.test.ts）的 Node 内建最小类型面：工程未声明
// @types/node（新增依赖须过依赖白名单，动效任务不扩依赖），而守卫需要
// 读取 app.css 原文做 CSS↔TS parity 断言（vitest 默认 css:false，?raw
// 取不到 CSS 内容），仅声明实际用到的 API。
// 移除条件：引入 @types/node 后删除本文件，改用官方类型。
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare var process: {
  cwd(): string;
};
