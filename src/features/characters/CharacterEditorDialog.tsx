/**
 * 角色卡编辑器（2026-09-09 推倒重做后用户定稿：左满高海报 + 右设置面板）。
 *
 * - 布局：左侧 280px 电影海报占满整列（渐变 + 首字水印 + 名字 + 开场白 +
 *   出场风格，随输入实时更新，与海报墙语言统一），右侧为中性面板
 *   （标题 / 表单 / 动作；2026-09-09 用户定稿：右栏不带背景色，主题交给
 *   左海报）；
 * - 强调色即角色主色：accent_color（迁移 0003）设了就整卡覆盖（海报墙与
 *   本海报同规则 posterGradientOf），未设按 id 取模；表单内色板可改；
 * - 表单逻辑（状态 / 脏比对 / 模型覆写 / 预览引擎）全部在 editor/useEditorForm，
 *   字段级组件在 editor/pieces——本文件只是排版壳；
 * - Fluent 坑位备忘：非模态对话框的关闭按钮经 DialogTitle action 插槽落为
 *   标题的兄弟节点（flex 流里会折到标题下方），须插槽 + 绝对定位钉右上角；
 *   DialogBody 原生 grid 轨道按内容收缩，子元素满宽须显式接管布局；
 *   Chromium 里 position:fixed 的 DialogSurface 自身就是 fixed 后代的包含块，
 *   毛玻璃层挂 surface 伪元素上只会有面板大小——必须做成 surface 之外的
 *   独立 fixed 元素（zIndex 9 垫在 surface 10 之下，点击 = 走父级 onClose）。
 * - 动画契约：open=false 表示「退场中」——本组件留在挂载树播完出场动画
 *   （keyframes 在 app.css，Griffel 类经 mergeClasses 挂载），计时到点回调
 *   onClosed，父级才真正卸载；因此关闭永远有退场，无论哪条路径发起。
 * - 共享元素过渡：面板本体走 FLIP 行内变换——挂载时把面板钉到触发卡片
 *   的矩形（translate+scale），再过渡回位；退场反向缩回卡片。进场形变
 *   用弹簧曲线 SPRING_CURVE（与卡片入场/悬停同一「弹簧语言」，会过冲
 *   一点点再落定），退场保持减速安静。矩形由父级
 *   getTriggerRect 现测（查不到，如软删后的卡片，退化为纯淡出）；动态值
 *   进不了 Griffel keyframes，所以面板形变是 useLayoutEffect 内的行内
 *   style，keyframes 只管背板淡化与 body 内容交叉淡化。
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
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterInput, CharacterSummary, ProviderDto } from '../../api/types';
import { SPRING_CURVE } from '../../components/motion';
import { AccentSwatches, OverrideSection, PerformanceField, useFieldStyles } from './editor/pieces';
import { useEditorForm } from './editor/useEditorForm';

/** FLIP 时长：进场形变 400ms 弹簧（过冲后落定，与卡片入场同一节奏），
    退场 200ms 减速安静；EXIT_MS 含余量，到点卸载。 */
const ENTER_MS = 400;
const MORPH_MS = 200;
const EXIT_MS = 210;

