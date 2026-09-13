// 角色管理视图（UC-004 / FR-006 / UI-002 / ADR-009 / ADR-011）。TASK-008 完整 CRUD
// 之上的视觉重做（沉浸氛围感）：
// - 卡片为竖版电影海报卡（2026-09-09 用户定稿，双形态对比期结束移除横版），
//   渲染与卡内交互独立在 CharacterPosterCard，本视图管数据流与对话框接线；
// - 入场动画定稿弹性（card-enter-pop）：视口内触发（useRevealOnScroll），
//   首屏手动判交立即成批、折叠线以下滚入才播，批内 60ms 错峰；
// - 氛围层：fixed 环境光晕（靛紫，呼应应用图标），仅本视图挂载期间存在；
// - 交互与测试契约不变：点击进编辑、脏守卫照旧（卡片上的「开新会话」入口
//   已移除，建会话走侧栏新建）。
import {
  Button,
  Text,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowUploadRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createCharacter,
  deleteCharacter,
  exportCharacter,
  getConfig,
  importCharacter,
  listCharacters,
  updateCharacter,
} from '../../api/commands';
import type { CharacterInput, CharacterSummary, ProviderDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { StateBlock } from '../../components/StateBlock';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { useRevealOnScroll } from '../../components/useRevealOnScroll';
import { CharacterEditorDialog } from './CharacterEditorDialog';
import { CharacterPosterCard } from './CharacterPosterCard';

/** 编辑目标：create 无预填；edit 携带全量摘要（key 重挂换绑表单）。 */
type EditorTarget = { mode: 'create' } | { mode: 'edit'; character: CharacterSummary };

const useStyles = makeStyles({
  // —— 氛围层与页面骨架 ——
  ambient: {
    position: 'fixed',
    inset: '0px',
    zIndex: 0,
    pointerEvents: 'none',
    backgroundColor: 'transparent',
    backgroundImage:
      'radial-gradient(1100px 420px at 20% -8%, rgba(107, 70, 184, 0.16), transparent 62%), ' +
      'radial-gradient(900px 380px at 96% 0%, rgba(63, 106, 179, 0.10), transparent 60%)',
  },
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
  // 竖版电影海报网格（更窄更高，电影海报密度；200px 起步，海报墙不限宽随窗加列）
  gridPoster: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: '16px',
  },
  empty: {
    display: 'flex',
    minHeight: '240px',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CharactersView() {
  const styles = useStyles();
  const page = usePageContainerStyles('grid');
  const { t } = useTranslation();

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  // 列表在途标记（A1 三态收编）：true 且列表为空时出 loading 占位，堵住
  // 此前「初始 [] 闪空态」的窗口；列表在手时的重取不换占位（网格保持）。
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 导入/导出（Task-04）的操作错误：与列表加载错误同款就地红字（None 取消不提示）。
  const [actionError, setActionError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  // 可见性与挂载分离：editorOpen=false 只触发退场动画，播完 onClosed 才卸载。
  const [editorOpen, setEditorOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CharacterSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 视口内触发入场（方案 2 标准做法）：首屏手动判交立即成批，折叠线
  // 以下滚入才播；同批 60ms 级错峰。本视图内无重挂触发源，resetKey 恒定。
  const { reveal, register } = useRevealOnScroll(characters.length, 'characters');

  // 待确认的切换动作：丢弃确认放行后执行（引用稳定，不进渲染）。
  const pendingActionRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCharacters(await listCharacters());
      setLoadError(null);
    } catch (e) {
      setLoadError(`${t('characters.loadFailed')}：${describeError(e)}`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // providers 供 model_config 覆写下拉（验收 2）；加载失败不阻塞角色列表，
    // 只是覆写下拉暂无选项。
    let cancelled = false;
    getConfig()
      .then((config) => {
        if (!cancelled) setProviders(config.providers);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  /** 编辑器有未保存修改时，先弹就地丢弃确认，放行后才执行目标动作（验收 3）。 */
  const guarded = useCallback(
    (action: () => void) => {
      if (editor !== null && dirty) {
        pendingActionRef.current = action;
        setDiscardOpen(true);
        return;
      }
      action();
    },
    [editor, dirty],
  );

  const openEditor = useCallback(
    (target: EditorTarget) => {
      guarded(() => {
        setEditorError(null);
        setEditor(target);
        setEditorOpen(true);
      });
    },
    [guarded],
  );

  const closeEditor = useCallback(() => {
    guarded(() => setEditorOpen(false));
  }, [guarded]);

  /** 共享元素过渡用：当前编辑目标对应的触发元素（卡片 / 新建按钮）矩形。
      关闭时卡片可能已被删（软删后 refresh），查不到就返回 null，对话框
      自行退化为纯淡出。 */
  const getTriggerRect = useCallback(() => {
    const key = editor?.mode === 'edit' ? String(editor.character.id) : 'create';
    const el = document.querySelector<HTMLElement>(
      `[data-editor-trigger="${key}"]`,
    );
    return el ? el.getBoundingClientRect() : null;
  }, [editor]);

  /** 保存成功 / 删除成功后的静默关闭（目标已消失，无需丢弃确认）；
      仍走退场动画，播完 onClosed 卸载。 */
  const closeEditorSilently = useCallback(() => {
    setDirty(false);
    setEditorOpen(false);
  }, []);

  const handleSave = useCallback(
    async (input: CharacterInput) => {
      setSaving(true);
      setEditorError(null);
      try {
        if (editor?.mode === 'create') {
          await createCharacter(input);
        } else if (editor) {
          await updateCharacter(editor.character.id, input);
        }
        await refresh();
        closeEditorSilently();
      } catch (e) {
        setEditorError(`${t('characters.saveFailed')}：${describeError(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [editor, refresh, closeEditorSilently, t],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // 软删（ADR-009）：卡片消失；历史会话与消息保留，聊天侧仍可查看。
      await deleteCharacter(deleteTarget.id);
      await refresh();
      if (
        editor?.mode === 'edit' &&
        editor.character.id === deleteTarget.id
      ) {
        closeEditorSilently();
      }
    } catch (e) {
      setEditorError(`${t('characters.deleteFailed')}：${describeError(e)}`);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, editor, refresh, closeEditorSilently, t]);

  const discardAndContinue = (): void => {
    setDiscardOpen(false);
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    action?.();
  };

  const cancelDiscard = (): void => {
    setDiscardOpen(false);
    pendingActionRef.current = null;
  };

  // ---- 角色卡导入/导出（Task-04）：对话框在 Rust 侧原生弹出 ----

  /** 导入：成功后沿既有 refresh 单点重拉；取消（null）静默；真错误走就地红字。 */
  const handleImport = useCallback(async () => {
    setActionError(null);
    try {
      const created = await importCharacter();
      if (created) await refresh();
    } catch (e) {
      setActionError(`${t('characters.importFailed')}：${describeError(e)}`);
    }
  }, [refresh, t]);

  /** 导出：成功/取消均静默（卡文件已落在用户选择的位置）；真错误走就地红字。 */
  const handleExport = useCallback(
    async (id: number) => {
      setActionError(null);
      try {
        await exportCharacter(id);
      } catch (e) {
        setActionError(`${t('characters.exportFailed')}：${describeError(e)}`);
      }
    },
    [t],
  );

  // UI-002：卡片按 updated_at 倒序。
  const sorted = [...characters].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className={page}>
      <div className={styles.ambient} aria-hidden />
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <Title1 as="h1">{t('characters.title')}</Title1>
          <div className={styles.toolbarRight}>
            <Button icon={<ArrowUploadRegular />} onClick={() => void handleImport()}>
              {t('characters.import')}
            </Button>
            <Button
              appearance="primary"
              data-editor-trigger="create"
              onClick={() => openEditor({ mode: 'create' })}
            >
              {t('characters.new')}
            </Button>
          </div>
        </div>
        {actionError ? (
          <Text role="alert" className={styles.errorText}>
            {actionError}
          </Text>
        ) : null}
        {/* A1 三态收编：列表为空时 loading（StateBlock Spinner + 文案）/
            错误（StateBlock role="alert" + 重试钮，重试走现有 refresh 单点
            重拉）/ 空库（EmptyState）三选一；列表在手时保留红字 + 网格
            （重取失败不清空既有内容）。 */}
        {sorted.length === 0 ? (
          loading ? (
            <div className={styles.empty}>
              <StateBlock state="loading" label={t('characters.loading')} />
            </div>
          ) : loadError !== null ? (
            <div className={styles.empty}>
              <StateBlock
                state="error"
                label={loadError}
                onRetry={{ label: t('characters.retry'), onClick: () => void refresh() }}
              />
            </div>
          ) : (
            <div className={styles.empty}>
              <EmptyState message={t('characters.empty')} />
            </div>
          )
        ) : (
          <>
            {loadError ? (
              <Text role="alert" className={styles.errorText}>
                {loadError}
              </Text>
            ) : null}
            <div className={styles.gridPoster}>
              {sorted.map((character, index) => (
                <CharacterPosterCard
                  key={character.id}
                  character={character}
                  index={index}
                  revealDelay={reveal[index]}
                  register={register}
                  onOpen={(target) => openEditor({ mode: 'edit', character: target })}
                  onExport={(id) => void handleExport(id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {editor ? (
        <CharacterEditorDialog
          key={editor.mode === 'edit' ? `edit-${editor.character.id}` : 'create'}
          open={editorOpen}
          character={editor.mode === 'edit' ? editor.character : null}
          getTriggerRect={getTriggerRect}
          providers={providers}
          saving={saving}
          errorText={editorError}
          onDirtyChange={onDirtyChange}
          onSave={(input) => void handleSave(input)}
          onClose={closeEditor}
          onClosed={() => setEditor(null)}
          onDelete={setDeleteTarget}
        />
      ) : null}

      {/* 丢弃确认（验收 3）：切换选中项 / 关闭编辑器且有未保存修改时弹出。
          C1 收编：Esc/背板可取消（此前无 onOpenChange 不可取消），放弃键
          红色弱化、继续编辑为主键（安全动作优先）。 */}
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(open) => {
          if (!open) cancelDiscard();
        }}
        title={t('characters.discardTitle')}
        content={t('characters.discardText')}
        confirmLabel={t('characters.discard')}
        cancelLabel={t('characters.keepEditing')}
        destructive
        onConfirm={discardAndContinue}
      />

      {/* 删除确认（验收 5）：文案明示软删语义；C1 收编后 Esc/背板可取消。 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('characters.deleteConfirmTitle')}
        content={
          deleteTarget
            ? t('characters.deleteConfirmText', { name: deleteTarget.name })
            : ''
        }
        confirmLabel={t('characters.confirmDelete')}
        cancelLabel={t('characters.cancel')}
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
