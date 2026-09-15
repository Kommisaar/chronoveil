/**
 * 编辑器共享 UI 件（2026-09-09 编辑器重做时抽出）：字段级组件与样式——
 * 预览框、输出动画卡内容、模型覆写行，由 CharacterEditorDialog
 * 排版壳复用。2026-09-13 用户定稿：右侧表单收敛为三张分组设置卡（基础
 * 信息 / 输出动画 / 其他配置），本文件的行级组件改用
 * components/SettingsCard 的行语言（SettingsRow 行 + 行下全宽 cardBody）。
 * 强调色取色器已按字段域拆至 AccentColorPicker（沿用本文件的
 * useFieldStyles）；人设 markdown 预览盒 2026-09-15 下沉
 * components/MarkdownPreviewBox（设置页第二用例）。
 */
import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ANIM_STYLES } from '../../../engine';
import { SettingsDivider, SettingsRow } from '../../../components/SettingsCard';
import { DropdownPushButton } from '../../../components/DropdownPushButton';
import { SegmentedControl } from '../../../components/SegmentedControl';

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
  // 出场动画行控件：风格下拉定宽（行内控制槽右对齐，与基础信息卡行同语言）
  stageSelect: {
    width: '160px',
    minWidth: '0px',
  },
  // 风格「跟随全局|自定义」模式段（与 AnimParamRows 的 modeSegment 同语言，
  // 两文件各持样式，宽度口径一致）
  styleModeSegment: {
    width: '136px',
    minWidth: '0px',
  },
  // 输出动画卡行 1：预览容器满宽贴卡面内距（无标题，空态提示自解释）；
  // 预览按钮挂框下右侧（2026-09-14 用户定稿），S 档留出框与按钮的呼吸空隙
  previewRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: '12px 20px',
  },
  previewActions: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  // 分组卡内行下的全宽内容区（演出预览框 / 覆写下拉）：随卡面 20px 内距，
  // 底部留白到分隔线
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: '0px 20px 12px',
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
    // 悬停与 chip 按钮（subtle 外观）同 token：colorSubtleBackgroundHover。
    // 曾用 NeutralBackground2——深色主题下那是压暗档（grey[12]），与按钮类
    // 悬停的提亮方向相反（2026-09-15 用户定稿对齐）
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    // 按压再深一档，对齐 Fluent subtle 按钮的 :active 反馈
    ':active': { backgroundColor: tokens.colorSubtleBackgroundPressed },
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
  // 人设展示态的预览盒已下沉 components/MarkdownPreviewBox（2026-09-15）：
  // personaPlain / personaEmpty / personaMarkdown / personaHint 四样式随迁。
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
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

/** 预览动画渲染容器 + 空态提示。 */
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

/** 人设 markdown 静态预览：2026-09-15 下沉 components/MarkdownPreviewBox
 * （设置页全局系统提示词预览成为第二用例），IdentityField 直接用下沉件。 */


/** 风格 id → 展示标签；表外遗留串原样回显（不猜别名，与旧下拉一致）。 */
function styleLabelOf(id: string): string {
  return ANIM_STYLES.find((s) => s.id === id)?.label ?? id;
}

/** 输出动画卡内容（2026-09-13 用户定稿独立成卡）：行 1 = 预览（渲染容器
 *  满宽，播一次按钮挂框下右侧），行 2 = 动画样式（模式分段 + 风格下拉）。
 *  风格下拉 2026-09-14 换自绘复刻件 DropdownPushButton（qfluentwidgets
 *  DropDownPushButton/RoundMenu：最大直显行数 + 下拉开合动效），18 风格直显
 *  8 行内滚；同日起风格可跟随全局（null）——模式段切换，跟随时下拉禁用并
 *  展示全局基准（行描述同步「跟随全局 / 自定义」前缀，结构不跳动）。 */
export function PerformanceField(props: {
  renderStyle: string | null;
  onStyleChange: (value: string | null) => void;
  globalStyle: string;
  onPlay: () => void;
  previewRef: (node: HTMLDivElement | null) => void;
  previewed: boolean;
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  // 解构出局部量：跟随态判断的窄化对 props 属性访问不生效，对 const 局部量生效
  const { renderStyle, globalStyle } = props;
  const following = renderStyle === null;
  return (
    <>
      <div className={styles.previewRow}>
        <PreviewBox previewRef={props.previewRef} previewed={props.previewed} />
        <div className={styles.previewActions}>
          <Button onClick={props.onPlay}>{t('characters.preview')}</Button>
        </div>
      </div>
      <SettingsDivider />
      <SettingsRow
        title={t('characters.renderStyle')}
        description={
          following
            ? t('characters.animFollowingGlobal', { value: styleLabelOf(globalStyle) })
            : t('characters.animCustomized', { value: styleLabelOf(renderStyle) })
        }
        control={
          <div className={styles.row}>
            <DropdownPushButton
              className={styles.stageSelect}
              ariaLabel={t('characters.renderStyle')}
              value={renderStyle ?? globalStyle}
              onChange={props.onStyleChange}
              disabled={following}
              maxVisibleItems={8}
              options={ANIM_STYLES.map((s) => ({ value: s.id, label: s.label, detail: s.id }))}
            />
            <SegmentedControl
              className={styles.styleModeSegment}
              ariaLabel={t('characters.renderStyle')}
              value={following ? 'follow' : 'custom'}
              onChange={(v) => props.onStyleChange(v === 'custom' ? (renderStyle ?? globalStyle) : null)}
              options={[
                { value: 'follow', label: t('characters.followGlobal') },
                { value: 'custom', label: t('characters.animModeCustom') },
              ]}
            />
          </div>
        }
      />
    </>
  );
}

/** 模型覆写行 2026-09-14 拆至 OverrideSection.tsx（本文件触及 500 行上限，
 *  且覆写段随温度行独立成概念）；useFieldStyles 仍由本件导出供其复用。 */
