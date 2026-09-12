/**
 * 叙事账本三段（人物状态 / 场景史 / 调用轨迹）共用的段级骨架样式：
 * 段容器 + 段标题 + 次要小标（groupTitle：状态分组小标、组空省略整组含
 * 标题，段列表空态文案也从众此层级）。三个段组件各自调用本钩子取类，
 * 段骨架的排版约定以此处为单一事实源。
 */
import { makeStyles, tokens } from '@fluentui/react-components';

export const useLedgerSectionStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  // 次要小标：状态分组小标 / 段空态文案
  groupTitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
});
