/**
 * 世界页（0017 世界卡特性）：与角色页同款的列表三态 + 卡网格 + 编辑器形态。
 * 卡面口径（2026-09-16 用户两步拍板定稿为单一形态）：gallery 档
 * WorldGalleryCard「典藏形卡」——按角色页典藏卡形制改造（主题面卡 + 留白
 * 图框 + 世界观摘录主角 + 底部历法/日期元信息行，同分区结构；卡高对齐
 * 角色卡、列宽 280px 更宽一档）。同日原横版「图版卡」WorldPlateCard 与
 * 对比期败者（ledger 名册行 WorldLedgerRow / stage 满幅深底卡
 * WorldFullBleedCard + 页头环境光晕）随「只保留这一版」拍板一并退役，
 * 卡面风格切换器随之拆除（对比期基建完结，store 的 cardDirection 一并
 * 移除，与角色页同形态）。
 *
 * - 世界色按 id 取模恒定（worldGradientOf，地志调色板与角色靛紫系拉开域
 *   别）；同世界跨处配色漂移不可接受（同角色页规则）；
 * - 悬停 lift（弹性上浮 + 阴影）：gallery 卡 2026-09-16 随典藏形制改造
 *   回归与角色卡同款弹性语言（原「悬停无位移」拍板针对宽扁横版卡的浮动
 *   观感，形制退役后失效）；入场动画与角色卡同款（card-enter-pop 弹簧 +
 *   useRevealOnScroll 视口揭示错峰）；
 * - 新建 = 先以默认名落库再进编辑器（修改即保存，同 CharactersView 惯例，
 *   无独立 create 表单态）；
 * - 编辑器（WorldEditorDrawer，2026-09-16 抽屉化定稿，与角色编辑器同拍）：
 *   右缘编辑抽屉（Fluent Drawer，Smoke 背板 + Esc + × + 点背板关闭内置），
 *   三张分组卡（基础信息 / 世界观 / 历法五选）；可见性与挂载分离
 *   （editorOpen 置 false 走抽屉退场，onClosed 才卸载）；edit 模式改动
 *   经表单钩子防抖自动落库；新建 = 先编辑后落库（2026-09-16 用户拍板，
 *   保存才创建进列表，见 handleNew / handleCreate）；
 * - 删除走 ConfirmDialog 确认：世界软删（ADR-009），已建会话内的世界快照
 *   （world_instances，D1 冻结语义）不受影响——文案明示该语义；
 * - 列表三态（A1 收编）：空列表时 loading / error+重试 / 空库三选一；列表
 *   在手时的重取失败保留红字 + 网格。
 */
import {
  Button,
  Text,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldInput, WorldSummary } from '../../api/types';
import { createWorld, deleteWorld, listWorlds, updateWorld } from '../../api/commands';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { StateBlock } from '../../components/StateBlock';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { useRevealOnScroll } from '../../components/useRevealOnScroll';
import { WorldEditorDrawer } from './WorldEditorDrawer';
import { WorldGalleryCard } from './WorldGalleryCard';

const useStyles = makeStyles({
  content: {
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
  // 典藏形卡网格（gallery 档定稿）：列宽 280px——2026-09-16 用户拍板
  // 「更宽一点」，比角色典藏卡网格（200px，收藏卡密度）宽一档；原横版
  // 图版卡 260px 档随形制退役。卡高不随加宽增高：图框定高对齐角色卡
  //（126px，推导见 WorldGalleryCard.frame 注释）
  galleryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
});

/** 新建草稿哨兵 id（2026-09-16 创建流程）：真实卡 id 自 1 起（SQLite 自增 +
 *  mock 种子同口径），0 不可能撞上——据此派生编辑器 create/edit 模式。 */
const DRAFT_ID = 0;

/** 新建草稿（不落库不入列，保存成功前仅存在于编辑器状态里）。 */
function newDraftWorld(): WorldSummary {
  return { id: DRAFT_ID, name: '', worldbook: '', calendar: null, updatedAt: 0 };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function WorldsView() {
  const styles = useStyles();
  const page = usePageContainerStyles('grid');
  const { t } = useTranslation();

  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  // 列表在途标记（三态收编，同 CharactersView）：true 且列表为空时出
  // loading 占位；列表在手时的重取不换占位（网格保持）。
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 编辑目标（既有卡或新建草稿）：create/edit 模式由 id === DRAFT_ID 派生。
  const [editor, setEditor] = useState<WorldSummary | null>(null);
  // 可见性与挂载分离（同 CharactersView）：editorOpen=false 只触发退场
  // 动画，播完 onClosed 才真正卸载编辑器。
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorldSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 视口揭示（同角色页典藏卡墙）：首屏立即成批、折叠线以下滚入才播，批内
  // 按清单浮现统一档错峰。resetKey 落定稿档位常量（同 CharactersView 的
  // 'collect' 先例）——本页卡面已无切换分支，常量仅为满足契约。
  const { reveal, register } = useRevealOnScroll(worlds.length, 'gallery');

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

  /** 新建 = 打开空草稿编辑器（2026-09-16 用户拍板「先编辑后落库」，同
   *  CharactersView）：不落库，编辑器动作行「保存」才创建进列表；放弃/
   *  关闭即弃稿。 */
  const handleNew = useCallback(() => {
    setEditorError(null);
    setEditor(newDraftWorld());
    setEditorOpen(true);
  }, []);

  /** 创建出口（编辑器 create 模式「保存」）：落库 + refresh；失败就地红字
   *  并上抛——编辑器保持打开（契约同 handleAutosave），成功由编辑器自行
   *  请求关闭。 */
  const handleCreate = useCallback(
    async (input: WorldInput) => {
      setEditorError(null);
      try {
        await createWorld(input);
        await refresh();
      } catch (e) {
        setEditorError(`${t('worlds.saveFailed')}：${describeError(e)}`);
        throw e;
      }
    },
    [refresh, t],
  );

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
        // 编辑中的卡被删：置不可见走抽屉退场，onClosed 到点再真正卸载。
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

  // UI-002：卡片按 updated_at 倒序（同角色页惯例）。
  const sorted = [...worlds].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className={page}>
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <Title1 as="h1">{t('worlds.title')}</Title1>
          <div className={styles.toolbarRight}>
            <Button appearance="primary" onClick={handleNew}>
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
            <div className={styles.galleryGrid}>
              {sorted.map((world, index) => (
                <WorldGalleryCard
                  key={world.id}
                  world={world}
                  index={index}
                  revealDelay={reveal[index]}
                  register={register}
                  onOpen={openEditor}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {editor ? (
        <WorldEditorDrawer
          key={`edit-${editor.id}`}
          mode={editor.id === DRAFT_ID ? 'create' : 'edit'}
          open={editorOpen}
          world={editor}
          errorText={editorError}
          onAutosave={handleAutosave}
          onCreate={handleCreate}
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
