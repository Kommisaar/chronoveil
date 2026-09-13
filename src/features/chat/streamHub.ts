/**
 * 流式生成路由中枢（TASK-006 / FR-007 / ADR-007 / INT-001）。
 *
 * 模块级单例，生命周期独立于 ChatView 挂载：每个活跃生成的会话一条路由订阅
 * （`subscribeStream` 已按 session_id 过滤，INT-001 验证规则），事件在此累积为
 * 每会话独立的流状态（content / reasoning / message_id / status）——多路并发生成
 * 互不串扰；切走会话不取消生成，回到该会话时由挂载的渲染组件回放积压。
 *
 * 状态机：
 * - `streaming`：生成进行中（token / reasoning 到达即累积）；
 * - `stopping`：用户点停止后的本地静止态（渲染端立即冻结引擎，等待取消终态事件）；
 * - `done` / `error`：终态（Rust 侧已落库，ADR-001），UI 收尾（重拉列表）后 `end()`。
 *
 * 幕后活动轨迹（Task-06/07）：activity 事件在 token / reasoning 之前按到达顺序
 * 追加进 `activity`，供活动条渲染；首个 token / reasoning 置 `activityYielded`
 * （让位标记，reset 不回退）；终态事件清空轨迹（回看入口随流式行收尾消失）。
 *
 * 调用轨迹通道（账本「调用轨迹」段）：LLM 调用记录（LlmCall）**不走 StreamEvent
 * 联合**——架构决定——理由：
 * 1. StreamEvent 是渲染组件共享的联合类型，StreamingMessage 的 drive() 以 `never`
 *    穷尽断言强制每个变体显式表态；trace 是账本数据、不是流式演出事件，塞进联合
 *    会强迫渲染路径为它做一次无意义的「忽略」决定（且该文件不在面板切片范围）；
 * 2. 消费面是账本面板（与 onTerminal 同款的全局订阅 + 自行按会话过滤），与按会话
 *    路由的流式事件语义不同。
 * 故 api 侧契约修正为独立订阅函数 `subscribeTraces(cb)`（由后端并行分支落在
 * api/events，wire 侧用独立事件通道，不进 StreamEvent / fromWireEvent 返回联合）；
 * 本模块初始化时把桥接登记为 `subscribeTraces(ingestTrace)`——api 未落地前该绑定
 * 缺失，可选调用静默跳过（运行时探测），落地后自动接线，本文件无需再改。
 */
import { subscribeStream, type StreamEvent } from '../../api/events';
import * as eventsModule from '../../api/events';
import type { ActivityPhase, LlmCallKindDto } from '../../api/generated/bindings';

export type StreamStatus = 'streaming' | 'stopping' | 'done' | 'error';

/** 单条幕后活动轨迹（Task-07 活动条数据源）：phase + 技术摘要（呈现层无时间维度）。 */
export interface ActivityStep {
  readonly phase: ActivityPhase;
  readonly detail: string | null;
}

/**
 * 取消终态的稳定 reason 标记（Rust services/generation `CANCEL_REASON`）：
 * 用户主动取消不作为失败提示展示。
 */
export const CANCEL_REASON = 'cancelled';

/**
 * LLM 调用轨迹单条（与生成端 LlmCallDto 逐字段结构对齐；kind 直接引用
 * LlmCallKindDto 同源——生成端契约变更时此处编译期暴露）。promptJson /
 * toolCallsJson 是 JSON 字符串（大字段：仅展开详情时 parse，列表行不碰）；
 * id 是幂等更新键；sessionId 为 null 表示无会话归属的调用（仅历史起草调用
 * 遗留形态——2026-09-13 裁撤，现行写入方恒有会话，防御性保留）。
 */
export interface LlmCall {
  readonly id: number;
  readonly sessionId: number | null;
  readonly kind: LlmCallKindDto;
  readonly model: string;
  /** 开始时刻（epoch ms） */
  readonly startedAt: number;
  readonly durationMs: number;
  /** JSON：[{role: 'system'|'user'|'assistant'|'tool', content: string}] */
  readonly promptJson: string;
  readonly responseText: string | null;
  readonly reasoningText: string | null;
  /** JSON：[{name: string, arguments: string}] */
  readonly toolCallsJson: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly status: 'ok' | 'error';
  readonly errorText: string | null;
}

/** 调用轨迹监听者（从众 onTerminal）：任一会话产生调用记录即回调，消费方自行按 sessionId 过滤。 */
type TraceListener = (call: LlmCall) => void;

export interface StreamState {
  readonly sessionId: number;
  /** 流式事件携带的临时 message_id（负数，终态后以重拉列表的真实行替代） */
  messageId: number | null;
  /** 已累积正文（markdown-lite 原文） */
  content: string;
  /** 已累积思考（reasoning 原文） */
  reasoning: string;
  status: StreamStatus;
  /** error 终态原因；用户取消为稳定标记 'cancelled' */
  errorReason: string | null;
  /** 幕后活动轨迹（Task-06/07）：activity 事件按到达顺序累积；done / error 终态清空。 */
  activity: ActivityStep[];
  /**
   * 正文已开始（收到过 token / reasoning）：活动条让位标记。reset 重发不回退——
   * 探索只在回合开头跑一次，重试不应让「正在回忆…」重现。
   */
  activityYielded: boolean;
}

type StoreListener = () => void;
type EventListener = (event: StreamEvent) => void;
/** 终态监听者（TASK-010）：任一会话经终态事件落库时回调（含后台会话）。 */
type TerminalListener = (sessionId: number) => void;

