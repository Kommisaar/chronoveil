/**
 * 角色卡编辑器（2026-09-09 推倒重做后用户定稿：左满高海报 + 右设置面板）。
 *
 * - 布局：左侧 280px 电影海报占满整列（editor/PosterPane：渐变 + 首字水印 +
 *   名字 + 出场风格，随输入实时更新，与海报墙语言统一），右侧为中性面板
 *   （标题 / 表单 / 动作；2026-09-09 用户定稿：右栏不带背景色，主题交给
 *   左海报）；
 * - 强调色即角色主色：accent_color（迁移 0003）设了就整卡覆盖（海报墙与
 *   本海报同规则 posterGradientOf），未设按 id 取模；表单内色板可改；
 * - 表单逻辑（状态 / 修改即保存 / 模型覆写 / 预览引擎）全部在 editor/useEditorForm，
 *   字段级组件在 editor/pieces 与 editor/IdentityField——本文件只是排版壳；
 *   右栏 = 三张分组设置卡（2026-09-13 用户定稿）：基础信息（身份行 + 强调色 +
 *   人设）、输出动画（预览 + 动画样式）与其他配置（模型覆写）；
 *   2026-09-13 用户定稿：取消 / 保存按钮移除，改动经表单钩子防抖自动落库，
 *   本文件在全部关闭路径（背板 / × / Esc）先 flushSave 补存最后一拍再请求关闭；
 *   历法不属角色卡（2026-09-13 产品裁剪），会话历法在开局向导按会话配置；
 * - Fluent 坑位备忘：非模态对话框的关闭按钮经 DialogTitle action 插槽落为
 *   标题的兄弟节点（flex 流里会折到标题下方），须插槽 + 绝对定位钉右上角；
 *   DialogBody 原生 grid 轨道按内容收缩，子元素满宽须显式接管布局；
 *   Chromium 里 position:fixed 的 DialogSurface 自身就是 fixed 后代的包含块，
 *   毛玻璃层挂 surface 伪元素上只会有面板大小——必须做成 surface 之外的
 *   独立 fixed 元素（zIndex 9 垫在 surface 10 之下，点击 = 走父级 onClose）。
 * - 动画契约：open=false 表示「退场中」——本组件留在挂载树播完出场动画
 *   （keyframes 在 app.css，Griffel 类经 mergeClasses 挂载），计时到点回调
 *   onClosed，父级才真正卸载；因此关闭永远有退场，无论哪条路径发起。
 *   面板本体的共享元素 FLIP 形变在 editor/useSurfaceMorph（弹簧进 / 减速
 *   退，矩形由父级 getTriggerRect 现测）；surface 与背板纯淡化走静态
 *   keyframes，body 内容交叉淡化（晚于形变淡入，遮住缩放挤压），退场期
 *   掐交互。reduced-motion 门控在 @media 内。自动保存后无「未保存修改」，
 *   关闭不再有丢弃确认。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { DUR_DEFAULT_MS, RHYTHM_DEFAULT_MS } from '../../engine';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { SettingsCard, SettingsDivider } from '../../components/SettingsCard';
import type { CharacterInput, CharacterSummary, ProviderDto } from '../../api/types';
import {
  ACCELERATE_CURVE,
  DECELERATE_CURVE,
  EDITOR_BACKDROP_IN_MS,
  EDITOR_BODY_IN_DELAY_MS,
  EDITOR_BODY_IN_MS,
  EDITOR_BODY_OUT_MS,
  EDITOR_FADE_MS,
} from '../../components/motion';
import { IdentityField } from './editor/IdentityField';
import { AnimParamRows } from './editor/AnimParamRows';
import type { AnimDefaults } from './editor/useEditorForm';
import { PosterPane } from './editor/PosterPane';
import { OverrideSection, PerformanceField, useFieldStyles } from './editor/pieces';
import { useEditorForm } from './editor/useEditorForm';
import { useSurfaceMorph } from './editor/useSurfaceMorph';

const useStyles = makeStyles({
  // padding 0：海报顶天立地贴满左缘，内边距交给右栏各段
  surface: {
    // 桌面壳 minWidth 960 放得下 880；min() 兜底浏览器 dev 等无下限环境，
    // 窄于 ~930px 时面板收缩而不是溢出视口。maxWidth 880 必须显式保留：
    // Fluent DialogSurface 自带 max-width: 600px，删掉它面板会被压回 600
    maxWidth: '880px',
    width: 'min(880px, calc(100vw - 48px))',
    // 高度恒定（2026-09-10 用户定稿）：展示↔编辑切换、覆写开合时外框
    // 纹丝不动，只有表单区内部重排/滚动；海报永远满高成海报卡
    height: 'min(640px, 92vh)',
    padding: '0px',
    overflow: 'hidden',
    // 页面级卡片表面 16px（三档圆角规范最上一档：分组卡 = Large 6px、
    // 行内 = Medium 4px，Fluent token 实测值见 SettingsCard / ProviderCard
    // 同款注释）：Fluent 默认 XLarge(8px) 在 880px 宽的面板上太方，海报
    // 贴边时几乎不可见；16px 与海报卡（CharacterPosterCard cardB，含
    // --fui-Card--border-radius 变量同步）、聊天 composerCard 同档，规范
    // 常量见 src/components/surfaceSpec.ts 的 SURFACE_RADIUS_PAGE_CARD；
    // overflow hidden 已有，海报随曲面裁切
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    // 与毛玻璃层（backdrop）同处 FluentProvider 层叠上下文：10 > 9 压住它
    zIndex: '10',
  },
  // 非 modal 的 Fluent 对话框没有 Smoke 蒙层；自绘一层「装饰性毛玻璃」
  // （Fluent 系 Acrylic 的 web 仿法：blur + saturate + 暗 tint + 细噪点）。
  // 不能挂在 surface 伪元素上（fixed 的 surface 是 fixed 后代的包含块，
  // 层会被钳在面板大小），必须是 surface 之外的独立 fixed 元素。
  // 背板拦截点击 = 关闭（用户预期：点外面是返回，不是穿透切换角色）；
  // 点击 = requestClose：flushSave 补存最后一拍后直接关闭（修改即保存，无丢弃确认）。
  backdrop: {
    position: 'fixed',
    inset: '0px',
    zIndex: '9',
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='linear' slope='0.05'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
    backdropFilter: 'blur(18px) saturate(1.4)',
  },
  // —— 进出场。面板形变是 surface 上的 FLIP 行内变换（见文件头与
  // useSurfaceMorph）；surface 与背板纯淡化走静态 keyframes，body 内容
  // 交叉淡化（晚于形变淡入，遮住缩放挤压）、退场期掐交互。时长与曲线
  // 全部取 motion.ts token（编排语义见各常量注释）。
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
  // 左右分栏：左海报满高 + 右栏（标题/表单/动作）。surface 高度恒定后这里
  // 撑满 100%，且显式行高 minmax(0,1fr)：不写行高时隐式行按内容收缩，
  // 容器 640 行却只有内容高，动作行悬空、海报不满高。content 自身滚动。
  split: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
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
    // 溢出滚动的细滚动条（WebView2 Chromium 支持）：默认粗滚动条在圆角
    // 亚克力面板右缘太重
    scrollbarWidth: 'thin',
    scrollbarColor: `${tokens.colorNeutralStroke2} transparent`,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  actionsRow: {
    padding: '12px 24px 16px 24px',
  },
  // 删除按钮钉到动作行左端（marginRight:auto 把取消/保存推去右侧）；
  // 原为行内静态 style，收编进 griffel（审计低：静态值不入行内）
  deleteAction: {
    marginRight: 'auto',
  },
  // 覆写下拉区的配置加载失败文案（Task-14）：水平内距对齐 OverrideSection
  // 的 cardBody（'0px 20px 12px'，见 editor/pieces useFieldStyles.cardBody）
  providersError: {
    padding: '0px 20px 12px',
    color: tokens.colorPaletteRedForeground1,
  },
});

export interface CharacterEditorDialogProps {
  /** 编辑目标（全量字段预填，含 persona / modelConfig）；新建由父级先建卡
   *  再进编辑器，本组件只服务编辑既有卡。 */
  character: CharacterSummary;
  /** 可见性：false 时本组件播退场动画（仍挂载），到点回调 onClosed。 */
  open: boolean;
  /** 退场动画播完（EXIT_MS）后回调；父级据此真正卸载本组件。 */
  onClosed: () => void;
  /** 共享元素过渡的触发元素矩形（卡片 / 新建按钮），打开与关闭时现测；
      返回 null（元素已不在，如软删后）则退化为纯淡入淡出。 */
  getTriggerRect?: () => DOMRect | null;
  /** providers 下拉数据源（getConfig 的 providers）。 */
  providers: ProviderDto[];
  /** 全局配置加载失败的降级文案（Task-14，父组件设置；null = 未失败）：
      就地落在「其他配置」卡（覆写下拉区域），与「未配置 provider」的
      空列表可区分——空列表不设此 prop。 */
  providersError?: string | null;
  /** 演出参数「跟随全局」基准（全局配置派生）；缺省回落模板默认。 */
  animDefaults?: AnimDefaults | undefined;
  /** 保存失败的行内错误文案（父组件设置）。 */
  errorText: string | null;
  /** 修改即保存的上送出口（父级落库 + refresh + 错误就地展示）。 */
  onAutosave: (input: CharacterInput) => Promise<void>;
  /** 关闭请求（背板 / × / Esc）：本组件先 flushSave 补存最后一拍。 */
  onClose: () => void;
  /** 删除按钮：父组件弹就地确认对话框，本组件不直接删。 */
  onDelete: (character: CharacterSummary) => void;
}