const morphable = (): boolean =>
  !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const useStyles = makeStyles({
  // padding 0：海报顶天立地贴满左缘，内边距交给右栏各段
  surface: {
    maxWidth: '880px',
    width: '880px',
    maxHeight: 'min(640px, 92vh)',
    padding: '0px',
    overflow: 'hidden',
    // 大圆角：Fluent 默认 XLarge(8px) 在 880px 宽的面板上太方，海报
    // 贴边时几乎不可见；16px 与卡片海报的圆润语言对齐（overflow hidden
    // 已有，海报随曲面裁切）
    borderRadius: '16px',
    // 与毛玻璃层（backdrop）同处 FluentProvider 层叠上下文：10 > 9 压住它
    zIndex: '10',
  },
  // 非 modal 的 Fluent 对话框没有 Smoke 蒙层；自绘一层「装饰性毛玻璃」
  // （Fluent 系 Acrylic 的 web 仿法：blur + saturate + 暗 tint + 细噪点）。
  // 不能挂在 surface 伪元素上（fixed 的 surface 是 fixed 后代的包含块，
  // 层会被钳在面板大小），必须是 surface 之外的独立 fixed 元素。
  // 背板拦截点击 = 关闭（用户预期：点外面是返回，不是穿透切换角色）；
  // 脏态由父级 onClose 的守卫接管（弹丢弃确认）。
  backdrop: {
    position: 'fixed',
    inset: '0px',
    zIndex: '9',
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='linear' slope='0.05'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
    backdropFilter: 'blur(18px) saturate(1.4)',
  },
  // —— 进出场。面板形变是 DialogBody 上的 FLIP 行内变换（见文件头与
  // runEnter/退场 effect）；surface 与背板纯淡化走静态 keyframes，body
  // 内容交叉淡化（晚于形变淡入，遮住缩放挤压）、退场期掐交互。
  // reduced-motion 门控在 @media 内。
  surfaceIn: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-in',
      animationDuration: '200ms',
      animationTimingFunction: 'var(--curveDecelerateMid)',
    },
  },
  surfaceOut: {
    pointerEvents: 'none',
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-out',
      animationDuration: '200ms',
      animationTimingFunction: 'var(--curveAccelerateMid)',
      animationFillMode: 'forwards',
    },
  },
  backdropIn: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-in',
      animationDuration: '280ms',
      animationTimingFunction: 'var(--curveDecelerateMid)',
    },
  },
  backdropOut: {
    pointerEvents: 'none',
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-fade-out',
      animationDuration: '200ms',
      animationTimingFunction: 'var(--curveAccelerateMid)',
      animationFillMode: 'forwards',
    },
  },
  bodyIn: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-body-in',
      animationDuration: '160ms',
      animationDelay: '90ms',
      animationTimingFunction: 'var(--curveDecelerateMid)',
      animationFillMode: 'backwards',
    },
  },
  bodyOut: {
    pointerEvents: 'none',
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'editor-body-out',
      animationDuration: '70ms',
      animationTimingFunction: 'var(--curveAccelerateMid)',
      animationFillMode: 'forwards',
    },
  },
  // 左右分栏：左海报满高 + 右栏（标题/表单/动作）
  split: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    gap: '0px',
    alignItems: 'stretch',
  },
  // —— 左：电影海报占满整列 ——
  poster: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  posterLetter: {
    position: 'absolute',
    top: '24px',
    left: '0px',
    right: '0px',
    textAlign: 'center',
    fontSize: '72px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    color: 'rgba(255, 255, 255, 0.24)',
    userSelect: 'none',
    // 与海报墙一致：不加 textShadow（半透明填充透出暗晕像污渍）
  },
  posterScrim: {
    position: 'absolute',
    left: '0px',
    right: '0px',
    bottom: '0px',
    height: '55%',
    pointerEvents: 'none',
    backgroundImage:
      'linear-gradient(180deg, rgba(14, 13, 22, 0) 0%, rgba(14, 13, 22, 0.55) 45%, rgba(13, 12, 20, 0.92) 100%)',
  },
  posterContent: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: tokens.spacingVerticalL,
  },
  posterName: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: '#ffffff',
    wordBreak: 'break-word',
  },
  posterGreeting: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
    overflow: 'hidden',
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.7',
    color: 'rgba(255, 255, 255, 0.82)',
    '::before': { content: '"「"', color: 'rgba(255, 255, 255, 0.55)' },
    '::after': { content: '"」"', color: 'rgba(255, 255, 255, 0.55)' },
  },
  posterMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: '4px',
  },
  posterMetaText: {
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: tokens.fontSizeBase200,
  },
  posterDot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
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
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  actionsRow: {
    padding: '12px 24px 16px 24px',
  },
});