class StreamHub {
  private states = new Map<number, StreamState>();
  private unsubs = new Map<number, () => void>();
  private eventListeners = new Map<number, Set<EventListener>>();
  private terminalListeners = new Set<TerminalListener>();
  private traceListeners = new Set<TraceListener>();
  private storeListeners = new Set<StoreListener>();
  private version = 0;

  /** 开始（或重新开始）一个会话的流式跟踪：登记路由订阅、重置流状态。 */
  begin(sessionId: number): void {
    if (!this.unsubs.has(sessionId)) {
      this.unsubs.set(sessionId, subscribeStream(sessionId, (event) => this.handle(sessionId, event)));
    }
    this.states.set(sessionId, {
      sessionId,
      messageId: null,
      content: '',
      reasoning: '',
      status: 'streaming',
      errorReason: null,
      activity: [],
      activityYielded: false,
    });
    this.notifyStore();
  }

  /** 用户点停止：本地立即静止（status → stopping，渲染端据此冻结引擎），等取消终态。 */
  markStopping(sessionId: number): void {
    const state = this.states.get(sessionId);
    if (state && state.status === 'streaming') {
      state.status = 'stopping';
      this.notifyStore();
    }
  }

  /** 终态收尾：摘路由订阅、删流状态（重拉列表完成后由 UI 调用）。 */
  end(sessionId: number): void {
    const unsub = this.unsubs.get(sessionId);
    if (unsub) {
      unsub();
      this.unsubs.delete(sessionId);
    }
    this.eventListeners.delete(sessionId);
    if (this.states.delete(sessionId)) this.notifyStore();
  }

  stateOf(sessionId: number | null): StreamState | null {
    if (sessionId === null) return null;
    return this.states.get(sessionId) ?? null;
  }

  /** 渲染组件订阅该会话的原始事件流（引擎驱动）；返回取消函数。 */
  onEvent(sessionId: number, listener: EventListener): () => void {
    let set = this.eventListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.eventListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /**
   * 订阅终态时点（TASK-010 / FR-007「每条新消息刷新」）：任一会话收到
   * done / error 事件（Rust 侧已落库，含切走后的后台会话）即回调，事件级
   * 触发（非每 token）；end() 不触发。返回取消函数。
   */
  onTerminal(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  /**
   * 订阅调用轨迹通道（账本「调用轨迹」段，独立于 StreamEvent——见文件头架构
   * 决定）：任一会话的调用记录到达即回调（含后台会话），消费方按 sessionId
   * 过滤。返回取消函数（面板关闭即摘除）。
   */
  onTrace(listener: TraceListener): () => void {
    this.traceListeners.add(listener);
    return () => {
      this.traceListeners.delete(listener);
    };
  }

  /** 轨迹摄入（api 桥接的登记点，也是测试注入面）：广播给全部监听者。 */
  ingestTrace = (call: LlmCall): void => {
    for (const listener of [...this.traceListeners]) listener(call);
  };

  /** useSyncExternalStore 订阅面。 */
  subscribe = (listener: StoreListener): (() => void) => {
    this.storeListeners.add(listener);
    return () => {
      this.storeListeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private handle(sessionId: number, event: StreamEvent): void {
    const state = this.states.get(sessionId);
    if (!state) return; // end() 之后的迟到事件（重试尾巴等）：忽略
    switch (event.type) {
      case 'activity':
        // 只追加轨迹：不动 messageId 与状态机（活动事件先于正文，非流式语义）
        state.activity.push({ phase: event.phase, detail: event.detail });
        break;
      case 'token':
        state.messageId = event.messageId;
        state.activityYielded = true; // 正文开始：活动条让位
        if (event.reset) {
          state.content = '';
          state.reasoning = '';
        }
        state.content += event.text;
        break;
      case 'reasoning':
        state.messageId = event.messageId;
        state.activityYielded = true;
        if (event.reset) {
          state.content = '';
          state.reasoning = '';
        }
        state.reasoning += event.text;
        break;
      case 'done':
        state.status = 'done';
        state.activity = []; // 终态清空：回看入口随流式行收尾消失
        this.notifyTerminal(sessionId);
        break;
      case 'error':
        state.status = 'error';
        state.errorReason = event.reason;
        state.activity = [];
        this.notifyTerminal(sessionId);
        break;
    }
    this.notifyStore();
    const listeners = this.eventListeners.get(sessionId);
    if (listeners) {
      for (const listener of [...listeners]) listener(event);
    }
  }

  private notifyTerminal(sessionId: number): void {
    for (const listener of [...this.terminalListeners]) listener(sessionId);
  }

  private notifyStore(): void {
    this.version += 1;
    for (const listener of [...this.storeListeners]) listener();
  }
}

/** 应用级单例：流状态跨视图切换存续（切走不取消，FR-007）。 */
export const streamHub = new StreamHub();

// 调用轨迹事件桥：api 侧 subscribeTraces（独立通道，见文件头架构决定）到达的
// 调用记录整体转交给 hub 分发面。兼容性探测必须吞访问异常：单测对 api/events 的
// 工厂 mock（多个既有测试文件，不在本切片允许清单）未提供 subscribeTraces 时，
// vitest 的 mock 命名空间「访问缺失导出」会直接抛错（而非返回 undefined）；真实
// 模块该访问恒为 undefined、永不抛（ESM 命名空间只暴露既有绑定）。故 catch 仅在
// 「测试工厂缺绑定」环境生效，生产落地前后都走 `?.` 的 undefined 短路。
try {
  eventsModule.subscribeTraces?.(streamHub.ingestTrace);
} catch {
  /* 契约先行：api 侧 subscribeTraces 未落地（测试工厂 mock 未含该导出），跳过接线 */
}
