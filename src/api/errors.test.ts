// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// ApiError（src/api/errors.ts）行为回归：mock（src/api/mock/backend.ts）与真实
// Tauri 壳（src/api/commands.ts）共用这一个错误出口，UI 直接展示其 message，
// 此前该文件无任何测试。分支文案断言全部用 toBe 精确等值（实现敏感）：
// 任一分支文案、字段拼接或加工方式被改动，对应用例立即变红——不用
// toContain / toMatch 之类宽松匹配给「文案漂移」留活口。
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import type { IpcError } from './generated/bindings';

describe('ApiError.describe 五个 kind 分支', () => {
  it('notFound：entity 与 id 按「entity #id 不存在（或已软删除）」固定形态拼接', () => {
    // 用真实 bindings 的 IpcError 形状构造：{ kind: 'notFound'; entity: string; id: number }。
    // entity 与 id 取类型可区分的值——若拼接字段互换（id 跑到前面）或分隔符
    // 改动，精确断言立刻暴露，而不是凑巧通过。
    const error = new ApiError({ kind: 'notFound', entity: 'character', id: 42 });
    expect(error.message).toBe('character #42 不存在（或已软删除）');
  });

  it('conflict：message 原样透传，不加前缀后缀', () => {
    const error = new ApiError({ kind: 'conflict', message: '会话标题已存在：晨会纪要' });
    expect(error.message).toBe('会话标题已存在：晨会纪要');
  });

  it('storage：message 原样透传，不加前缀后缀', () => {
    const error = new ApiError({ kind: 'storage', message: 'SQLite 步进失败：数据库已锁定' });
    expect(error.message).toBe('SQLite 步进失败：数据库已锁定');
  });

  it('config：message 原样透传，不加前缀后缀', () => {
    const error = new ApiError({ kind: 'config', message: 'config.json 解析失败：意外的 token' });
    expect(error.message).toBe('config.json 解析失败：意外的 token');
  });

  it('unavailable：message 原样透传，不加前缀后缀', () => {
    const error = new ApiError({ kind: 'unavailable', message: '生成能力尚未接线' });
    expect(error.message).toBe('生成能力尚未接线');
  });
});

describe('ApiError 对象契约', () => {
  // 五个 kind 各构造一例：name 由构造函数统一指定，不随 kind 变化；
  // instanceof Error 是「catch 后按 Error 处理、读 message」契约的前提。
  const allKinds: IpcError[] = [
    { kind: 'notFound', entity: 'session', id: 7 },
    { kind: 'conflict', message: '约束冲突' },
    { kind: 'storage', message: '存储故障' },
    { kind: 'config', message: '配置损坏' },
    { kind: 'unavailable', message: '能力未接线' },
  ];

  it('name 恒为 "ApiError"（不随 kind 变化），且仍是 Error 实例', () => {
    for (const payload of allKinds) {
      const error = new ApiError(payload);
      expect(error.name).toBe('ApiError');
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('payload 原样保留：读取到的就是构造时传入的那个对象', () => {
    const payload: IpcError = { kind: 'notFound', entity: 'session', id: 7 };
    const error = new ApiError(payload);
    // toBe 钉同一引用（构造函数不做拷贝/改写）；toEqual 钉内容一致，
    // 双重断言保证调用方 catch 后读 payload.kind 分型的入口不失真。
    expect(error.payload).toBe(payload);
    expect(error.payload).toEqual({ kind: 'notFound', entity: 'session', id: 7 });
    expect(error.payload.kind).toBe('notFound');
  });
});