export interface CharacterEditorDialogProps {
  /** null = 新建；否则编辑该角色（全量字段预填，含 persona / modelConfig）。 */
  character: CharacterSummary | null;
  /** 可见性：false 时本组件播退场动画（仍挂载），到点回调 onClosed。 */
  open: boolean;
  /** 退场动画播完（EXIT_MS）后回调；父级据此真正卸载本组件。 */
  onClosed: () => void;
  /** 共享元素过渡的触发元素矩形（卡片 / 新建按钮），打开与关闭时现测；
      返回 null（元素已不在，如软删后）则退化为纯淡入淡出。 */
  getTriggerRect?: () => DOMRect | null;
  /** providers 下拉数据源（getConfig 的 providers）。 */
  providers: ProviderDto[];
  saving: boolean;
  /** 保存 / 删除失败的行内错误文案（父组件设置）。 */
  errorText: string | null;
  /** 脏状态上报（父级据此拦截切换选中项 / 关闭）。 */
  onDirtyChange: (dirty: boolean) => void;
  onSave: (input: CharacterInput) => void;
  /** 关闭请求（背板 / 取消 / × / Esc）：父级过脏守卫后把 open 翻 false。 */
  onClose: () => void;
  /** 删除按钮（仅编辑态）：父组件弹就地确认对话框，本组件不直接删。 */
  onDelete: (character: CharacterSummary) => void;
}

