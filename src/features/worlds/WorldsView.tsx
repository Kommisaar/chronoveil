/**
 * 世界页（0017 世界卡特性）：与角色页同款的列表三态 + 卡网格 + 编辑器形态，
 * 卡面为世界卡简化版——名称 + 历法摘要两行（世界卡无海报 / 强调色 / 演出
 * 参数，不做电影海报视觉，平面信息卡即可）。
 *
 * - 新建 = 先以默认名落库再进编辑器（修改即保存，同 CharactersView 惯例，
 *   无独立 create 表单态）；
 * - 编辑器（WorldEditorDialog）为标准模态：三张分组卡（基础信息 / 世界观 /
 *   历法五选），改动经表单钩子防抖自动落库；
 * - 删除走 ConfirmDialog 确认：世界软删（ADR-009），已建会话内的世界快照
 *   （world_instances，D1 冻结语义）不受影响——文案明示该语义；
 * - 列表三态（A1 收编）：空列表时 loading / error+重试 / 空库三选一；列表
 *   在手时的重取失败保留红字 + 网格。
 */
import { Button, Text, Title1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldInput, WorldSummary } from '../../api/types';
import { createWorld, deleteWorld, listWorlds, updateWorld } from '../../api/commands';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { StateBlock } from '../../components/StateBlock';
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { WorldEditorDialog } from './WorldEditorDialog';

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
  // 世界卡平面网格：240px 起步随窗加列（比海报墙的 200px 宽——两行信息卡
  // 需要更宽的呼吸面）
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: '16px',
  },
  empty: {
    display: 'flex',
    minHeight: '240px',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 世界卡：左缘 4px 品牌色竖条（世界卡的克制识别语汇，不抢角色海报语言）+
  // 名称 / 历法摘要两行
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: tokens.spacingVerticalXS,
    padding: '16px',
    borderLeft: `4px solid ${tokens.colorBrandBackground}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  calendarLine: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  const lift = useCardLiftStyles();
  const page = usePageContainerStyles('grid');
  const { t } = useTranslation();

  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  // 列表在途标记（三态收编，同 CharactersView）：true 且列表为空时出
  // loading 占位；列表在手时的重取不换占位（网格保持）。
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 编辑目标（既有卡）：新建走「先建卡再编辑」。
  const [editor, setEditor] = useState<WorldSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorldSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

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
        setEditor(null);
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
  }, []);

  const closeEditor = useCallback(() => setEditor(null), []);

  // UI-002：卡片按 updated_at 倒序（同角色页惯例）。
  const sorted = [...worlds].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className={page}>
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <Title1 as="h1">{t('worlds.title')}</Title1>
          <div className={styles.toolbarRight}>
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
              {sorted.map((world) => (
                <button
                  key={world.id}
                  type="button"
                  className={mergeClasses(styles.card, lift.root)}
                  onClick={() => openEditor(world)}
                >
                  <Text size={400} weight="semibold">
                    {world.name}
                  </Text>
                  <span className={styles.calendarLine}>
                    {world.calendar === null ? t('worlds.calendarNone') : world.calendar.name}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {editor ? (
        <WorldEditorDialog
          key={`edit-${editor.id}`}
          world={editor}
          errorText={editorError}
          onAutosave={handleAutosave}
          onClose={closeEditor}
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
