// 角色管理视图（UC-004 / FR-006 / UI-002 / ADR-009 / ADR-011）。TASK-008 完整 CRUD
// 之上的视觉重做（沉浸氛围感）：
// - 卡片为竖版电影海报卡（2026-09-09 用户定稿，双形态对比期结束移除横版）：
//   全幅渐变 + 底部压暗白字；
// - 入场动画定稿弹性（card-enter-pop）：视口内触发（useRevealOnScroll），
//   首屏手动判交立即成批、折叠线以下滚入才播，批内 60ms 错峰；
// - 氛围层：fixed 环境光晕（靛紫，呼应应用图标），仅本视图挂载期间存在；
// - 每角色渐变按 id 取模 6 组深色低饱和调色板，同人恒同色；
// - 交互与测试契约不变：卡片是 .fui-Card、名字独立文本节点、点击进编辑、
//   开新会话走 selectSession、脏守卫照旧。
import {
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
import type { CSSProperties } from 'react';
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
import { SPRING_CURVE } from '../../components/motion';
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { useRevealOnScroll } from '../../components/useRevealOnScroll';
import { useUiStore } from '../../stores/ui';
import { dotGradientOf, posterGradientOf } from './posterGradient';
import { CharacterEditorDialog } from './CharacterEditorDialog';

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

  // —— 海报卡共享件（头像图 / 高光 / 色点） ——
  posterImg: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    position: 'absolute',
    inset: '0px',
  },
  orb: {
    position: 'absolute',
    inset: '0px',
    pointerEvents: 'none',
    backgroundImage:
      'radial-gradient(circle at 72% 16%, rgba(255, 255, 255, 0.28), transparent 55%)',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },

  // —— 竖版电影海报卡：全幅渐变 + 底部压暗白字 ——
  cardB: {
    padding: '0px',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    minHeight: '300px',
    overflow: 'hidden',
    // 16px 大圆角与编辑器面板对齐；喂给 Card 的圆角变量让 ::after
    // 聚焦环同步跟随（否则键盘 focus 时方角环会露出来）
    borderRadius: '16px',
    '--fui-Card--border-radius': '16px',
  },
  letterB: {
    position: 'absolute',
    top: '30px',
    left: '0px',
    right: '0px',
    textAlign: 'center',
    fontSize: '88px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    color: 'rgba(255, 255, 255, 0.24)',
    userSelect: 'none',
    textShadow: '0 2px 24px rgba(0, 0, 0, 0.35)',
  },
  scrimB: {
    position: 'absolute',
    left: '0px',
    right: '0px',
    bottom: '0px',
    height: '70%',
    pointerEvents: 'none',
    backgroundImage:
      'linear-gradient(180deg, rgba(14, 13, 22, 0) 0%, rgba(14, 13, 22, 0.55) 45%, rgba(13, 12, 20, 0.92) 100%)',
  },
  contentB: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: '100%',
    padding: tokens.spacingVerticalM,
  },
  nameB: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: '#ffffff',
    wordBreak: 'break-word',
  },
  greetingB: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.7',
    color: 'rgba(255, 255, 255, 0.82)',
    '::before': { content: '"「"', color: 'rgba(255, 255, 255, 0.55)' },
    '::after': { content: '"」"', color: 'rgba(255, 255, 255, 0.55)' },
  },
  metaB: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    rowGap: '2px',
    gap: tokens.spacingHorizontalS,
    marginTop: '4px',
  },
  metaTextB: {
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: tokens.fontSizeBase200,
  },
  startBtnB: {
    marginLeft: 'auto',
    whiteSpace: 'nowrap',
    color: 'rgba(255, 255, 255, 0.92)',
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
    border: '1px solid rgba(255, 255, 255, 0.35)',
    ':hover': { backgroundColor: 'rgba(255, 255, 255, 0.20)' },
  },

  clickable: {
    cursor: 'pointer',
  },

  // —— 入场动画（定稿弹性；keyframes 在 app.css；reduced-motion 门控在 @media 内） ——
  // 必须走 Griffel 类 + mergeClasses：Fluent Card 内部对 className 再过一次
  // Griffel 合并，字符串拼接的全局类会被静默丢弃（repo 规约）。
  // 揭示前占位：滚入视口前以透明等待；揭示后换动画类，动画类里的
  // backwards fill 会在批内延迟期接手维持 from 态，动画止于自然态。
  preReveal: {
    opacity: 0,
  },
  enterPop: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'card-enter-pop',
      animationDuration: '480ms',
      // 弹簧曲线共享常量 SPRING_CURVE（src/components/motion.ts）
      animationTimingFunction: SPRING_CURVE,
      animationFillMode: 'backwards',
      animationDelay: 'var(--enter-delay, 0ms)',
    },
  },
});

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CharactersView() {
  const styles = useStyles();
  const lift = useCardLiftStyles();
  const page = usePageContainerStyles('grid');
  const { t } = useTranslation();
  // 只调用既有 store API（验收 6）：selectSession = 选中会话并切回聊天视图。
  const selectSession = useUiStore((s) => s.selectSession);

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const [startError, setStartError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<number | null>(null);
  // 视口内触发入场（方案 2 标准做法）：首屏手动判交立即成批，折叠线
  // 以下滚入才播；同批 60ms 级错峰。本视图内无重挂触发源，resetKey 恒定。
  const { reveal, register } = useRevealOnScroll(characters.length, 'characters');

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

  const styleMeta = (character: CharacterSummary) =>
    `${t('characters.renderStyle')} · ${character.renderStyle}`;

  return (
    <div className={page}>
      <div className={styles.ambient} aria-hidden />
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <Title1 as="h1">{t('characters.title')}</Title1>
          <div className={styles.toolbarRight}>
            <Button
              appearance="primary"
              data-editor-trigger="create"
              onClick={() => openEditor({ mode: 'create' })}
            >
              {t('characters.new')}
            </Button>
          </div>
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
          <div className={styles.gridPoster}>
            {sorted.map((character, index) => {
              const delay = reveal[index];
              const enterStyle =
                delay === undefined
                  ? undefined
                  : ({ '--enter-delay': `${delay}ms` } as CSSProperties);
              return (
                <Card
                  key={character.id}
                  size="small"
                  tabIndex={0}
                  ref={register(index)}
                  data-editor-trigger={character.id}
                  className={mergeClasses(
                    styles.cardB,
                    lift.root,
                    styles.clickable,
                    delay === undefined ? styles.preReveal : styles.enterPop,
                  )}
                  style={{
                    ...enterStyle,
                    backgroundImage: posterGradientOf(character),
                  }}
                  onClick={() => openEditor({ mode: 'edit', character })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openEditor({ mode: 'edit', character });
                    }
                  }}
                >
                  {character.avatar ? (
                    <img
                      className={styles.posterImg}
                      src={character.avatar}
                      alt={character.name}
                    />
                  ) : (
                    <Text className={styles.letterB}>{character.name.slice(0, 1)}</Text>
                  )}
                  <div className={styles.orb} />
                  <div className={styles.scrimB} />
                  <div className={styles.contentB}>
                    <Text className={styles.nameB}>{character.name}</Text>
                    <Text className={styles.greetingB}>{character.greeting}</Text>
                    <div className={styles.metaB}>
                      <span
                        className={styles.dot}
                        style={{ backgroundImage: dotGradientOf(character) }}
                      />
                      <Text className={styles.metaTextB}>{styleMeta(character)}</Text>
                      <Text className={styles.metaTextB}>
                        {t('characters.sessionCount', { count: character.sessionCount })}
                      </Text>
                      <Button
                        size="small"
                        appearance="transparent"
                        className={styles.startBtnB}
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
              );
            })}
          </div>
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