export function CharacterEditorDialog(props: CharacterEditorDialogProps) {
  const {
    character,
    open,
    onClosed,
    getTriggerRect,
    providers,
    saving,
    errorText,
    onDirtyChange,
    onSave,
    onClose,
    onDelete,
  } = props;
  const styles = useStyles();
  const field = useFieldStyles();
  const { t } = useTranslation();
  const form = useEditorForm({ character, onDirtyChange });

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const getTriggerRectRef = useRef(getTriggerRect);
  getTriggerRectRef.current = getTriggerRect;

  /** FLIP 起点：把面板钉到触发元素矩形再过渡回原位。用「改起点 →
      offsetWidth 冲刷提交 → 改终点」的同步节奏触发 transition，不依赖
      rAF（后台/遮挡标签页 rAF 会被节流，transition 在合成器照常推进）；
      透明度交给 surface 的 keyframes，这里只动 transform。 */
  const runEnter = () => {
    const el = surfaceRef.current;
    if (!el || !morphable()) return;
    el.style.transition = 'none';
    el.style.transform = 'none';
    void el.offsetWidth; // 冲刷①：提交重置态，排除残留 transform 的测量污染
    const rect = el.getBoundingClientRect();
    const tr = getTriggerRectRef.current?.() ?? null;
    if (!tr || rect.width <= 0 || rect.height <= 0) return;
    const dx = tr.left + tr.width / 2 - (rect.left + rect.width / 2);
    const dy = tr.top + tr.height / 2 - (rect.top + rect.height / 2);
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${tr.width / rect.width}, ${tr.height / rect.height})`;
    void el.offsetWidth; // 冲刷②：提交钉住态作为过渡起点
    el.style.transition = `transform ${ENTER_MS}ms ${SPRING_CURVE}`;
    el.style.transform = 'none';
  };

  useLayoutEffect(runEnter, []);

  // 退场：反向 FLIP 缩回触发元素（surface 同时 keyframes 淡出），EXIT_MS
  // 到点通知父级卸载。cleanup 恢复进场起点——退场中途重开同一目标时复播。
  useEffect(() => {
    if (open) return;
    const el = surfaceRef.current;
    if (el && morphable()) {
      const rect = el.getBoundingClientRect();
      const tr = getTriggerRectRef.current?.() ?? null;
      if (tr && rect.width > 0 && rect.height > 0) {
        const dx = tr.left + tr.width / 2 - (rect.left + rect.width / 2);
        const dy = tr.top + tr.height / 2 - (rect.top + rect.height / 2);
        el.style.transition = `transform ${MORPH_MS}ms var(--curveAccelerateMid)`;
        void el.offsetWidth; // 冲刷：确保新 transition 从当前态起步
        el.style.transform = `translate(${dx}px, ${dy}px) scale(${tr.width / rect.width}, ${tr.height / rect.height})`;
      }
    }
    const timer = window.setTimeout(() => onClosedRef.current(), EXIT_MS);
    return () => {
      window.clearTimeout(timer);
      runEnter();
    };
  }, [open]);

  return (
    <>
      {/* 毛玻璃背板：surface 之外的独立 fixed 层；点击 = 关闭（脏守卫在父级） */}
      <div
        aria-hidden
        className={mergeClasses(styles.backdrop, open ? styles.backdropIn : styles.backdropOut)}
        onClick={onClose}
      />
      <Dialog
      open
      modalType="non-modal"
      onOpenChange={(_, data) => {
        // 标题栏 ×（Fluent 非模态自动注入）走父级 onClose：脏守卫照常拦截。
        if (!data.open) onClose();
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
          <aside
            className={styles.poster}
            style={{ backgroundImage: form.live.posterGradient }}
            aria-hidden
          >
            <Text className={styles.posterLetter}>{form.name.trim().slice(0, 1) || '·'}</Text>
            <div className={styles.posterScrim} />
            <div className={styles.posterContent}>
              <Text className={styles.posterName}>{form.live.nameText}</Text>
              {form.live.greetingText ? (
                <Text className={styles.posterGreeting}>{form.live.greetingText}</Text>
              ) : null}
              <div className={styles.posterMeta}>
                <span
                  className={styles.posterDot}
                  style={{ backgroundImage: form.live.dotGradient }}
                />
                <Text className={styles.posterMetaText}>{form.live.styleLabel}</Text>
              </div>
            </div>
          </aside>
          {/* 右：中性面板上的标题 / 表单 / 动作（主题交给左海报） */}
          <div className={styles.rightCol}>
            <DialogTitle className={styles.titleRow} action={{ className: styles.titleAction }}>
              {character ? t('characters.editTitle') : t('characters.createTitle')}
            </DialogTitle>
            <DialogContent className={styles.content}>
              <div className={styles.form}>
                <label className={field.field}>
                  <Text size={300} weight="semibold">
                    {t('characters.name')}
                  </Text>
                  <Input
                    value={form.name}
                    onChange={(_, d) => form.setName(d.value)}
                    aria-label={t('characters.name')}
                  />
                  {!form.canSave ? <Text size={200}>{t('characters.nameRequired')}</Text> : null}
                </label>
                <label className={field.field}>
                  <Text size={300} weight="semibold">
                    {t('characters.persona')}
                  </Text>
                  <Textarea
                    value={form.persona}
                    rows={3}
                    onChange={(_, d) => form.setPersona(d.value)}
                    aria-label={t('characters.persona')}
                    placeholder={t('characters.personaPlaceholder')}
                  />
                </label>
                <label className={field.field}>
                  <Text size={300} weight="semibold">
                    {t('characters.greeting')}
                  </Text>
                  <Textarea
                    value={form.greeting}
                    rows={3}
                    onChange={(_, d) => form.setGreeting(d.value)}
                    aria-label={t('characters.greeting')}
                    placeholder={t('characters.greetingPlaceholder')}
                  />
                </label>
                <div className={field.field}>
                  <Text size={300} weight="semibold">
                    {t('characters.renderStyle')}
                  </Text>
                  <PerformanceField
                    renderStyle={form.renderStyle}
                    onStyleChange={form.setRenderStyle}
                    onPlay={form.playPreview}
                    previewRef={form.previewRef}
                    previewed={form.previewed}
                  />
                </div>
                <div className={field.field}>
                  <Text size={300} weight="semibold">
                    {t('characters.accentColor')}
                  </Text>
                  <AccentSwatches
                    accentColor={form.accentColor}
                    idPosterGradient={form.live.idPosterGradient}
                    onChange={form.setAccentColor}
                  />
                  <Text size={200}>{t('characters.accentHint')}</Text>
                </div>
                <OverrideSection
                  open={form.overrideOpen}
                  onToggle={() => form.setOverrideOpen((o) => !o)}
                  override={form.override}
                  onOverrideChange={form.setOverride}
                  providers={providers}
                />
                {errorText ? (
                  <Text role="alert" size={200} className={field.error}>
                    {errorText}
                  </Text>
                ) : null}
              </div>
            </DialogContent>
            <DialogActions className={styles.actionsRow}>
              {character ? (
                <Button
                  style={{ marginRight: 'auto' }}
                  disabled={saving}
                  onClick={() => onDelete(character)}
                >
                  {t('characters.delete')}
                </Button>
              ) : null}
              <Button disabled={saving} onClick={onClose}>
                {t('characters.cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={!form.canSave || saving}
                onClick={() => onSave(form.buildInput())}
              >
                {saving ? t('characters.saving') : t('characters.save')}
              </Button>
            </DialogActions>
          </div>
        </DialogBody>
      </DialogSurface>
      </Dialog>
    </>
  );
}
