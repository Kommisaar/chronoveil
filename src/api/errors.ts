/**
 * API 错误类型（中性模块）：`commands.ts`（Tauri 壳实现）与 `mock/backend.ts`
 * （纯浏览器实现）共用，避免 mock → commands 反向 import 形成模块环。
 *
 * `payload` 为 Rust 侧 IpcError 的结构化 wire 形态（可判别 kind，与
 * src-tauri/src/interfaces/ipc.rs 的枚举一致）。
 */
import type { IpcError } from './generated/bindings';

/** 命令错误：调用方 `catch` 后读 `payload.kind` 分型。 */
export class ApiError extends Error {
  readonly payload: IpcError;

  constructor(payload: IpcError) {
    super(ApiError.describe(payload));
    this.name = 'ApiError';
    this.payload = payload;
  }

  private static describe(e: IpcError): string {
    switch (e.kind) {
      case 'notFound':
        return `${e.entity} #${e.id} 不存在（或已软删除）`;
      case 'conflict':
      case 'storage':
      case 'config':
      case 'unavailable':
        return e.message;
    }
  }
}
