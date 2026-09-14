// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// preferences.test.ts 的补充边界单测（独立成文件，不改动既有用例）：
// validateProvider 结构化输出、isValidHttpUrl 直测、withoutModel 越界下标、
// RHYTHM 常量、newProviderId 无 randomUUID 回退。（parseAnimBaseMs 边界组
// 随 2026-09-14 动效基准改滑杆移除：滑杆限位后不存在非法文本中间态。）
import { describe, expect, it } from 'vitest';
import type { ModelSpecDto, ProviderDto } from '../../api/types';
import {
  RHYTHM_MAX,
  RHYTHM_MIN,
  isValidHttpUrl,
  newProviderId,
  validateProvider,
  withoutModel,
} from './preferences';
/** 模型元数据夹具：id 之外取缺省（1M 上下文 / 128K 输出 / 仅文本）。 */
const spec = (id: string): ModelSpecDto => ({
  id,
  contextWindow: 1000000,
  maxOutputTokens: 128000,
  inputTypes: ['text'],
  outputTypes: ['text'],
});

const provider = (partial: Partial<ProviderDto>): ProviderDto => ({
  id: 'p1',
  name: '本地中转',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: [spec('test-model')],
  api: 'openai',
  ...partial,
});

describe('RHYTHM 常量（FR-009 值域单一来源）', () => {
  it('10–160，与滑杆限位一致', () => {
    expect(RHYTHM_MIN).toBe(10);
    expect(RHYTHM_MAX).toBe(160);
  });
});

describe('validateProvider（结构化逐项有效性，供行内标错）', () => {
  it('完整 provider 三项全过', () => {
    expect(validateProvider(provider({}))).toEqual({
      name: true,
      baseUrl: true,
      models: true,
    });
  });
  it('逐项独立判错，互不遮蔽', () => {
    expect(validateProvider(provider({ name: '  ' })).name).toBe(false);
    expect(validateProvider(provider({ name: '  ' })).baseUrl).toBe(true);
    expect(validateProvider(provider({ baseUrl: 'nope' })).baseUrl).toBe(false);
    expect(validateProvider(provider({ baseUrl: 'nope' })).models).toBe(true);
    expect(validateProvider(provider({ models: [spec('m1'), spec('   ')] })).models).toBe(false);
    expect(validateProvider(provider({ models: [] })).models).toBe(false);
  });
});

describe('isValidHttpUrl（LLM base_url 只收 http/https）', () => {
  it('合法 http(s) 放行（含 localhost 与带路径端口）', () => {
    expect(isValidHttpUrl('https://api.example.com/v1')).toBe(true);
    expect(isValidHttpUrl('http://localhost:11434')).toBe(true);
  });
  it('其他协议、无协议与任意文本拒绝', () => {
    expect(isValidHttpUrl('ftp://api.example.com')).toBe(false);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('//api.example.com')).toBe(false);
    expect(isValidHttpUrl('api.example.com')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });
});

describe('withoutModel 越界下标（防御：列表与选中都不动）', () => {
  it('下标超界时 removed 为 null，命中条件不成立、原样返回', () => {
    const p = provider({ models: [spec('m1')] });
    const r = withoutModel({ activeProviderId: 'p1', activeModel: 'm1' }, p, 5);
    // 模型已元数据化（ModelSpecDto）：按整对象比较原样返回
    expect(r.provider.models).toEqual([spec('m1')]);
    expect(r.activeModel).toBe('m1');
  });
});

describe('newProviderId 无 randomUUID 环境', () => {
  it('crypto 缺席时走时间戳回退：p- 前缀、非空且不重复', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const a = newProviderId();
      const b = newProviderId();
      expect(a).toMatch(/^p-/);
      expect(b).toMatch(/^p-/);
      expect(a).not.toBe(b);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }
  });
});
