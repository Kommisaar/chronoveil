// 角色管理视图（UC-004 / FR-006 / UI-002 / ADR-009 / ADR-011）。TASK-008 从只读
// 网格升级为完整 CRUD：
// - 卡片网格保留（updated_at 倒序，UI-002），卡片点击进入编辑（非模态
//   CharacterEditorDialog，网格仍可点选——「未保存切换选中项」丢弃确认可达）；
//   大卡布局沿用：左图区（avatar，null 首字占位）+ 右信息堆栈 + 悬停浮起。
// - 删除为软删（ADR-009）+ 就地 Fluent 确认对话框（文案明示历史会话与消息保留）。
// - 「开新会话」只调既有 store API（useUiStore.selectSession 创建并切回聊天），
//   不改 stores/ui.ts；侧栏列表新鲜度由会话任务负责（本任务不做）。
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createCharacter,
  createSession,
  deleteCharacter,
  getConfig,
  listCharacters,
  updateCharacter,
} from '../../api/commands';
import type { CharacterInput, CharacterSummary, ProviderDto } from '../../api/types';
import { EmptyState } from '../../components/EmptyState';
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { formatRelative } from '../../lib/relativeTime';
import { useUiStore } from '../../stores/ui';
import { CharacterEditorDialog } from './CharacterEditorDialog';

/** 编辑目标：create 无预填；edit 携带全量摘要（key 重挂换绑表单）。 */
type EditorTarget = { mode: 'create' } | { mode: 'edit'; character: CharacterSummary };

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  newBtn: {
    // 与标题同行、贴右（relay-harbor 设置页同款工具条）
    marginLeft: 'auto',
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
    gap: '12px',
  },
  empty: {
    display: 'flex',
    minHeight: '240px',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 大卡：padding 0 让图片区通栏贴边（圆角裁切靠 overflow hidden），
  // 右侧信息栏自带内边距
  card: {
    padding: '0px',
    display: 'grid',
    gridTemplateColumns: '150px minmax(0, 1fr)',
    overflow: 'hidden',
  },
  clickable: {
    cursor: 'pointer',
  },
  portrait: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '190px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  portraitImg: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  portraitChar: {
    fontSize: '40px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    minWidth: 0,
  },
  headRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  name: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  updated: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // markdown-lite 原文三行截断（展示层不解析，BR-005）；大卡右侧有宽度，
  // 比小卡的 2 行多给一行
  greeting: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  count: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  startBtn: {
    marginLeft: 'auto',
  },
});

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CharactersView() {
  const styles = useStyles();
  const lift = useCardLiftStyles();
  const page = usePageContainerStyles('grid');
  const { t, i18n } = useTranslation();
  // 只调用既有 store API（验收 6）：selectSession = 选中会话并切回聊天视图。
  const selectSession = useUiStore((s) => s.selectSession);

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CharacterSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<number | null>(null);

  // 待确认的切换动作：丢弃确认放行后执行（引用稳定，不进渲染）。
  const pendingActionRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCharacters(await listCharacters());
      setLoadError(null);
    } catch (e) {
      setLoadError(`${t('characters.loadFailed')}：${describeError(e)}`);
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
      });
    },
    [guarded],
  );

  const closeEditor = useCallback(() => {
    guarded(() => setEditor(null));
  }, [guarded]);

  /** 保存成功 / 删除成功后的静默关闭（目标已消失，无需丢弃确认）。 */
  const closeEditorSilently = useCallback(() => {
    setDirty(false);
    setEditor(null);
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

  const startSession = useCallback(
    (character: CharacterSummary) => {
      guarded(() => {
        void (async () => {
          setStartingId(character.id);
          setStartError(null);
          try {
            const session = await createSession(character.id);
            selectSession(session.id);
          } catch (e) {
            setStartError(`${t('characters.newSessionFailed')}：${describeError(e)}`);
          } finally {
            setStartingId(null);
          }
        })();
      });
    },
    [guarded, selectSession, t],
  );

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

  // UI-002：卡片按 updated_at 倒序。
  const sorted = [...characters].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className={page}>
      <div className={styles.root}>
        <div className={styles.toolbar}>
          <Title1 as="h1">{t('characters.title')}</Title1>
          <Button
            appearance="primary"
            className={styles.newBtn}
            onClick={() => openEditor({ mode: 'create' })}
          >
            {t('characters.new')}
          </Button>
        </div>
        {loadError ? (
          <Text role="alert" className={styles.errorText}>
            {loadError}
          </Text>
        ) : null}
        {startError ? (
          <Text role="alert" className={styles.errorText}>
            {startError}
          </Text>
        ) : null}
        {sorted.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState message={t('characters.empty')} />
          </div>
        ) : (
          <div className={styles.grid}>
            {sorted.map((character) => (
              <Card
                key={character.id}
                size="small"
                tabIndex={0}
                className={mergeClasses(styles.card, lift.root, styles.clickable)}
                onClick={() => openEditor({ mode: 'edit', character })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openEditor({ mode: 'edit', character });
                  }
                }}
              >
                <div className={styles.portrait}>
                  {character.avatar ? (
                    <img
                      className={styles.portraitImg}
                      src={character.avatar}
                      alt={character.name}
                    />
                  ) : (
                    <Text className={styles.portraitChar}>{character.name.slice(0, 1)}</Text>
                  )}
                </div>
                <div className={styles.info}>
                  <div className={styles.headRow}>
                    <Text className={styles.name}>{character.name}</Text>
                    <Text className={styles.updated}>
                      {formatRelative(character.updatedAt, i18n.language)}
                    </Text>
                  </div>
                  <Text className={styles.greeting}>{character.greeting}</Text>
                  <div className={styles.meta}>
                    <Badge appearance="tint">
                      {t('characters.renderStyle')} · {character.renderStyle}
                    </Badge>
                    <Text className={styles.count}>
                      {t('characters.sessionCount', { count: character.sessionCount })}
                    </Text>
                    <Button
                      size="small"
                      className={styles.startBtn}
                      disabled={startingId !== null}
                      onClick={(e) => {
                        e.stopPropagation();
                        startSession(character);
                      }}
                    >
                      {t('characters.newSession')}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {editor ? (
        <CharacterEditorDialog
          key={editor.mode === 'edit' ? `edit-${editor.character.id}` : 'create'}
          character={editor.mode === 'edit' ? editor.character : null}
          providers={providers}
          saving={saving}
          errorText={editorError}
          onDirtyChange={onDirtyChange}
          onSave={(input) => void handleSave(input)}
          onClose={closeEditor}
          onDelete={setDeleteTarget}
        />
      ) : null}

      {/* 丢弃确认（验收 3）：切换选中项 / 关闭编辑器且有未保存修改时弹出。 */}
      <Dialog open={discardOpen}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('characters.discardTitle')}</DialogTitle>
            <DialogContent>{t('characters.discardText')}</DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={cancelDiscard}>
                {t('characters.keepEditing')}
              </Button>
              <Button onClick={discardAndContinue}>{t('characters.discard')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* 删除确认（验收 5）：就地 Fluent Dialog，文案明示软删语义。 */}
      <Dialog open={deleteTarget !== null}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('characters.deleteConfirmTitle')}</DialogTitle>
            <DialogContent>
              {deleteTarget
                ? t('characters.deleteConfirmText', { name: deleteTarget.name })
                : ''}
            </DialogContent>
            <DialogActions>
              <Button disabled={deleting} onClick={() => setDeleteTarget(null)}>
                {t('characters.cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {t('characters.confirmDelete')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
