/**
 * 编辑器共享 UI 件（2026-09-09 编辑器重做时抽出）：字段级组件与样式——
 * 预览框、人设预览、出场动画字段、模型覆写折叠段，由 CharacterEditorDialog
 * 排版壳复用。强调色取色器已按字段域拆至 AccentColorPicker（沿用本文件的
 * useFieldStyles）。
 */
import { Button, Dropdown, Option, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronRight20Regular } from '@fluentui/react-icons';
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderDto } from '../../../api/types';
import { ANIM_STYLES, renderStaticMarkdown } from '../../../engine';
import type { ModelOverrideFields } from './useEditorForm';

/** 三壳共用的字段级样式（makeStyles 可跨组件调用）。 */
export const useFieldStyles = makeStyles({
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  grow: {
    flexGrow: 1,
    minWidth: 0,
  },
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    '::after': {
      content: '""',
      flexGrow: 1,
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },
  // —— 强调色取色器（Office 风格下拉，2026-09-09）：无开合动画，瞬时开合。
  chipWrapper: {
    position: 'relative',
    display: 'inline-flex',
  },
  chipTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    // 与同行 Fluent Input 的 medium 高度（30px）对齐，编辑态整排等高
    height: '30px',
    padding: '0px 5px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    // 名称行空间紧张时不许把取色器压扁
    flexShrink: 0,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  chipColor: {
    // 正方形 + 禁收缩：弹性布局下不被挤压拉伸
    width: '20px',
    height: '20px',
    flexShrink: 0,
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStrokeAlpha2}`,
  },
  palettePanel: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: '0px',
    zIndex: 20,
    width: '268px',
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
  },
  paletteTitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  paletteGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(10, 1fr)',
    gap: '4px',
  },
  paletteSwatch: {
    height: '20px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStrokeAlpha2}`,
    cursor: 'pointer',
    ':hover': { boxShadow: `0 0 0 2px ${tokens.colorNeutralStroke2}` },
    // 选中环用短过渡：色块本身的增减无动画，动在状态反馈上。transition
    // 收进 no-preference 媒体块（同 useCardLiftStyles 的 reduce 门控）：
    // 减弱动态时悬停环瞬时出现，不做补间
    '@media (prefers-reduced-motion: no-preference)': {
      transitionProperty: 'box-shadow',
      transitionDuration: tokens.durationFast,
    },
  },
  paletteSwatchSelected: {
    boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}, 0 0 0 4px ${tokens.colorBrandForeground1}`,
    ':hover': {
      boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}, 0 0 0 4px ${tokens.colorBrandForeground1}`,
    },
  },
  paletteListItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: '4px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    // 裸 button 不继承文字色（UA 默认黑色），必须显式给主题前景色，
    // 否则暗色面板上是黑字
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  paletteListSwatch: {
    width: '20px',
    height: '20px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStrokeAlpha2}`,
    flexShrink: 0,
  },
  colorInputHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    opacity: 0,
    pointerEvents: 'none',
  },
  previewWrap: {
    position: 'relative',
  },
  preview: {
    minHeight: '72px',
    maxHeight: '160px',
    overflowY: 'auto',
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    wordBreak: 'break-word',
  },
  // 空态提示：ref 容器的兄弟节点——引擎直接操作容器内 DOM，React 子节点
  // 放同一容器会在 reconcile 时打架。
  previewHint: {
    position: 'absolute',
    inset: '0px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  // 人设静态预览的主题适配：引擎的加粗米白是聊天暗色调硬编码，预览容器内用
  // 主题 token 覆写保证亮色主题可读（动作蓝灰斜体双主题均可读，不动）。场景线
  // ✦ 挖空底不在此静态覆写：--cv-scene-line-bg 须与所在表面背景一致（engine.css
  // :root 注释），展示态落在 DialogSurface（bg1）而演出预览框是 bg2 表面，单一
  // 静态类无法两用——改为两个容器各自行内按表面注入（对齐聊天侧 ChatView 的
  // engineThemeVars 先例）
  personaMarkdown: {
    '& .tok.bold': { color: tokens.colorNeutralForeground1 },
  },
  // 人设展示态（2026-09-10 用户定稿）：无边框无底色，markdown 直接落在
  // 面板上，与聊天叙事流同观感；高度随内容自然生长（编辑态 textarea 变高）
  personaPlain: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    wordBreak: 'break-word',
  },
  // 空人设：给提示文案撑住一块可点击的视觉空间，非空时不占位
  personaEmpty: {
    minHeight: '72px',
  },
  // 空态提示（人设）：无框后左上对齐更像输入占位符（演出预览的居中提示是框内场景）
  personaHint: {
    position: 'absolute',
    top: '0px',
    left: '0px',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  collapseBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: '0px',
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    textAlign: 'left',
    ':hover': { color: tokens.colorBrandForeground1 },
  },
  chevron: {
    // 旋转过渡收进 no-preference 媒体块（同 useCardLiftStyles 的 reduce
    // 门控）；chevronOpen 的 transform 不门控——旋转是 aria-expanded 的
    // 可视冗余，减弱动态下瞬时切换（保留状态反馈，只去补间）
    '@media (prefers-reduced-motion: no-preference)': {
      transitionProperty: 'transform',
      transitionDuration: tokens.durationNormal,
      transitionTimingFunction: tokens.curveEasyEase,
    },
  },
  chevronOpen: {
    transform: 'rotate(90deg)',
  },
  collapseBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL,
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

