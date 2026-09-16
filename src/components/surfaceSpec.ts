/**
 * 表面圆角层级规范（审计 A2 归档）：仓库内「页面级卡面」统一 16px 大圆角，
 * 不落 Fluent token 阶梯——token 阶梯顶档 borderRadiusXLarge 仅 8px，在 880px
 * 级的大卡面上视觉过方（CharacterEditorDialog 定稿时已验证），故页面级卡面
 * 脱离 token 阶梯，以此常量为单一事实源。
 *
 * 本文件同时收口溢出滚动带的细滚动条规格（THIN_SCROLLBAR，见文件尾）。
 *
 * 两档语义（层级不同属合理差异，不得混用）：
 * - 页面级卡面 = 16px（本常量）：用户视作「一整块面板/卡片」的顶层表面——
 *   两页编辑器对话框面板、列表卡面、聊天输入卡。五处消费点（互指，改值
 *   须同步；2026-09-16 角色页定稿典藏卡：裁撤的海报/舞台卡移出、典藏卡
 *   补入；同日世界页「只保留这一版」定稿：满幅卡移出）：
 *   · src/features/characters/CharacterEditorDialog.tsx（surface，定稿注释在该处）
 *   · src/features/characters/CharacterCollectCard.tsx（卡面，含 --fui-Card--border-radius 联动）
 *   · src/features/chat/useChatViewStyles.ts（composerCard）
 *   · src/features/worlds/WorldEditorDialog.tsx（surface）
 *   · src/features/worlds/WorldGalleryCard.tsx（gallery 卡面）
 * - 分组卡 = tokens.borderRadiusLarge（Fluent v9 实际值 6px，非 8px）：卡片内
 *   再分组的次级卡面（SettingsView 的 SettingsCard），贴 token 阶梯不另立常量。
 *
 * 小件（按钮/徽标/行内块）继续直接用 Fluent token 阶梯：Small 2px / Medium 4px /
 * Circular 全圆，与主题联动，不经本文件。
 */
import { tokens } from '@fluentui/react-components';

export const SURFACE_RADIUS_PAGE_CARD = '16px';

/**
 * 溢出滚动带的细滚动条（WebView2 Chromium 支持 scrollbar-width/color）：默认
 * 粗滚动条在圆角面板与卡流右缘太重。滑轨色走全仓分隔线单一用色
 * colorNeutralStroke2、轨道透明。消费方式：makeStyles 规则内展开（Griffel
 * 处理前的纯对象合并，as const 字面量类型满足 Griffel 属性校验）。
 * 消费点（互指，改值须同步）：
 * · src/features/characters/CharacterEditorDialog.tsx（content 滚动带）
 * · src/features/worlds/WorldEditorDialog.tsx（content 滚动带）
 * · src/features/chat/useChatViewStyles.ts（stream 聊天流）
 */
export const THIN_SCROLLBAR = {
  scrollbarWidth: 'thin',
  scrollbarColor: `${tokens.colorNeutralStroke2} transparent`,
} as const;
