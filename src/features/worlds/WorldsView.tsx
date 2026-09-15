/**
 * 世界页（0017 世界卡特性）：与角色页同款的列表三态 + 卡网格 + 编辑器形态。
 * 卡面为档案卡（2026-09-15 用户定稿，单一形态）：顶部世界色粗带 + 名称 +
 * 历法·更新日期——世界卡无海报 / 强调色 / 演出参数，不做电影海报视觉。
 *
 * - 世界色（色带与历法色点）按 id 取模恒定（worldGradientOf，地志调色板
 *   与角色靛紫系拉开域别）；同世界跨处配色漂移不可接受（同角色页规则）；
 * - 悬停无位移（仅底色变化）：lift 的 translateY/scale 在宽扁信息卡上观感
 *   浮动（用户反馈），与 WorldPickGrid worldCard 同款静停；入场动画仍与
 *   角色卡同款（card-enter-pop 弹簧 + useRevealOnScroll 视口揭示错峰）；
 * - 新建 = 先以默认名落库再进编辑器（修改即保存，同 CharactersView 惯例，
 *   无独立 create 表单态）；
 * - 编辑器（WorldEditorDialog）与角色编辑器同档（2026-09-15 用户定稿升档
 *   「世界观是世界的灵魂」，旧「标准模态简单档」口径作废）：左世界色画布
 *   + 右三张分组卡（基础信息 / 世界观 / 历法五选），非模态 + 毛玻璃背板 +
 *   从档案卡 FLIP 长出，可见性与挂载分离（editorOpen 置 false 走退场动画，
 *   onClosed 才卸载）；改动经表单钩子防抖自动落库；
 * - 删除走 ConfirmDialog 确认：世界软删（ADR-009），已建会话内的世界快照
 *   （world_instances，D1 冻结语义）不受影响——文案明示该语义；
 * - 列表三态（A1 收编）：空列表时 loading / error+重试 / 空库三选一；列表
 *   在手时的重取失败保留红字 + 网格。
 * - 工具栏卡面风格切换器（三方向对比期基建）：与角色页共用全局
 *   cardDirection 档位，对比期本页无视觉分支（切换只改 store 值），拍板
 *   胜出方向后随败者裁撤。
 */
import {
  Button,
  Text,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldInput, WorldSummary } from '../../api/types';
import { createWorld, deleteWorld, listWorlds, updateWorld } from '../../api/commands';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { POP_IN_MS, SPRING_CURVE } from '../../components/motion';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StateBlock } from '../../components/StateBlock';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { useRevealOnScroll } from '../../components/useRevealOnScroll';
import { useUiStore } from '../../stores/ui';
import { WorldEditorDialog } from './WorldEditorDialog';
import { worldGradientOf } from './worldGradient';

const useStyles = makeStyles({
  content: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  toolbarRight: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
  },
  empty: {
    display: 'flex',
    minHeight: '240px',
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: '16px',
  },
  // 卡面风格切换器定宽：SegmentedControl 轨道自带 width:100%，工具栏 flex 行
  // 内不约束会撑满整行（同本文件 WorldEditorDialog.worldbookMode 先例）
  cardStyleSwitch: {
    width: '168px',
    minWidth: '0px',
  },

  // —— 档案卡：原生 button（非 Fluent Card——宽扁信息卡不需要 Card 的
  //    interactive 语义栈，裸 button + Griffel 类即测试契约「点击进编辑」） ——
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    padding: '0px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    // 原生 button 自带 user agent 字色/居中/表单字体，全部收编到主题
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
    // 悬停无位移（定稿，见文件头）：仅底色轻变，不 lift
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ':active': {
      backgroundColor: tokens.colorNeutralBackground1Pressed,
    },
  },
  band: {
    height: '6px',
    flexShrink: 0,
    borderRadius: '5px 5px 0px 0px',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '12px 16px 14px',
  },
  name: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    minWidth: 0,
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },

  // —— 入场动画（与角色卡同款；keyframes 在 app.css；reduced-motion 门控在
  //    @media 内）。揭示前占位：滚入视口前以透明等待；揭示后换动画类，
  //    backwards fill 在批内延迟期接手维持 from 态，动画止于自然态。 ——
  preReveal: {
    opacity: 0,
  },
  enterPop: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'card-enter-pop',
      // 弹簧入场档（POP_IN_MS）与曲线 SPRING_CURVE 均出自 src/components/motion.ts
      animationDuration: `${POP_IN_MS}ms`,
      animationTimingFunction: SPRING_CURVE,
      animationFillMode: 'backwards',
      animationDelay: 'var(--enter-delay, 0ms)',
    },
  },
});

