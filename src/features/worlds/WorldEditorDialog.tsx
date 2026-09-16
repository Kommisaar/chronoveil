/**
 * 世界卡编辑器（2026-09-15 用户定稿升档：「世界观是世界的灵魂」，与角色
 * 编辑器同档——推翻旧「480px 窄模态三卡平铺」的简单档口径）：
 * 左 220px 满高世界色画布（WorldCanvasPane：渐变 + 首字水印 + 名称/历法名
 * 两行，随表单实时更新）+ 右设置面板三张分组卡（基础信息 / 世界观 / 历法
 * 五选）——世界观为主角：编辑态 12 行 textarea，预览态 MarkdownPreviewBox。
 *
 * - 壳形态学自 CharacterEditorDialog（features 禁互引，worlds 域内自建；
 *   两处以内不提取公共编辑器壳）：非模态 Dialog + 自绘 fixed 毛玻璃背板
 *   （点击 = requestClose）+ 从档案卡 FLIP 长出（useSurfaceMorph）+
 *   surface/背板纯淡化、body 交叉淡化（时长与曲线全取 components/motion.ts）；
 * - Fluent 坑位备忘（抄学自 CharacterEditorDialog 文件头，出处注释在彼处）：
 *   非模态对话框的关闭按钮经 DialogTitle action 插槽落为标题的兄弟节点
 *   （flex 流里会折到标题下方），须插槽 + 绝对定位钉右上角；Chromium 里
 *   position:fixed 的 DialogSurface 自身就是 fixed 后代的包含块，毛玻璃层
 *   挂 surface 伪元素上只会有面板大小——必须做成 surface 之外的独立
 *   fixed 元素（zIndex 9 垫在 surface 10 之下，点击 = 走 requestClose）；
 * - 修改即保存（无取消/保存按钮，仅 edit 模式）：表单逻辑在 useWorldForm
 *   （600ms 防抖 + 串行链 + 纠正拍），本文件只是排版壳；edit 模式全部关闭
 *   路径（× / Esc / 背板）经 requestClose 先 flushSave 补存最后一拍再回调
 *   onClose；2026-09-16 创建流程改「先编辑后落库」（用户拍板，与角色编辑器
 *   同构）：create 模式（新建草稿）自动保存全链路静默，动作行为 放弃/保存
 *   ——保存经 onCreate 一次性落库，其余一切关闭路径即放弃；
 * - 动画契约：open=false 表示「退场中」——本组件留在挂载树播完出场动画，
 *   到点回调 onClosed，父级才真正卸载；因此关闭永远有退场，无论哪条路径
 *   发起（含软删：父级先置 open=false，卸载等 onClosed）。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Radio,
  RadioGroup,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CALENDAR_PRESET_OPTIONS,
  type CalendarPresetId,
} from '../../components/calendarPresets';
import {
  ACCELERATE_CURVE,
  DECELERATE_CURVE,
  EDITOR_BACKDROP_IN_MS,
  EDITOR_BODY_IN_DELAY_MS,
  EDITOR_BODY_IN_MS,
  EDITOR_BODY_OUT_MS,
  EDITOR_FADE_MS,
} from '../../components/motion';
import { MarkdownPreviewBox } from '../../components/MarkdownPreviewBox';
import { SegmentedControl } from '../../components/SegmentedControl';
import { SettingsCard, SettingsRow } from '../../components/SettingsCard';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { useSurfaceMorph } from '../../components/useSurfaceMorph';
import type { WorldInput, WorldSummary } from '../../api/types';
import { WorldCanvasPane } from './WorldCanvasPane';
import type { PresetKey } from './useWorldForm';
import { useWorldForm } from './useWorldForm';
import { worldGradientOf } from './worldGradient';

/** 选中预设的静态样例行（预设常量自带说明文本，i18n key）。 */
const SAMPLE_KEYS: Record<CalendarPresetId, string> = {
  modern: 'worlds.sampleModern',
  seven: 'worlds.sampleSeven',
  ganzhi: 'worlds.sampleGanzhi',
  fantasy: 'worlds.sampleFantasy',
};

