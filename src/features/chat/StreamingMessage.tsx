/**
 * 流式消息行（TASK-006 / FR-001 / FR-003 / ADR-007）：把当前会话的流式事件接到渲染引擎。
 *
 * 职责边界：流状态与事件路由在 streamHub（跨视图存续）；本组件只负责「有挂载点时的
 * 演出」——创建引擎实例、按事件驱动（思考流式收拢 → 正文节奏吐字）、终态收尾。
 * 会话不在前台时不挂载：hub 只累积不渲染（ADR-007 允许的降级），切回时挂载并经
 * `replayInstant` 一次性回放积压，后续 token 继续走节奏队列。
 *
 * 终态语义：
 * - done：`finish()` 让队列排空定格（无直出跳进），排空后 onSettled → UI 重拉列表；
 * - error / stopping（点停止）：立即 `cancel()` 冻结（FR-001「界面立即静止」），
 *   半条以库中重拉结果替代（ADR-001 中断条）。
 */
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { useEffect, useRef } from 'react';
import type { StreamEvent } from '../../api/events';
import { createRenderer, type AnimStyleId, type Renderer, type RendererOptions } from '../../engine';
import { streamHub, type StreamState } from './streamHub';

const useStyles = makeStyles({
  row: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '4px',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  speaker: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  body: {
    width: '100%',
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    // 块内单换行随解析器保留上屏（审计问题 3）：解析器的微停规则认 \n，
    // 缺 pre-wrap 会把刻意保留的换行折叠成空格（历史行 msgBody 与 demo
    // .bubble 均有）。横向溢出不依赖 white-space 承担：长词断行由下面的
    // word-break: break-word 负责（pre-wrap 只保留空白，不断词）
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
});

/** 渲染引擎参数（角色卡风格 + 全局节奏设置，FR-005 / FR-009）；缺省项用引擎默认。 */
export interface RendererTuning {
  style?: string | undefined;
  msPerChar?: number | undefined;
  punctPause?: boolean | undefined;
  durationMs?: number | undefined;
}

interface StreamingMessageProps {
  state: StreamState;
  speaker: string;
  tuning: RendererTuning;
  /** 终态收尾（done 排空 / error 冻结 / 后台终态重挂）：UI 重拉列表并摘除流状态。 */
  onSettled: () => void;
}

type Phase = 'idle' | 'think' | 'body';

export function StreamingMessage({ state, speaker, tuning, onSettled }: StreamingMessageProps) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const settledRef = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  // 回调经 ref 转发：挂载 effect 只跑一次，仍能取到最新收尾与引擎参数
  const onSettledRef = useRef(onSettled);
  const tuningRef = useRef(tuning);
  onSettledRef.current = onSettled;
  tuningRef.current = tuning;

  useEffect(() => {
    // 后台会话已到终态后切回：无演出可放，直接收尾（重拉列表替换为库中原文）
    if (state.status === 'done' || state.status === 'error') {
      settledRef.current = true;
      onSettledRef.current();
      return undefined;
    }

    const container = containerRef.current;
    if (!container) return undefined;
    const tuningNow = tuningRef.current;
    // 引擎选项按需赋值（exactOptionalPropertyTypes：不传 undefined）
    const options: RendererOptions = {
      // renderStyle 为角色卡自由串：引擎内 isAnimStyle 校验，非法回落 fade（FR-005）
      onFinish: () => {
        if (!settledRef.current) {
          settledRef.current = true;
          onSettledRef.current();
        }
      },
    };
    if (tuningNow.style !== undefined) options.style = tuningNow.style as AnimStyleId;
    if (tuningNow.msPerChar !== undefined) options.msPerChar = tuningNow.msPerChar;
    if (tuningNow.punctPause !== undefined) options.punctPause = tuningNow.punctPause;
    if (tuningNow.durationMs !== undefined) options.durationMs = tuningNow.durationMs;
    const renderer = createRenderer(container, options);
    rendererRef.current = renderer;

    const freeze = (): void => {
      if (settledRef.current) return;
      settledRef.current = true;
      renderer.cancel(); // 停 tick / 摘胶囊 / 清队列；已上屏内容保留
      onSettledRef.current();
    };

    // 事件 → 引擎驱动（FR-003 思考流式收拢；FR-002 正文缓冲吐字；TASK-002 reset 重来）
    const drive = (event: StreamEvent): void => {
      const r = rendererRef.current;
      if (!r || settledRef.current) return;
      if (event.type === 'token' || event.type === 'reasoning') {
        if (event.reset) {
          // 重发尝试首事件：清空该回合已累积内容，从零重来
          r.cancel();
          phaseRef.current = 'idle';
        }
        if (event.type === 'reasoning') {
          if (phaseRef.current === 'idle') {
            r.thinkStreaming();
            phaseRef.current = 'think';
          }
          if (phaseRef.current === 'think') r.appendThink(event.text);
          return;
        }
        if (phaseRef.current === 'idle') {
          r.beginTurn();
          phaseRef.current = 'body';
        } else if (phaseRef.current === 'think') {
          r.finishThinking(); // 思考通道收拢 → 自动开演正文
          phaseRef.current = 'body';
        }
        r.enqueue(event.text);
        return;
      }
      if (event.type === 'done') {
        if (phaseRef.current === 'think') {
          r.finishThinking();
          phaseRef.current = 'body';
        }
        r.finish(); // 生产者完毕：队列排空定格后 onFinish → onSettled（无直出跳进）
        return;
      }
      freeze(); // error：半条已落库，立即静止
    };

    // 回放积压（事件早于挂载 / 切会话重挂）：正文直接上屏，思考走快滚追上
    if (state.content) {
      phaseRef.current = 'body';
      renderer.beginTurn();
      renderer.replayInstant(state.content);
    } else if (state.reasoning) {
      phaseRef.current = 'think';
      renderer.thinkStreaming();
      renderer.appendThink(state.reasoning);
    }

    const off = streamHub.onEvent(state.sessionId, drive);
    return () => {
      off();
      renderer.cancel();
      rendererRef.current = null;
    };
    // 挂载一次：状态经 hub 事件驱动，不随渲染重建引擎
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点停止：立即静止（终态事件随后触发冻结收尾）
  useEffect(() => {
    if (state.status === 'stopping') {
      rendererRef.current?.cancel();
    } else if (state.status === 'error') {
      if (!settledRef.current) {
        settledRef.current = true;
        rendererRef.current?.cancel();
        onSettledRef.current();
      }
    }
  }, [state.status]);

  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <Text className={styles.speaker}>{speaker}</Text>
      </div>
      <div ref={containerRef} className={styles.body} />
    </div>
  );
}
