/**
 * 运行环境探测（ADR-010：invoke 与事件监听唯一入口在 src/api/）。
 * 纯浏览器开发走 mock 数据；Tauri 壳内切换到真实命令（阶段 3 接入）。
 */
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