const useStyles = makeStyles({
  // padding 0：世界色画布顶天立地贴满左缘，内边距交给右栏各段。
  // maxWidth 720 必须显式保留：Fluent DialogSurface 自带 max-width: 600px，
  // 删掉它面板会被压回 600（坑位备忘抄学自 CharacterEditorDialog.surface）。
  surface: {
    maxWidth: '720px',
    width: 'min(720px, calc(100vw - 48px))',
    // 高度恒定（同角色编辑器取舍）：世界观预览|编辑切换、历法样例行变化时
    // 外框纹丝不动，只有表单区内部重排/滚动；画布永远满高成卡
    height: 'min(560px, 92vh)',
    padding: '0px',
    overflow: 'hidden',
    // 页面级卡面 16px（SURFACE_RADIUS_PAGE_CARD 单一事实源，三档圆角规范
    // 注释见 src/components/surfaceSpec.ts）；overflow hidden 已有，画布随
    // 曲面裁切
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    // 与毛玻璃层（backdrop）同处 FluentProvider 层叠上下文：10 > 9 压住它
    zIndex: '10',
  },
  // 非 modal 的 Fluent 对话框没有 Smoke 蒙层；自绘一层「装饰性毛玻璃」
  // （配方逐字取角色编辑器：暗 tint + blur + saturate + 细噪点）。不能挂在
  // surface 伪元素上（fixed 的 surface 是 fixed 后代的包含块，层会被钳在
  // 面板大小），必须是 surface 之外的独立 fixed 元素。背板拦截点击 = 关闭
  // （用户预期：点外面是返回），走 requestClose：flushSave 补存最后一拍后
  // 直接关闭（修改即保存，无丢弃确认）。
  backdrop: {
    position: 'fixed',
    inset: '0px',
    zIndex: '9',
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='linear' slope='0.05'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
    backdropFilter: 'blur(18px) saturate(1.4)',
  },
  // —— 进出场。面板形变是 surface 上的 FLIP 行内变换（useSurfaceMorph）；
  // surface 与背板纯淡化走 app.css 静态 keyframes（editor-fade-*），body
  // 内容交叉淡化（editor-body-*，晚于形变淡入遮住缩放挤压）、退场期掐交互。
  // 时长与曲线全部取 motion.ts token（编排语义见各常量注释）。
  surfaceIn: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-in',
      animationDuration: `${EDITOR_FADE_MS}ms`,
      animationTimingFunction: DECELERATE_CURVE,
    },
  },
  surfaceOut: {
    pointerEvents: 'none',
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-out',
      animationDuration: `${EDITOR_FADE_MS}ms`,
      animationTimingFunction: ACCELERATE_CURVE,
      animationFillMode: 'forwards',
    },
  },
  backdropIn: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-in',
      animationDuration: `${EDITOR_BACKDROP_IN_MS}ms`,
      animationTimingFunction: DECELERATE_CURVE,
    },
  },
  backdropOut: {
    pointerEvents: 'none',
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-out',
      animationDuration: `${EDITOR_FADE_MS}ms`,
      animationTimingFunction: ACCELERATE_CURVE,
      animationFillMode: 'forwards',
    },
  },
  bodyIn: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-body-in',
      animationDuration: `${EDITOR_BODY_IN_MS}ms`,
      animationDelay: `${EDITOR_BODY_IN_DELAY_MS}ms`,
      animationTimingFunction: DECELERATE_CURVE,
      animationFillMode: 'backwards',
    },
  },
  bodyOut: {
    pointerEvents: 'none',
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-body-out',
      animationDuration: `${EDITOR_BODY_OUT_MS}ms`,
      animationTimingFunction: ACCELERATE_CURVE,
      animationFillMode: 'forwards',
    },
  },
  // 左右分栏：左画布满高 + 右栏（标题/表单/动作）。surface 高度恒定后这里
  // 撑满 100%，且显式行高 minmax(0,1fr)：不写行高时隐式行按内容收缩，容器
  // 560 行却只有内容高，动作行悬空、画布不满高（坑位备忘同角色编辑器
  // split）。content 自身滚动。
  split: {
    display: 'grid',
    gridTemplateColumns: '220px minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1fr)',
    gap: '0px',
    alignItems: 'stretch',
    height: '100%',
  },
  // —— 右：标题/表单/动作三段；surface padding 归零后由各段给内边距。
  // 关闭按钮经 action 插槽绝对定位右上角（原生会折到标题下一行）。
  rightCol: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: '0px',
    minHeight: '0px',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 56px 0px 24px',
  },
  titleAction: {
    position: 'absolute',
    top: '12px',
    right: '14px',
  },
  content: {
    flex: 1,
    minHeight: '0px',
    overflowY: 'auto',
    padding: '12px 24px 0px 24px',
    // 溢出滚动的细滚动条（同角色编辑器）：默认粗滚动条在圆角面板右缘太重
    scrollbarWidth: 'thin',
    scrollbarColor: `${tokens.colorNeutralStroke2} transparent`,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  nameInput: {
    width: '200px',
    minWidth: '0px',
  },
  worldbookMode: {
    width: '112px',
    minWidth: '0px',
  },
  worldbookBody: {
    display: 'block',
    padding: '0px 20px 12px',
  },
  worldbookTextarea: {
    width: '100%',
  },
  // 预览态外层恒定 minHeight：空世界观/短文时预览卡不塌缩，编辑↔预览切换
  // 高度稳定（共享件 MarkdownPreviewBox 本身不改）
  worldbookPreview: {
    minHeight: '200px',
  },
  calendarBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: '12px 20px',
  },
  sample: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'pre-wrap',
  },
  hint: {
    display: 'block',
    padding: '0px 20px 12px',
    marginTop: '-4px',
  },
  actionsRow: {
    padding: '12px 24px 16px 24px',
  },
  // 左钮钉动作行左端（marginRight:auto 把后续钮推到右端）：edit 模式仅删除
  // 钉左、右端留空；create 模式放弃钉左、保存落右端主动作位——同一锚类复用
  deleteAction: {
    marginRight: 'auto',
  },
});

