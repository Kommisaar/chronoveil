// 角色管理视图（UC-004 / FR-006 / UI-002 / ADR-009 / ADR-011）。TASK-008 完整 CRUD
// 之上的视觉重做（沉浸氛围感）：
// - 卡片为竖版电影海报卡、单一形态（2026-09-09 用户定稿），
//   渲染与卡内交互独立在 CharacterPosterCard，本视图管数据流与对话框接线；
// - 入场动画定稿弹性（card-enter-pop）：视口内触发（useRevealOnScroll），
//   首屏手动判交立即成批、折叠线以下滚入才播，批内 60ms 错峰；
// - 氛围层：fixed 环境光晕（靛紫，呼应应用图标），仅本视图挂载期间存在；
// - 交互与测试契约：点击进编辑；修改即保存（2026-09-13 用户定稿），无
//   脏守卫与丢弃确认；本视图仅服务编辑既有卡，新建 = 先以默认名落库再
//   进编辑器（handleNew）。
import {
  Button,
  Text,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowUploadRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useState } from 'react';
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
import type { AnimDefaults } from './editor/useEditorForm';
import { CharacterPosterCard } from './CharacterPosterCard';

/** 新建卡的默认负载：先落库再进编辑器（修改即保存），后续编辑自动保存到该卡。 */
function newCharacterInput(name: string): CharacterInput {
  return {
    name,
    avatar: null,
    persona: '',
    gender: null,
    age: null,
    titles: [],
    // 新建卡默认跟随全局（0014 列语义，与 Rust NewCharacter::default 一致）。
    renderStyle: null,
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
  };
}

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
  // 演出参数「跟随全局」基准（2026-09-13）：全局配置里的三项，编辑器预览与
  // 行描述据此展示；加载失败回落 undefined → 表单钩子取模板默认。
  const [animDefaults, setAnimDefaults] = useState<AnimDefaults | undefined>(undefined);
  // 全局配置加载失败的降级信号（Task-14）：只影响模型覆写下拉的数据源，
  // 与「未配置 provider」的空列表可区分；落到编辑器「其他配置」卡的就地
  // 红字，不引入全局错误态（角色列表主功能不受累）。
  const [providersError, setProvidersError] = useState<string | null>(null);
  // 编辑目标（既有卡）：新建走「先建卡再编辑」，本视图不再有 create 模式。
  const [editor, setEditor] = useState<CharacterSummary | null>(null);
  // 可见性与挂载分离：editorOpen=false 只触发退场动画，播完 onClosed 才卸载。
  const [editorOpen, setEditorOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CharacterSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 视口内触发入场（方案 2 标准做法）：首屏手动判交立即成批，折叠线
  // 以下滚入才播；同批 60ms 级错峰。本视图内无重挂触发源，resetKey 恒定。
  const { reveal, register } = useRevealOnScroll(characters.length, 'characters');

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
    // 只是覆写下拉暂无选项——失败不空吞，降级信号落 providersError（编辑器
    // 「模型配置」卡就地红字，Task-14），与「未配置 provider」的空列表可区分；
    // 不加自动重试/全局错误态：覆写是低频可重进路径，重开视图即重拉。
    // 依赖刻意只留 []：t 仅在失败时生成文案，i18n 切语言不触发重拉配置。
    let cancelled = false;
    getConfig()
      .then((config) => {
        if (cancelled) return;
        setProviders(config.providers);
        setAnimDefaults({
          durationMs: config.animDurationBase,
          msPerChar: config.rhythmMsPerChar,
          punctPause: config.punctPauseEnabled,
          renderStyle: config.renderStyle,
          temperature: config.temperature,
          defaultProviderId: config.activeProviderId ?? '',
          defaultModelId: config.activeModel ?? '',
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setProvidersError(
          `${t('characters.providersLoadFailed')}：${describeError(e)}`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openEditor = useCallback((character: CharacterSummary) => {
    setEditorError(null);
    setEditor(character);
    setEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => setEditorOpen(false), []);

  /** 共享元素过渡用：当前编辑目标对应的触发元素（卡片）矩形。
      关闭时卡片可能已被删（软删后 refresh），查不到就返回 null，对话框
      自行退化为纯淡出。 */
  const getTriggerRect = useCallback(() => {
    const el = editor
      ? document.querySelector<HTMLElement>(`[data-editor-trigger="${editor.id}"]`)
      : null;
    return el ? el.getBoundingClientRect() : null;
  }, [editor]);

  /** 新建 = 先以默认名落库再进编辑器（修改即保存，无独立 create 表单态）。 */
  const handleNew = useCallback(async () => {
    setCreating(true);
    setActionError(null);
    try {
      const created = await createCharacter(newCharacterInput(t('characters.new')));
      await refresh();
      setEditor(created);
      setEditorOpen(true);
    } catch (e) {
      setActionError(`${t('characters.saveFailed')}：${describeError(e)}`);
    } finally {
      setCreating(false);
    }
  }, [refresh, t]);

  /** 修改即保存的上送出口：落库 + refresh；失败就地红字并上抛——编辑器
   *  表单钩子据此不推进已保存基线，下一拍改动自然重试。 */
  const handleAutosave = useCallback(
    async (input: CharacterInput) => {
      if (!editor) return;
      setEditorError(null);
      try {
        await updateCharacter(editor.id, input);
        await refresh();
      } catch (e) {
        setEditorError(`${t('characters.saveFailed')}：${describeError(e)}`);
        throw e;
      }
    },
    [editor, refresh, t],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // 软删（ADR-009）：卡片消失；历史会话与消息保留，聊天侧仍可查看。
      await deleteCharacter(deleteTarget.id);
      await refresh();
      if (editor?.id === deleteTarget.id) {
        setEditorOpen(false);
      }
    } catch (e) {
      setEditorError(`${t('characters.deleteFailed')}：${describeError(e)}`);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, editor, refresh, t]);

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
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <Title1 as="h1">{t('characters.title')}</Title1>
          <div className={styles.toolbarRight}>
            <Button icon={<ArrowUploadRegular />} onClick={() => void handleImport()}>
              {t('characters.import')}
            </Button>
            <Button
              appearance="primary"
              disabled={creating}
              onClick={() => void handleNew()}
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
                  onOpen={openEditor}
                  onExport={(id) => void handleExport(id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {editor ? (
        <CharacterEditorDialog
          key={`edit-${editor.id}`}
          open={editorOpen}
          character={editor}
          getTriggerRect={getTriggerRect}
          providers={providers}
          providersError={providersError}
          animDefaults={animDefaults}
          errorText={editorError}
          onAutosave={handleAutosave}
          onClose={closeEditor}
          onClosed={() => setEditor(null)}
          onDelete={setDeleteTarget}
        />
      ) : null}

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
