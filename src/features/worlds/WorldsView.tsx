/**
 * 世界页（0017 世界卡特性）：与角色页同款的列表三态 + 卡网格 + 编辑器形态。
 * 卡面口径（2026-09-15 晚间用户批准重设计定稿）：gallery 档用 WorldPlateCard
 * 横版「图版卡」（上图下文，卡面承载身份——世界观摘录是主角，历法/日期退居
 * 次位；竖=角色域、横=世界域，对齐角色页海报墙的视觉分量），替代同日早前
 * 的档案卡定稿；ledger 档落单列名册行（WorldLedgerRow，Task-04，与角色页
 * CharacterLedgerRow 同族）；stage 档落满幅深底卡（WorldFullBleedCard，
 * Task-05：整卡世界色深底白字 + 页头青绿环境光晕），旧档案卡随 stage 接管
 * 无消费方而裁撤（拍板后败者随代码一并裁撤）。
 *
 * - 世界色按 id 取模恒定（worldGradientOf，地志调色板与角色靛紫系拉开域
 *   别）；同世界跨处配色漂移不可接受（同角色页规则）；
 * - 悬停无位移（仅底色变化）：lift 的 translateY/scale 在宽扁信息卡上观感
 *   浮动（用户反馈），与 WorldPickGrid worldCard 同款静停；入场动画仍与
 *   角色卡同款（card-enter-pop 弹簧 + useRevealOnScroll 视口揭示错峰）；
 * - 新建 = 先以默认名落库再进编辑器（修改即保存，同 CharactersView 惯例，
 *   无独立 create 表单态）；
 * - 编辑器（WorldEditorDialog）与角色编辑器同档（2026-09-15 用户定稿升档
 *   「世界观是世界的灵魂」，旧「标准模态简单档」口径作废）：左世界色画布
 *   + 右三张分组卡（基础信息 / 世界观 / 历法五选），非模态 + 毛玻璃背板 +
 *   从卡面 FLIP 长出（各档卡面都挂 data-editor-trigger），可见性与挂载
 *   分离（editorOpen 置 false 走退场动画，onClosed 才卸载）；改动经表单
 *   钩子防抖自动落库；
 * - 删除走 ConfirmDialog 确认：世界软删（ADR-009），已建会话内的世界快照
 *   （world_instances，D1 冻结语义）不受影响——文案明示该语义；
 * - 列表三态（A1 收编）：空列表时 loading / error+重试 / 空库三选一；列表
 *   在手时的重取失败保留红字 + 网格。
 * - 工具栏卡面风格切换器（三方向对比期基建）：与角色页共用全局
 *   cardDirection 档位——gallery 落图版卡网格，ledger 落单列名册行
 *   （Task-04），stage 落满幅深底卡网格 + 环境光晕（Task-05），拍板胜出
 *   方向后随败者裁撤。
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
import { SegmentedControl } from '../../components/SegmentedControl';
import { StateBlock } from '../../components/StateBlock';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { useRevealOnScroll } from '../../components/useRevealOnScroll';
import { useUiStore } from '../../stores/ui';
import { WorldEditorDialog } from './WorldEditorDialog';
import { WorldFullBleedCard } from './WorldFullBleedCard';
import { WorldLedgerRow } from './WorldLedgerRow';
import { WorldPlateCard } from './WorldPlateCard';

const useStyles = makeStyles({
  content: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  // 页头环境光晕（stage 档氛围层）：fixed 静态装饰，radial-gradient 从顶部
  // 青绿到透明。取色理由：#1f6d6f 是 worldGradient.ts「深青海」色对的亮端
  // ——世界域色板本身（地志调，与角色页靛紫光晕拉开域别），不引 Fluent
  // brand token（brand 是交互控件语义色，氛围层要的是域色不是控件色）；
  // 低不透明度装饰、不承载任何文字（无对比度约束），aria-hidden +
  // pointer-events none，zIndex 0 压在内容层（relative z1）之下。仅
  // cardDirection === 'stage' 时挂载（条件渲染非显隐）
  ambientGlow: {
    position: 'fixed',
    inset: '0px',
    pointerEvents: 'none',
    zIndex: 0,
    backgroundImage:
      'radial-gradient(ellipse 80% 45% at 50% 0%, rgba(31, 109, 111, 0.18) 0%, rgba(31, 109, 111, 0) 70%)',
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
  // 图版卡网格（gallery 档）：横版卡承载世界观摘录两行 clamp 的正文区，
  // 列宽 260px（舞台档满幅卡 300px 再疏朗一档，见 stageGrid）
  plateGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '16px',
  },
  // 满幅深底卡网格（stage 档，Task-05）：主角大卡——列宽定档比图版墙
  //（260px）疏朗一档（300px 起步，同窗宽列数更少、单卡更大），行距放宽
  // 到 20px；卡面高度由 WorldFullBleedCard 的 minHeight 280 自持
  stageGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '20px',
  },
  // 名册容器（ledger 档，Task-04）：单列限宽 880 居中（对齐 settings 族阅读
  // 宽度，与角色页 ledgerList 同口径）——名册是阅读型列表不是卡片墙；行间
  // 分隔由 WorldLedgerRow 行内细线承担
  ledgerList: {
    display: 'flex',
    flexDirection: 'column',
    maxWidth: '880px',
    marginInline: 'auto',
  },
  // 卡面风格切换器定宽：SegmentedControl 轨道自带 width:100%，工具栏 flex 行
  // 内不约束会撑满整行（同本文件 WorldEditorDialog.worldbookMode 先例）
  cardStyleSwitch: {
    width: '168px',
    minWidth: '0px',
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

  // 卡面方向档位（三方向对比期基建，与角色页共用）：gallery 落图版卡，
  // ledger 落名册行（Task-04），stage 落满幅深底卡 + 环境光晕（Task-05）
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
  // 清单浮现统一档错峰。resetKey 携带卡面方向：gallery ↔ ledger/stage 切换
  // 会重挂网格 DOM（useRevealOnScroll 文件头的设计场景），揭示状态须随之
  // 重置——否则新元素无人观察，折叠线以下从未滚入过的卡切档后永久透明。
  const { reveal, register } = useRevealOnScroll(worlds.length, cardDirection);

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

  /** 共享元素过渡用：当前编辑目标对应的触发元素（当前档位卡面）矩形。
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
      {/* stage 档氛围层：页头青绿环境光晕（fixed 装饰，仅 stage 档挂载，
          条件渲染非 CSS 显隐——切档即卸载，不残留绘制面） */}
      {cardDirection === 'stage' ? <div className={styles.ambientGlow} aria-hidden /> : null}
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
            {cardDirection === 'gallery' ? (
              <div className={styles.plateGrid}>
                {sorted.map((world, index) => (
                  <WorldPlateCard
                    key={world.id}
                    world={world}
                    index={index}
                    revealDelay={reveal[index]}
                    register={register}
                    onOpen={openEditor}
                  />
                ))}
              </div>
            ) : cardDirection === 'ledger' ? (
              // 名册档（Task-04）：单列名册行——世界色块 + 三行信息 + 行间细线
              <div className={styles.ledgerList}>
                {sorted.map((world, index) => (
                  <WorldLedgerRow
                    key={world.id}
                    world={world}
                    index={index}
                    revealDelay={reveal[index]}
                    register={register}
                    onOpen={openEditor}
                  />
                ))}
              </div>
            ) : (
              // stage 档（Task-05）：满幅深底卡——整卡世界色深底白字，内容
              // 全部常显（环境光晕层见页头条件渲染）
              <div className={styles.stageGrid}>
                {sorted.map((world, index) => (
                  <WorldFullBleedCard
                    key={world.id}
                    world={world}
                    index={index}
                    revealDelay={reveal[index]}
                    register={register}
                    onOpen={openEditor}
                  />
                ))}
              </div>
            )}
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
