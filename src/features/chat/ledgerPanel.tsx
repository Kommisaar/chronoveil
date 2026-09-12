/**
 * 叙事账本面板（FR-012 状态面板 + 场景史 UI 的合并形态）——组装壳。
 *
 * 形态：右侧内嵌面板（聊天列的 flex 兄弟，非模态 Dialog）——账本是「边聊边查」
 * 的参照物，模态会挡住聊天流；内嵌列不抢焦点、随外层开关即时开合（ADR：
 * ChatView 侧注释）。
 *
 * 内容三段，顺序固定，渲染与段内交互各自独立成文件：
 * - 人物状态（ledgerStates.tsx）：scope 分组 `key：value` 行，expiry 不展示。
 * - 场景史（ledgerScenes.tsx）：idx 倒序，场号 + 单枚时间标签 + 地点 + summary，
 *   桥场带「展开回顾」折叠。
 * - 调用轨迹（ledgerTrace.tsx）：本会话 LLM 调用记录，倒序 + 行展开详情；
 *   轨迹走独立订阅通道、不经 StreamEvent 联合——架构决定见 streamHub 头注。
 *
 * 数据策略：挂载（打开面板）与 sessionId 变化（会话切换）时重拉场景 / 状态 /
 * 调用轨迹三个会话级列表；生成终态（streamHub.onTerminal，ADR-005 保证 done 放
 * 行前 scenes / character_state 已在库）且属于本会话时静默重拉，无需手动刷新
 * 按钮。「在场：…」行的实例名映射（present = 实例 id 数组，多角色第 1 步）从
 * ui store 会话清单的 roster 回显派生（单一数据源，TASK-007；会话清单在侧栏
 * 挂载与终态时点重拉，本面板不单独拉角色/会话全量）。调用轨迹另有实时流：
 * streamHub.onTrace 到达即头部插入（不重拉全量，同 id 幂等更新原位），面板关闭
 * 随卸载摘订阅。
 */
import { Button, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listCharacterStates, listLlmCalls, listScenes } from '../../api/commands';
import type { CharacterStateDto, SceneDto } from '../../api/types';
import { useUiStore } from '../../stores/ui';
import { streamHub, type LlmCall } from './streamHub';
import { LedgerScenesSection } from './ledgerScenes';
import { LedgerStatesSection } from './ledgerStates';
import { LedgerTraceSection } from './ledgerTrace';

const useStyles = makeStyles({
  panel: {
    width: '320px',
    flexShrink: 0,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    flexShrink: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  // 加载 / 错误态：纵向居中的一块
  stateBlock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

interface LedgerPanelProps {
  /** 当前会话（面板只展示现役会话；切换会话由父级换 prop 触发重拉）。 */
  sessionId: number;
}

export function LedgerPanel({ sessionId }: LedgerPanelProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  // 会话清单单一数据源（TASK-007）：在场实例名映射从 roster 回显派生
  const sessions = useUiStore((s) => s.sessions);
  const [scenes, setScenes] = useState<SceneDto[] | null>(null);
  const [states, setStates] = useState<CharacterStateDto[] | null>(null);
  // 调用轨迹（会话级列表）：实时增量经 onTrace 头部插入 / 原位更新，见下
  const [calls, setCalls] = useState<LlmCall[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 终态静默重拉 / 手动重试共用的时间点：bump 触发下方拉取 effect 重跑
  const [refreshTick, setRefreshTick] = useState(0);

  // 拉取：打开（挂载）、会话切换（sessionId 变化）、终态 / 重试（refreshTick）。
  // 场景 / 状态 / 调用轨迹按会话查询；三者同库同源，失败一并走错误态重试。
  // cancelled 标记防会话快切竞态：过期响应不落 state。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void Promise.all([listScenes(sessionId), listCharacterStates(sessionId), listLlmCalls(sessionId)])
      .then(([nextScenes, nextStates, nextCalls]) => {
        if (cancelled) return;
        setScenes(nextScenes);
        setStates(nextStates);
        setCalls(nextCalls);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshTick]);

  // 在场实例名映射（present = 实例 id，多角色第 1 步）：从本会话的 roster 回显
  // 派生；实例在会话创建后不变（本切片无实例增删），清单未覆盖到时回退文案兜底。
  const instanceNames = useMemo(() => {
    const roster = sessions.find((s) => s.id === sessionId)?.instances ?? [];
    return new Map(roster.map((instance) => [instance.id, instance.name]));
  }, [sessions, sessionId]);

  // 新完成消息 → 静默重拉（FR-012）：终态事件（done / error 均已落库，ADR-001）
  // 在 done 放行前 scenes / character_state 已结算在库（ADR-005），直接重拉无竞态；
  // 只认本会话的终态（后台会话的账本不归本面板管）。面板关闭即随卸载摘订阅。
  useEffect(
    () =>
      streamHub.onTerminal((terminalSessionId) => {
        if (terminalSessionId === sessionId) setRefreshTick((tick) => tick + 1);
      }),
    [sessionId],
  );

  // 调用轨迹实时流（独立订阅通道，不经 StreamEvent——架构决定见 streamHub 头注）：
  // 本会话的调用记录到达即头部插入（不重拉全量）；同 id 已存在 → 更新原位（幂等，
  // 补发 / 重发安全）；其他会话的记录忽略。初始拉取未落定（calls 为 null）时丢弃：
  // 拉取结果必然已含该记录。面板关闭随卸载摘订阅。
  useEffect(
    () =>
      streamHub.onTrace((call) => {
        if (call.sessionId !== sessionId) return;
        setCalls((prev) => {
          if (prev === null) return prev;
          const index = prev.findIndex((existing) => existing.id === call.id);
          if (index < 0) return [call, ...prev];
          const next = [...prev];
          next[index] = call;
          return next;
        });
      }),
    [sessionId],
  );

  return (
    <aside id="ledger-panel" className={styles.panel} aria-label={t('chat.ledger.title')}>
      <div className={styles.header}>
        <Text className={styles.title}>{t('chat.ledger.title')}</Text>
      </div>
      {loading ? (
        <div className={styles.stateBlock}>
          <Spinner size="tiny" />
          <Text>{t('chat.ledger.loading')}</Text>
        </div>
      ) : failed ? (
        <div className={styles.stateBlock}>
          <Text>{t('chat.ledger.loadFailed')}</Text>
          <Button size="small" onClick={() => setRefreshTick((tick) => tick + 1)}>
            {t('chat.ledger.retry')}
          </Button>
        </div>
      ) : (
        <>
          <LedgerStatesSection states={states} />
          <LedgerScenesSection scenes={scenes} instanceNames={instanceNames} />
          <LedgerTraceSection sessionId={sessionId} calls={calls} />
        </>
      )}
    </aside>
  );
}
