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
 */
import { subscribeStream, type StreamEvent } from '../../api/events';
import type { ActivityPhase } from '../../api/generated/bindings';

export type StreamStatus = 'streaming' | 'stopping' | 'done' | 'error';

/** 单条幕后活动轨迹（Task-07 活动条数据源）：phase + 技术摘要 + 到达时刻（毫秒）。 */
export interface ActivityStep {
  readonly phase: ActivityPhase;
  readonly detail: string | null;
  readonly at: number;
}

/**
 * 取消终态的稳定 reason 标记（Rust services/generation `CANCEL_REASON`）：
 * 用户主动取消不作为失败提示展示。
 */
export const CANCEL_REASON = 'cancelled';

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
        state.activity.push({ phase: event.phase, detail: event.detail, at: Date.now() });
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
