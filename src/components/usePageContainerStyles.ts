// 页面容器统一边距与限宽（标题锚定机制移植自 relay-harbor 的 25vw；
// 2026-09-08 用户调整为 15vw）：标题起点锚定整窗 15vw 比例位，随窗口
// 等比。chronoveil 的角色/设置页无侧栏，左栏仅活动栏收起态
// 48px，左 padding = 15vw - 48px；右 padding 固定 64（非对称）。
// maxWidth = 15vw - 48 + 内容宽上限 + 64
// （角色网格页 / 设置两栏卡片页均 880），内容宽上限不随窗变。聊天主
// 界面是全幅工作台（自带内部滚动），不走此容器。
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

/** 页面族：决定限宽档位 */
export type PageContainerFamily = 'grid' | 'settings';

const useStyles = makeStyles({
  // 角色卡片网格页（内容宽上限 880）
  grid: {
    padding: `${tokens.spacingVerticalXL} 64px ${tokens.spacingVerticalXL} calc(15vw - 48px)`,
    maxWidth: 'calc(15vw + 896px)',
  },
  // 设置两栏卡片页（内容宽上限 880，半宽卡片需容纳 160px 标签列）
  settings: {
    padding: `${tokens.spacingVerticalXL} 64px ${tokens.spacingVerticalXL} calc(15vw - 48px)`,
    maxWidth: 'calc(15vw + 896px)',
  },
});

export function usePageContainerStyles(family: PageContainerFamily, enter = true): string {
  const styles = useStyles();
  // 页面内容渐入：视图切换（重挂）时容器整体淡入一次（styles.css 的
  // page-enter 全局类；「减弱动态」由其 no-preference 门控承载）
  return mergeClasses(styles[family], enter && 'page-enter');
}
