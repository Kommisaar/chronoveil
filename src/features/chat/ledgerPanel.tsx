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
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { forkSession, listCharacterStates, listLlmCalls, listScenes } from '../../api/commands';
import type { CharacterStateDto, SceneDto } from '../../api/types';
import { StateBlock } from '../../components/StateBlock';
import { useUiStore } from '../../stores/ui';
import { streamHub, type LlmCall } from './streamHub';
import { ForkSessionDialog } from './forkSessionDialog';
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
  // StateBlock 在 flex 滚动栏内的标准包装形态（与 useSidebarStyles stateWrap
  // 是同一约束的两侧实例，注释互指）：StateBlock root 是 height:100% 的页面级
  // 垂直居中块，直接作本面板 flex 子项会参照整面板高——加上 sticky 头部后总高
  // 超出，loading / error 态下面板多余滚动且 StateBlock 底部被裁切。包装容器
  // 吃掉头部以下剩余高度，minHeight:0 允许被压缩到实际剩余高（flex 子项默认
  // min-height:auto 是溢出的直接原因）
  stateWrap: {
    flex: 1,
    minHeight: '0px',
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
});

interface LedgerPanelProps {
  /** 当前会话（面板只展示现役会话；切换会话由父级换 prop 触发重拉）。 */
  sessionId: number;
}

export function LedgerPanel({ sessionId }: LedgerPanelProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  // 会话清单单一数据源（TASK-007）：在场实例名映射从 roster 回显派生；
  // 分叉成功后的清单重拉与选中切换也走 store 单点（refreshSessions / selectSession）
  const sessions = useUiStore((s) => s.sessions);
  const refreshSessions = useUiStore((s) => s.refreshSessions);
  const selectSession = useUiStore((s) => s.selectSession);
  const [scenes, setScenes] = useState<SceneDto[] | null>(null);
  const [states, setStates] = useState<CharacterStateDto[] | null>(null);
  // 调用轨迹（会话级列表）：实时增量经 onTrace 头部插入 / 原位更新，见下
  const [calls, setCalls] = useState<LlmCall[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 终态静默重拉 / 手动重试共用的时间点：bump 触发下方拉取 effect 重跑
  const [refreshTick, setRefreshTick] = useState(0);
  // 分叉（时间线分叉，Task-44）：锚点场 + 标题输入 + 进行中标记 + 就地错误文案
  const [forkTarget, setForkTarget] = useState<SceneDto | null>(null);
  const [forkTitle, setForkTitle] = useState('');
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);

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

  // 分叉入口（Task-44）：打开对话框并预填默认标题「原标题（分叉）」——源标题
  // 为空（尚未有首条用户消息回填）时回退「新会话」占位（与侧栏条目同一回退语义）。
  const openForkDialog = (scene: SceneDto): void => {
    const source = sessions.find((s) => s.id === sessionId);
    const sourceTitle =
      source !== undefined && source.title !== '' ? source.title : t('sessions.untitled');
    setForkTitle(t('chat.ledger.forkDefaultTitle', { title: sourceTitle }));
    setForkError(null);
    setForkTarget(scene);
  };

  // 分叉执行（会话清单纪律）：forkSession → refreshSessions 单点重拉 → 选中新
  // 会话（对齐 Sidebar 新建会话后的选中路径）。失败文案就地可见，不静默、不关
  // 对话框（用户可修正重试）。
  const confirmFork = async (): Promise<void> => {
    if (forkTarget === null || forking) return;
    setForking(true);
    setForkError(null);
    try {
      const created = await forkSession(sessionId, forkTarget.idx, forkTitle.trim());
      setForkTarget(null);
      await refreshSessions();
      selectSession(created.id);
    } catch (e) {
      setForkError(`${t('chat.ledger.forkFailed')}${e instanceof Error ? `：${e.message}` : ''}`);
    } finally {
      setForking(false);
    }
  };

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
      {/* 加载 / 错误态：页面级三态由 StateBlock 统一承载（审计 A1 迁入）。
          本面板即其设计基准（StateBlock 头注）：Spinner tiny + 次级文案、
          错误文案 + 小号重试钮原样保留；差异仅承载形制——StateBlock 须经
          stateWrap 包装（吃掉头部以下剩余高）才能在本 flex 滚动栏内垂直居中
          且不撑出多余滚动（stateWrap 注释）。段内空态（三段各自的一行小字）
          不升格，见各段注释 */}
      {loading ? (
        <div className={styles.stateWrap}>
          <StateBlock state="loading" label={t('chat.ledger.loading')} />
        </div>
      ) : failed ? (
        <div className={styles.stateWrap}>
          <StateBlock
            state="error"
            label={t('chat.ledger.loadFailed')}
            onRetry={{ label: t('chat.ledger.retry'), onClick: () => setRefreshTick((tick) => tick + 1) }}
          />
        </div>
      ) : (
        <>
          <LedgerStatesSection states={states} />
          <LedgerScenesSection scenes={scenes} instanceNames={instanceNames} onFork={openForkDialog} />
          <LedgerTraceSection sessionId={sessionId} calls={calls} />
        </>
      )}

      {/* 分叉确认（Task-44）：开关 / 标题值 / 执行留本壳，展示件只管文案与输入 */}
      <ForkSessionDialog
        target={forkTarget}
        title={forkTitle}
        onTitleChange={setForkTitle}
        forking={forking}
        error={forkError}
        onCancel={() => setForkTarget(null)}
        onConfirm={() => void confirmFork()}
      />
    </aside>
  );
}