/** 预览演出渲染容器 + 空态提示。 */
export function PreviewBox(props: {
  previewRef: (node: HTMLDivElement | null) => void;
  previewed: boolean;
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.previewWrap}>
      {/* 场景线挖空底按框表面（bg2）行内注入：演出样例含 --- 时不吃 engine.css
          :root 的暗色 #141822（亮色主题下成错色矩形）。变量名不在 React
          CSSProperties 类型内，as 断言对齐聊天侧 engineThemeVars 写法 */}
      <div
        ref={props.previewRef}
        className={styles.preview}
        style={{ '--cv-scene-line-bg': tokens.colorNeutralBackground2 } as CSSProperties}
      />
      {!props.previewed ? (
        <Text className={styles.previewHint}>{t('characters.previewEmpty')}</Text>
      ) : null}
    </div>
  );
}

/** 人设 markdown 静态预览：引擎 renderStaticMarkdown 直插 DOM（与聊天同
    语法语义），文本变化即整容器重渲染；展示态无边框底色（用户定稿），
    空文本由兄弟节点出提示（showHint=false 供编辑态实时预览复用——textarea
    已有 placeholder，不重复出提示）——引擎容器内的 DOM 不归 React 管，
    子节点放同一容器会在 reconcile 时打架（与 PreviewBox 同一招）。 */
export function PersonaPreviewBox(props: { text: string; showHint?: boolean }) {
  const { showHint = true } = props;
  const styles = useFieldStyles();
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) renderStaticMarkdown(ref.current, props.text);
  }, [props.text]);
  const empty = props.text.trim() === '';
  return (
    <div className={styles.previewWrap}>
      <div
        ref={ref}
        data-persona-preview
        className={mergeClasses(
          styles.personaPlain,
          empty && styles.personaEmpty,
          styles.personaMarkdown,
        )}
        // 场景线挖空底按所在表面行内注入：展示态直接落在 DialogSurface（默认
        // bg1，对比度守卫的配对依据同源），原静态类按 bg2 定值会出异色矩形；
        // as 断言理由同 PreviewBox
        style={{ '--cv-scene-line-bg': tokens.colorNeutralBackground1 } as CSSProperties}
      />
      {empty && showHint ? (
        <Text className={styles.personaHint}>{t('characters.personaPlaceholder')}</Text>
      ) : null}
    </div>
  );
}

