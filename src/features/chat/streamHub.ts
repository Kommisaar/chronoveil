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
 */
import { subscribeStream, type StreamEvent } from '../../api/events';

export type StreamStatus = 'streaming' | 'stopping' | 'done' | 'error';

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
}

type StoreListener = () => void;
type EventListener = (event: StreamEvent) => void;

class StreamHub {
  private states = new Map<number, StreamState>();
  private unsubs = new Map<number, () => void>();
  private eventListeners = new Map<number, Set<EventListener>>();
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
      case 'token':
        state.messageId = event.messageId;
        if (event.reset) {
          state.content = '';
          state.reasoning = '';
        }
        state.content += event.text;
        break;
      case 'reasoning':
        state.messageId = event.messageId;
        if (event.reset) {
          state.content = '';
          state.reasoning = '';
        }
        state.reasoning += event.text;
        break;
      case 'done':
        state.status = 'done';
        break;
      case 'error':
        state.status = 'error';
        state.errorReason = event.reason;
        break;
    }
    this.notifyStore();
    const listeners = this.eventListeners.get(sessionId);
    if (listeners) {
      for (const listener of [...listeners]) listener(event);
    }
  }

  private notifyStore(): void {
    this.version += 1;
    for (const listener of [...this.storeListeners]) listener();
  }
}

/** 应用级单例：流状态跨视图切换存续（切走不取消，FR-007）。 */
export const streamHub = new StreamHub();