export interface WorldEditorDialogProps {
  /** 编辑模式（2026-09-16 创建流程改「先编辑后落库」，与角色编辑器同构）：
   *  edit = 编辑既有卡（修改即保存 + 删除动作行）；create = 新建草稿
   *  （world 为父级构造的空草稿，id 0 仅供画布渐变派生——自动保存全链路
   *  静默，动作行为 放弃/保存，保存经 onCreate 一次性落库，其余一切关闭
   *  路径即放弃）。 */
  mode: 'create' | 'edit';
  /** 编辑目标（全量字段预填：WorldSummary 即编辑数据源，无单条查询）；
   *  create 模式传空草稿（父级 newDraftWorld）。 */
  world: WorldSummary;
  /** 可见性：false 时本组件播退场动画（仍挂载），到点回调 onClosed。 */
  open: boolean;
  /** 退场动画播完（EXIT_MS）后回调；父级据此真正卸载本组件。 */
  onClosed: () => void;
  /** 共享元素过渡的触发元素矩形（档案卡），打开与关闭时现测；
      返回 null（元素已不在，如软删后）则退化为纯淡入淡出。 */
  getTriggerRect?: (() => DOMRect | null) | undefined;
  /** 保存失败的行内错误文案（父组件设置）。 */
  errorText: string | null;
  /** 修改即保存的上送出口（父级落库 + refresh + 错误就地展示；仅 edit 模式）。 */
  onAutosave: (input: WorldInput) => Promise<void>;
  /** 创建出口（仅 create 模式「保存」）：父级落库 + refresh；失败就地红字
   *  并上抛——本组件保持打开（契约同 onAutosave），成功后自行请求关闭。 */
  onCreate: (input: WorldInput) => Promise<void>;
  /** 关闭请求（× / Esc / 背板）：edit 模式先 flushSave 补存最后一拍；
   *  create 模式即放弃（草稿不落库）。 */
  onClose: () => void;
  /** 删除按钮（仅 edit 模式）：父组件弹就地确认对话框，本组件不直接删。 */
  onDelete: (world: WorldSummary) => void;
}