/** 出场动画字段：风格下拉 + 播一次预览 + 渲染框。 */
export function PerformanceField(props: {
  renderStyle: string;
  onStyleChange: (value: string) => void;
  onPlay: () => void;
  previewRef: (node: HTMLDivElement | null) => void;
  previewed: boolean;
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  const selectedStyle = ANIM_STYLES.find((s) => s.id === props.renderStyle);
  return (
    <>
      <div className={styles.row}>
        <Dropdown
          className={styles.grow}
          value={selectedStyle ? selectedStyle.label : props.renderStyle}
          selectedOptions={selectedStyle ? [selectedStyle.id] : []}
          onOptionSelect={(_, d) => props.onStyleChange(d.optionValue ?? '')}
          aria-label={t('characters.renderStyle')}
        >
          {ANIM_STYLES.map((s) => (
            <Option key={s.id} value={s.id} text={s.label}>
              {s.label} · {s.id}
            </Option>
          ))}
        </Dropdown>
        <Button onClick={props.onPlay}>{t('characters.preview')}</Button>
      </div>
      <PreviewBox previewRef={props.previewRef} previewed={props.previewed} />
    </>
  );
}

/** 模型覆写折叠段（双层级 2026-09-09）：服务 + 该服务的模型下拉，留空跟随全局。
 *  旧数据里的 baseUrl/apiKey 覆写键不再提供输入框（连接信息归属服务级），但
 *  parse/serialize 对未知/遗留键原样保留，编辑往返不丢失。 */
export function OverrideSection(props: {
  open: boolean;
  onToggle: () => void;
  override: ModelOverrideFields;
  onOverrideChange: (
    update: (current: ModelOverrideFields) => ModelOverrideFields,
  ) => void;
  providers: ProviderDto[];
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  const selectedProvider = props.providers.find((p) => p.id === props.override.providerId);
  const models = selectedProvider?.models ?? [];
  // 存量覆写里的模型名不在所选服务列表（服务改配/换服务）→ 追加为额外选项，
  // 避免下拉显示成"跟随全局"却实际覆写着旧值。
  const staleModel =
    props.override.model !== '' && !models.includes(props.override.model)
      ? props.override.model
      : null;
  return (
    <div className={styles.field}>
      <button
        type="button"
        className={styles.collapseBtn}
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <ChevronRight20Regular
          className={mergeClasses(styles.chevron, props.open && styles.chevronOpen)}
        />
        <Text size={300} weight="semibold">
          {t('characters.modelOverride')}
        </Text>
        <Text size={200}>{t('characters.overrideHint')}</Text>
      </button>
      {props.open ? (
        <div className={styles.collapseBody}>
          <label className={styles.field}>
            <Text size={200}>{t('characters.provider')}</Text>
            <Dropdown
              value={selectedProvider ? selectedProvider.name : t('characters.followGlobal')}
              selectedOptions={[props.override.providerId]}
              onOptionSelect={(_, d) =>
                props.onOverrideChange((o) => ({ ...o, providerId: d.optionValue ?? '' }))
              }
              aria-label={t('characters.provider')}
            >
              <Option value="" text={t('characters.followGlobal')}>
                {t('characters.followGlobal')}
              </Option>
              {props.providers.map((p) => (
                <Option key={p.id} value={p.id} text={p.name}>
                  {p.name} · {p.id}
                </Option>
              ))}
            </Dropdown>
          </label>
          <label className={styles.field}>
            <Text size={200}>{t('characters.model')}</Text>
            <Dropdown
              value={props.override.model === '' ? t('characters.followGlobal') : props.override.model}
              selectedOptions={[props.override.model]}
              onOptionSelect={(_, d) =>
                props.onOverrideChange((o) => ({ ...o, model: d.optionValue ?? '' }))
              }
              aria-label={t('characters.model')}
            >
              <Option value="" text={t('characters.followGlobal')}>
                {t('characters.followGlobal')}
              </Option>
              {staleModel ? (
                <Option value={staleModel} text={staleModel}>
                  {staleModel}
                </Option>
              ) : null}
              {models.map((m) => (
                <Option key={m} value={m} text={m}>
                  {m}
                </Option>
              ))}
            </Dropdown>
          </label>
        </div>
      ) : null}
    </div>
  );
}
