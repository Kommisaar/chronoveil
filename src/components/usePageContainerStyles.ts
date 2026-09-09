// 页面容器统一边距与限宽：设置页限宽 880 且整体居中（maxWidth 含左
// 右 padding 各 64）；角色网格页为「海报墙」（2026-09-09 用户定）：
// 不限宽、随窗加列（列宽下限由各网格自己的 minmax 决定），左右等
// 边距 64（2026-09-09 用户改：放弃 15vw 标题锚定，改对称页边距）。
// 聊天主界面是全幅工作台（自带内部滚动），不走此容器。
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

/** 页面族：决定限宽档位 */
export type PageContainerFamily = 'grid' | 'settings';

const useStyles = makeStyles({
  // 角色卡片网格页（海报墙：不限宽随窗加列，左右等边距）
  grid: {
    padding: `${tokens.spacingVerticalXL} 64px`,
  },
  // 设置两栏卡片页（内容宽上限 880，半宽卡片需容纳 160px 标签列；
  // marginInline 居中，宽窗下两侧留白对称）
  settings: {
    padding: `${tokens.spacingVerticalXL} 64px`,
    maxWidth: 'calc(880px + 128px)',
    marginInline: 'auto',
  },
});

export function usePageContainerStyles(family: PageContainerFamily, enter = true): string {
  const styles = useStyles();
  // 页面内容渐入：视图切换（重挂）时容器整体淡入一次（styles.css 的
  // page-enter 全局类；「减弱动态」由其 no-preference 门控承载）
  return mergeClasses(styles[family], enter && 'page-enter');
}