export function WorldEditorDialog(props: WorldEditorDialogProps) {
  const {
    mode,
    world,
    open,
    onClosed,
    getTriggerRect,
    errorText,
    onAutosave,
    onCreate,
    onClose,
    onDelete,
  } = props;
  const styles = useStyles();
  const { t } = useTranslation();
  const form = useWorldForm({ world, onAutosave, autosave: mode === 'edit' });
  const { surfaceRef } = useSurfaceMorph({ open, onClosed, getTriggerRect });

  // 世界观预览 / 编辑是纯视图切换：不参与数据（落库走修改即保存）。
  const [worldbookEditing, setWorldbookEditing] = useState(false);
  // 创建在途标记（create 模式）：保存点击后禁用动作行防双击；失败复位保持打开。
  const [saving, setSaving] = useState(false);

  // 全部关闭路径共用：edit 先补存最后一拍（无在途防抖即 no-op）；create 即
  // 放弃（草稿不落库，与动作行「放弃」同语义）。
  const requestClose = (): void => {
    if (mode === 'edit') form.flushSave();
    onClose();
  };

  /** 保存（create 模式动作）：整卡载荷一次性创建；成功即请求关闭（卡片经
   *  父级 refresh 进列表），失败保持打开（错误由父级就地红字，契约同
   *  onAutosave 上抛）。 */
  const handleSave = (): void => {
    if (!form.canSave || saving) return;
    setSaving(true);
    onCreate(form.buildInput())
      .then(() => onClose())
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  // 画布预览数据（WorldCanvasPane 不依赖 form，props 注入）：世界色按 id
  // 恒定；空名回退打开时快照名（新卡即默认名），水印与名称行不因清空输入
  // 而消失（回退名语义同角色编辑器 PosterPane）；历法标签随五选一实时换
  // （default → 「默认数字历」，预设 → 既有 labelKey）。
  const calendarOption = CALENDAR_PRESET_OPTIONS.find(({ id }) => id === form.preset);

  return (
    <>
      {/* 毛玻璃背板：surface 之外的独立 fixed 层；点击 = 关闭（先补存最后一拍） */}
      <div
        aria-hidden
        className={mergeClasses(styles.backdrop, open ? styles.backdropIn : styles.backdropOut)}
        onClick={requestClose}
      />
      <Dialog
      open
      modalType="non-modal"
      onOpenChange={(_, data) => {
        // 标题栏 ×（Fluent 非模态自动注入）/ Esc：先补存最后一拍，再走父级关闭。
        if (!data.open) requestClose();
      }}
      >
        <DialogSurface
          // Fluent 插槽的 ref 类型被推导成 Ref<never>（未锚定元素类型），
          // 运行时转发的是承载背景/圆角/边框的 surface div——FLIP 形变必须
          // 落在这个盒子上，此处断言收窄（坑位备忘同 CharacterEditorDialog）。
          ref={surfaceRef as never}
          className={mergeClasses(
            styles.surface,
            open ? styles.surfaceIn : styles.surfaceOut,
          )}
        >
          <DialogBody
            className={mergeClasses(
              styles.split,
              open ? styles.bodyIn : styles.bodyOut,
            )}
          >
            {/* 左：世界色画布占满整列（纯预览随表单输入更新；对读屏隐藏防重复）。
                名称回退链：输入中空名 → 打开时快照名（edit 模式防清空输入闪没）
                → 新建档位名（create 模式草稿无快照名可回退）；历法标签随五选一
                实时换（default → 「默认数字历」，预设 → 既有 labelKey）。 */}
            <WorldCanvasPane
              gradient={worldGradientOf(world.id)}
              nameText={form.name.trim() || world.name || t('worlds.new')}
              calendarLabel={
                calendarOption ? t(calendarOption.labelKey) : t('worlds.calendarNone')
              }
            />
            {/* 右：中性面板上的标题 / 表单 / 动作（主题交给左画布） */}
            <div className={styles.rightCol}>
              <DialogTitle className={styles.titleRow} action={{ className: styles.titleAction }}>
                {t(mode === 'create' ? 'worlds.new' : 'worlds.editTitle')}
              </DialogTitle>
              <DialogContent className={styles.content}>
                <div className={styles.form}>
                  {/* 基础信息卡：名称必填，空名时自动保存挂起并出提示。 */}
                  <SettingsCard title={t('worlds.sectionBasic')}>
                    <SettingsRow
                      title={t('worlds.nameLabel')}
                      control={
                        <Input
                          className={styles.nameInput}
                          value={form.name}
                          onChange={(_, d) => form.setName(d.value)}
                          aria-label={t('worlds.name')}
                        />
                      }
                    />
                    {!form.canSave ? (
                      <Text size={200} className={styles.hint}>
                        {t('worlds.nameRequired')}
                      </Text>
                    ) : null}
                  </SettingsCard>
                  {/* 世界观卡（主角，2026-09-15 用户定稿升档）：预览|编辑切换，
                      编辑态 12 行、预览态 minHeight 200——世界观是世界的灵魂，
                      给足篇幅。切换是纯视图语义，落库始终走修改即保存。 */}
                  <SettingsCard title={t('worlds.worldbook')}>
                    <SettingsRow
                      title={t('worlds.worldbook')}
                      control={
                        <SegmentedControl
                          className={styles.worldbookMode}
                          ariaLabel={t('worlds.worldbookViewLabel')}
                          value={worldbookEditing ? 'edit' : 'preview'}
                          onChange={(v) => setWorldbookEditing(v === 'edit')}
                          options={[
                            { value: 'preview', label: t('worlds.modePreview') },
                            { value: 'edit', label: t('worlds.modeEdit') },
                          ]}
                        />
                      }
                    />
                    <div className={styles.worldbookBody}>
                      {worldbookEditing ? (
                        <Textarea
                          className={styles.worldbookTextarea}
                          value={form.worldbook}
                          rows={12}
                          onChange={(_, d) => form.setWorldbook(d.value)}
                          aria-label={t('worlds.worldbook')}
                          placeholder={t('worlds.worldbookPlaceholder')}
                        />
                      ) : (
                        <div className={styles.worldbookPreview}>
                          <MarkdownPreviewBox
                            text={form.worldbook}
                            hint={t('worlds.worldbookPlaceholder')}
                          />
                        </div>
                      )}
                    </div>
                  </SettingsCard>
                  {/* 历法卡：五选单选（默认数字历 + 四内置预设，常量单一事实源
                      在 components/calendarPresets）+ 选中项静态样例行（不与
                      fiction_time::date_label 双写实时换算）。 */}
                  <SettingsCard title={t('worlds.calendar')}>
                    <div className={styles.calendarBody}>
                      <RadioGroup
                        value={form.preset}
                        onChange={(_, data) => form.setPreset(data.value as PresetKey)}
                        aria-label={t('worlds.calendar')}
                      >
                        <Radio value="default" label={t('worlds.presetDefault')} />
                        {CALENDAR_PRESET_OPTIONS.map(({ id, labelKey }) => (
                          <Radio key={id} value={id} label={t(labelKey)} />
                        ))}
                      </RadioGroup>
                      <Text size={200} className={styles.sample}>
                        {form.preset === 'default'
                          ? t('worlds.sampleDefault')
                          : t(SAMPLE_KEYS[form.preset])}
                      </Text>
                    </div>
                  </SettingsCard>
                  {errorText ? (
                    <Text role="alert" size={200}>
                      {errorText}
                    </Text>
                  ) : null}
                </div>
              </DialogContent>
              <DialogActions className={styles.actionsRow}>
                {mode === 'create' ? (
                  <>
                    {/* 放弃钉左端（marginRight:auto 把保存推到右端主动作位）：
                        草稿丢弃不落库，与背板/× 同语义 */}
                    <Button className={styles.deleteAction} disabled={saving} onClick={requestClose}>
                      {t('worlds.discard')}
                    </Button>
                    <Button
                      appearance="primary"
                      disabled={!form.canSave || saving}
                      onClick={handleSave}
                    >
                      {t('worlds.save')}
                    </Button>
                  </>
                ) : (
                  <Button className={styles.deleteAction} onClick={() => onDelete(world)}>
                    {t('worlds.delete')}
                  </Button>
                )}
              </DialogActions>
            </div>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