export function CharacterEditorDialog(props: CharacterEditorDialogProps) {
  const {
    character,
    open,
    onClosed,
    getTriggerRect,
    providers,
    providersError,
    animDefaults,
    errorText,
    onAutosave,
    onClose,
    onDelete,
  } = props;
  const styles = useStyles();
  const field = useFieldStyles();
  const { t } = useTranslation();
  const form = useEditorForm({ character, onAutosave, animDefaults });
  const { surfaceRef } = useSurfaceMorph({ open, onClosed, getTriggerRect });

  // 全部关闭路径共用：先补存最后一拍（无在途防抖即 no-op），再请求关闭。
  const requestClose = (): void => {
    form.flushSave();
    onClose();
  };

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
        // 标题栏 ×（Fluent 非模态自动注入）：先补存最后一拍，再走父级关闭。
        if (!data.open) requestClose();
      }}
    >
      <DialogSurface
        // Fluent 插槽的 ref 类型被推导成 Ref<never>（未锚定元素类型），
        // 运行时转发的是承载背景/圆角/边框的 surface div——FLIP 形变必须
        // 落在这个盒子上（body 上做的话外壳会原地淡入而非从卡片长出），
        // 此处断言收窄。
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
          {/* 左：电影海报占满整列（纯预览随表单输入更新；对读屏隐藏防重复） */}
          <PosterPane
            posterGradient={form.live.posterGradient}
            nameText={form.live.nameText}
            dotGradient={form.live.dotGradient}
            styleLabel={form.live.styleLabel}
          />
          {/* 右：中性面板上的标题 / 表单 / 动作（主题交给左海报） */}
          <div className={styles.rightCol}>
            <DialogTitle className={styles.titleRow} action={{ className: styles.titleAction }}>
              {t('characters.editTitle')}
            </DialogTitle>
            <DialogContent className={styles.content}>
              <div className={styles.form}>
                {/* 基础信息卡（editor/IdentityField）：名称 / 性别 / 年龄 /
                    强调色行 + 人设块（2026-09-13 用户定稿并入本卡），空名时
                    canSave 关掉并出必填提示。 */}
                <IdentityField
                  name={form.name}
                  gender={form.gender}
                  age={form.age}
                  onNameChange={form.setName}
                  onGenderChange={form.setGender}
                  onAgeChange={form.setAge}
                  persona={form.persona}
                  onPersonaChange={form.setPersona}
                  accentColor={form.accentColor}
                  baseColor={form.live.baseColor}
                  onAccentColorChange={form.setAccentColor}
                  canSave={form.canSave}
                />
                {/* 输出动画卡（2026-09-13 用户定稿独立成卡）：行 1 预览、行 2
                    动画样式（风格下拉 + 预览动画）、行 3–5 演出参数（卡可覆写，
                    留空跟随全局）；其他配置卡放模型覆写。同一分组卡语言 */}
                <SettingsCard title={t('characters.sectionAnim')}>
                  <PerformanceField
                    renderStyle={form.renderStyle}
                    onStyleChange={form.setRenderStyle}
                    onPlay={form.playPreview}
                    previewRef={form.previewRef}
                    previewed={form.previewed}
                  />
                  <SettingsDivider />
                  <AnimParamRows
                    durationMs={form.animDurationMs}
                    rhythmMs={form.animRhythmMs}
                    punctPause={form.animPunctPause}
                    defaults={
                      animDefaults ?? {
                        durationMs: DUR_DEFAULT_MS,
                        msPerChar: RHYTHM_DEFAULT_MS,
                        punctPause: true,
                      }
                    }
                    onDurationChange={form.setAnimDurationMs}
                    onRhythmChange={form.setAnimRhythmMs}
                    onPunctChange={form.setAnimPunctPause}
                  />
                </SettingsCard>
                <SettingsCard title={t('characters.sectionOther')}>
                  <OverrideSection
                    open={form.overrideOpen}
                    onToggle={() => form.setOverrideOpen((o) => !o)}
                    override={form.override}
                    onOverrideChange={form.setOverride}
                    providers={providers}
                  />
                  {/* 全局配置加载失败的降级信号（Task-14）：信号落点即受影响
                      的覆写下拉所在卡；不用 errorText 通道（那是保存/删除失败
                      的语义，混入会互相覆盖）。 */}
                  {providersError ? (
                    <Text role="alert" size={200} className={styles.providersError}>
                      {providersError}
                    </Text>
                  ) : null}
                </SettingsCard>
                {errorText ? (
                  <Text role="alert" size={200} className={field.error}>
                    {errorText}
                  </Text>
                ) : null}
              </div>
            </DialogContent>
            <DialogActions className={styles.actionsRow}>
              <Button
                className={styles.deleteAction}
                onClick={() => onDelete(character)}
              >
                {t('characters.delete')}
              </Button>
            </DialogActions>
          </div>
        </DialogBody>
      </DialogSurface>
      </Dialog>
    </>
  );
}