/** 新建卡的默认负载：先落库再进编辑器（修改即保存），后续编辑自动保存到该卡。 */
function newWorldInput(name: string): WorldInput {
  return { name, worldbook: '', calendar: null };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function WorldsView() {
  const styles = useStyles();
  const page = usePageContainerStyles('grid');
  const { t } = useTranslation();

  // 卡面方向档位（三方向对比期基建，与角色页共用）：本任务只改 store 值，
  // 视觉分支由后续任务接入
  const cardDirection = useUiStore((s) => s.cardDirection);
  const setCardDirection = useUiStore((s) => s.setCardDirection);

  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  // 列表在途标记（三态收编，同 CharactersView）：true 且列表为空时出
  // loading 占位；列表在手时的重取不换占位（网格保持）。
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 编辑目标（既有卡）：新建走「先建卡再编辑」。
  const [editor, setEditor] = useState<WorldSummary | null>(null);
  // 可见性与挂载分离（同 CharactersView）：editorOpen=false 只触发退场
  // 动画，播完 onClosed 才真正卸载编辑器。
  const [editorOpen, setEditorOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorldSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 视口揭示（同角色页海报墙）：首屏立即成批、折叠线以下滚入才播，批内按
  // 清单浮现统一档错峰；resetKey 恒 'worlds'（无形态切换，仅列表清空重挂时重播）。
  const { reveal, register } = useRevealOnScroll(worlds.length, 'worlds');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setWorlds(await listWorlds());
      setLoadError(null);
    } catch (e) {
      setLoadError(`${t('worlds.loadFailed')}：${describeError(e)}`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 新建 = 先以默认名落库再进编辑器（修改即保存，无独立 create 表单态）。 */
  const handleNew = useCallback(async () => {
    setCreating(true);
    setEditorError(null);
    try {
      const created = await createWorld(newWorldInput(t('worlds.new')));
      await refresh();
      setEditor(created);
      setEditorOpen(true);
    } catch (e) {
      setEditorError(`${t('worlds.saveFailed')}：${describeError(e)}`);
    } finally {
      setCreating(false);
    }
  }, [refresh, t]);

  /** 修改即保存的上送出口：落库 + refresh；失败就地红字并上抛——表单钩子
   *  据此不推进已保存基线，下一拍改动自然重试。 */
  const handleAutosave = useCallback(
    async (input: WorldInput) => {
      if (!editor) return;
      setEditorError(null);
      try {
        await updateWorld(editor.id, input);
        await refresh();
      } catch (e) {
        setEditorError(`${t('worlds.saveFailed')}：${describeError(e)}`);
        throw e;
      }
    },
    [editor, refresh, t],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // 软删（ADR-009）：卡片从列表隐藏；已建会话的世界快照（world_instances，
      // D1 冻结）不受影响，聊天侧继续按快照装配。
      await deleteWorld(deleteTarget.id);
      await refresh();
      if (editor?.id === deleteTarget.id) {
        // 编辑中的卡被删：置不可见走退场动画（getTriggerRect 已查不到卡片，
        // 退化为纯淡出），onClosed 到点再真正卸载。
        setEditorOpen(false);
      }
    } catch (e) {
      setEditorError(`${t('worlds.deleteFailed')}：${describeError(e)}`);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, editor, refresh, t]);

  const openEditor = useCallback((world: WorldSummary) => {
    setEditorError(null);
    setEditor(world);
    setEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => setEditorOpen(false), []);

  /** 共享元素过渡用：当前编辑目标对应的触发元素（档案卡）矩形。
      关闭时卡片可能已被删（软删后 refresh），查不到就返回 null，对话框
      自行退化为纯淡出（同 CharactersView 形态）。 */
  const getTriggerRect = useCallback(() => {
    const el = editor
      ? document.querySelector<HTMLElement>(`[data-editor-trigger="${editor.id}"]`)
      : null;
    return el ? el.getBoundingClientRect() : null;
  }, [editor]);

  // UI-002：卡片按 updated_at 倒序（同角色页惯例）。
  const sorted = [...worlds].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className={page}>
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <Title1 as="h1">{t('worlds.title')}</Title1>
          <div className={styles.toolbarRight}>
            <SegmentedControl
              className={styles.cardStyleSwitch}
              ariaLabel={t('cardStyle.label')}
              value={cardDirection}
              // SegmentedControl 回调给宽化 string（组件按通用选项值设计），
              // 收窄回 CardDirection；不可达兜底分支按初值 gallery（选项集即三方向全集）
              onChange={(v) => setCardDirection(v === 'ledger' || v === 'stage' ? v : 'gallery')}
              options={[
                { value: 'gallery', label: t('cardStyle.gallery') },
                { value: 'ledger', label: t('cardStyle.ledger') },
                { value: 'stage', label: t('cardStyle.stage') },
              ]}
            />
            <Button appearance="primary" disabled={creating} onClick={() => void handleNew()}>
              {t('worlds.new')}
            </Button>
          </div>
        </div>
        {editorError && editor === null ? (
          <Text role="alert" className={styles.errorText}>
            {editorError}
          </Text>
        ) : null}
        {/* 列表三态：空列表时 loading / error+重试 / 空库三选一；列表在手时
            保留红字 + 网格（重取失败不清空既有内容）。 */}
        {sorted.length === 0 ? (
          loading ? (
            <div className={styles.empty}>
              <StateBlock state="loading" label={t('worlds.loading')} />
            </div>
          ) : loadError !== null ? (
            <div className={styles.empty}>
              <StateBlock
                state="error"
                label={loadError}
                onRetry={{ label: t('worlds.retry'), onClick: () => void refresh() }}
              />
            </div>
          ) : (
            <div className={styles.empty}>
              <EmptyState message={t('worlds.empty')} />
            </div>
          )
        ) : (
          <>
            {loadError ? (
              <Text role="alert" className={styles.errorText}>
                {loadError}
              </Text>
            ) : null}
            <div className={styles.grid}>
              {sorted.map((world, index) => {
                const revealDelay = reveal[index];
                return (
                  <button
                    key={world.id}
                    type="button"
                    ref={register(index)}
                    // FLIP 共享元素过渡锚点：编辑器 getTriggerRect 按世界 id
                    // 现测本卡矩形（后续图版卡继承同一属性约定）
                    data-editor-trigger={world.id}
                    className={mergeClasses(
                      styles.card,
                      revealDelay === undefined ? styles.preReveal : styles.enterPop,
                    )}
                    style={
                      revealDelay === undefined
                        ? undefined
                        : ({ '--enter-delay': `${revealDelay}ms` } as CSSProperties)
                    }
                    onClick={() => openEditor(world)}
                  >
                    {/* 世界色粗带：每世界恒定（worldGradientOf，见文件头） */}
                    <span className={styles.band} style={{ backgroundImage: worldGradientOf(world.id) }} aria-hidden />
                    <span className={styles.body}>
                      <span className={styles.name}>{world.name}</span>
                      <span className={styles.meta}>
                        {/* 历法色点：取 id+1 错位色（同角色卡 dot 先例） */}
                        <span
                          className={styles.dot}
                          style={{ backgroundImage: worldGradientOf(world.id + 1) }}
                          aria-hidden
                        />
                        {/* null 历法 → 「默认数字历」；有历法无名 → 空串 */}
                        <span>{world.calendar === null ? t('worlds.calendarNone') : world.calendar.name ?? ''}</span>
                        <span aria-hidden>·</span>
                        <span>{new Date(world.updatedAt).toLocaleDateString()}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {editor ? (
        <WorldEditorDialog
          key={`edit-${editor.id}`}
          open={editorOpen}
          world={editor}
          getTriggerRect={getTriggerRect}
          errorText={editorError}
          onAutosave={handleAutosave}
          onClose={closeEditor}
          onClosed={() => setEditor(null)}
          onDelete={setDeleteTarget}
        />
      ) : null}

      {/* 删除确认：文案明示「会话内快照不受影响」（D1 冻结语义）。 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('worlds.deleteConfirmTitle')}
        content={
          deleteTarget ? t('worlds.deleteConfirmText', { name: deleteTarget.name }) : ''
        }
        confirmLabel={t('worlds.confirmDelete')}
        cancelLabel={t('worlds.cancel')}
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
