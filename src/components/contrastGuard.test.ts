// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
/**
 * UI 层中性前景对比度守卫（WCAG AA，engine 同规格）。
 *
 * 背景（审计候选 A3）：UI 层大量小字号 meta/辅助文本用 colorNeutralForeground3，
 * 此前只有引擎侧守卫（src/engine/theme.test.ts 锁语法配色双主题 ≥4.5），UI 层
 * 的 token×背景 组合无护栏——未来把某段文本挪到更浅/更深的表面（或 Fluent
 * 升级改 token 值）都可能无声跌破 AA。本守卫把「UI 层每个中性前景用点 × 其
 * 承载表面」固化成清单，双主题断言 ≥4.5:1（正文线）。
 *
 * 配对依据（表面推断的证据链，静态审计而非渲染实测）：
 * - 页面/聊天流/侧栏/账本面板：各样式类显式 backgroundColor（AppShell.content、
 *   Sidebar.inner、ledgerPanel.panel 等）= colorNeutralBackground1；
 * - 对话框内容：Fluent DialogSurface 默认背景 = colorNeutralBackground1
 *   （@fluentui/react-dialog useDialogSurfaceStyles.styles.raw.js:32 实证；
 *   编辑器抽屉等均未覆写背景）；
 * - hover/选中底（bg1Hover / bg1Selected）、输入类浅底（bg2）、徽标底（bg3）
 *   按样式类显式声明逐条跟入；一个用点出现在多种状态下时全部列入 backgrounds
 *   （每个组合都要达标 = 最保守口径）；
 * - 主题值运行时取自 @fluentui/react-components 再导出的 webLightTheme /
 *   webDarkTheme（AppProviders 的既用主题），不硬编码猜值。
 *
 * 判定口径：全部用点字号 ≤ base300(14px) / 图标 20px，均达不到 WCAG「大文本」
 * （≥18pt 或 ≥14pt bold），一律按正文线 4.5:1 从紧断言（图标从严格计，天然更松）。
 *
 * 维护约定：
 * - file:line 为基准快照 a0a00c0 的审计定位。改动清单内文件导致行号漂移不必改
 *   本测试（完整性检查只锚定「文件仍含该 token」，容忍行漂移）；但**删掉或改名
 *   用点所在样式类/文件**时必须同步更新清单——这正是守卫要抓的失配；
 * - 新增 UI 层 colorNeutralForeground* 用点时在此登记（token、表面、语境）；
 *   未登记的新用点不会被本测试发现（静态清单的固有盲区，review 把关）；
 * - 不达标项进 EXEMPT（豁免清单，键 = 文件:行 样式类×背景×主题），附实测比值
 *   与「待修」标记，修复后移出；EXEMPT 内条目若实测已达标同样判失败（防陈旧豁免）；
 * - 海报渐变底用点无法直接配对时先进 UNPAIRABLE（配对不确定清单）只登记不断言，
 *   落定修复（压暗下限/实底）后转入可配对断言——海报 OnBrand 四用点已于
 *   2026-09-13 按 PICK_SCRIM_ALPHA=0.62 实底修复转入下方 POSTER_ON_BRAND 清单
 *   （组名保留历史，现锚选人卡 CharacterPickGrid）。角色页 2026-09-16 定稿
 *   典藏卡单一形态，对比期海报卡/舞台卡随拍板裁撤：其文字断言组同步移除；
 *   同日转挂典藏卡的 ⋯ 触发器实底芯锚又随角标菜单裁撤（导出移至编辑器
 *   动作行）而移除；
 *   UNPAIRABLE 机制保留待未来不确定配对。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHexColor } from '../engine/theme';

type ThemeObject = typeof webLightTheme;
type ForegroundToken = 'colorNeutralForeground1' | 'colorNeutralForeground2' | 'colorNeutralForeground3';
type BackgroundToken =
  | 'colorNeutralBackground1'
  | 'colorNeutralBackground1Hover'
  | 'colorNeutralBackground1Selected'
  | 'colorNeutralBackground2'
  | 'colorNeutralBackground3';

/** AA 正文线（本清单内无大文本语境，全部从紧按此线） */
const WCAG_AA = 4.5;

const THEMES = { light: webLightTheme, dark: webDarkTheme } as const;

/** 主题对象按 token 名取色值；缺键/非色值直接抛错（清单写错名要炸得响亮） */
function themeColor(theme: ThemeObject, token: ForegroundToken | BackgroundToken): string {
  const value: string | undefined = theme[token];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`主题缺 token 值：${token}（清单 token 名写错或 Fluent 版本变更）`);
  }
  return value;
}

/** 用点条目：file:line 为基准 a0a00c0 审计定位；backgrounds 全部须达标 */
interface UsageEntry {
  file: string;
  line: number;
  /** 样式类/样式对象键（同文件内定位用） */
  style: string;
  token: ForegroundToken;
  /** 内容语境（字号/用途），仅记录，不参与断言 */
  context: string;
  /** 承载表面（含 hover/选中变体；推断依据见各条注释与文件头「配对依据」） */
  backgrounds: readonly BackgroundToken[];
}

/**
 * UI 层 colorNeutralForeground1/2/3 用点全量清单（grep src/ 排除 engine 与测试；
 * fg4 / Inverted 当前无用点）。表面推断依据：类内显式 backgroundColor 直接引用；
 * 透明底/未声明底按最近 painted 祖先取（对话框 = DialogSurface 默认 bg1，
 * 聊天流 = AppShell content bg1，设置页容器无底色透到 content bg1）。
 */
const USAGES: readonly UsageEntry[] = [
  // —— app 层 ——
  // 活动栏条目（图标+文字标签）：rail 显式 bg1。C2 迁移后常态前景由幽灵钮
  // 钩子（useGhostIconButtonStyles root，components 层条目）承载，本文件只剩
  // 悬停前景压回覆写（视觉零变化：原设计悬停只提底色不升前景）
  { file: 'src/app/layout/ActivityBar.tsx', line: 55, style: 'item:hover 覆写', token: 'colorNeutralForeground2',
    context: '导航条目悬停前景压回（常态前景由钩子承载）', backgrounds: ['colorNeutralBackground1Hover', 'colorNeutralBackground1Selected'] },
  // 幽灵图标钮统一外观（C2 收编：AppShell expandBtn 覆写不透明 bg1，
  // Sidebar iconBtn / ActivityBar item 透明底落在宿主 bg1，hover 染 bg1Hover）
  { file: 'src/components/useGhostIconButtonStyles.ts', line: 62, style: 'root', token: 'colorNeutralForeground2',
    context: '幽灵钮统一常态前景（20px 图标）', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover', 'colorNeutralBackground1Selected'] },
  { file: 'src/components/useGhostIconButtonStyles.ts', line: 66, style: 'root:hover', token: 'colorNeutralForeground1',
    context: '幽灵钮悬停前景升阶（expandBtn 悬停态）', backgrounds: ['colorNeutralBackground1Hover'] },
  // 新建会话对话框内（DialogSurface 默认 bg1）
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 17, style: 'hint', token: 'colorNeutralForeground3',
    context: '空角色库提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/NewSessionDialog.tsx', line: 85, style: 'dialogHint', token: 'colorNeutralForeground3',
    context: '对话框步骤提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/NewSessionDialog.tsx', line: 112, style: 'sample', token: 'colorNeutralForeground3',
    context: '历法预设样例行', backgrounds: ['colorNeutralBackground1'] },
  // 会话侧栏（C2/A1 后样式在 useSidebarStyles）：inner 显式 bg1；条目 hover
  // bg1Hover / 选中 bg1Selected
  { file: 'src/app/layout/useSidebarStyles.ts', line: 48, style: 'item', token: 'colorNeutralForeground1',
    context: '会话条目标题', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover', 'colorNeutralBackground1Selected'] },
  // 删除钮 fg3 只出现在透明底常态（hover 整体换红色，palette 红不在本清单）
  { file: 'src/app/layout/useSidebarStyles.ts', line: 64, style: 'deleteBtn', token: 'colorNeutralForeground3',
    context: '条目删除钮图标（16px）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/useSidebarStyles.ts', line: 104, style: 'section', token: 'colorNeutralForeground3',
    context: '「会话」分组小标（base200）', backgrounds: ['colorNeutralBackground1'] },
  // 头部图标钮悬停前景压回（视觉零变化覆写）；常态前景由幽灵钮钩子承载
  { file: 'src/app/layout/useSidebarStyles.ts', line: 115, style: 'iconBtn:hover 覆写', token: 'colorNeutralForeground2',
    context: '头部图标钮（新建/收起）悬停前景压回', backgrounds: ['colorNeutralBackground1Hover'] },
  { file: 'src/app/layout/useSidebarStyles.ts', line: 126, style: 'meta', token: 'colorNeutralForeground3',
    context: '条目相对时间/分叉标识（base200）', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover', 'colorNeutralBackground1Selected'] },
  { file: 'src/app/layout/useSidebarStyles.ts', line: 131, style: 'empty', token: 'colorNeutralForeground3',
    context: '空清单提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  // —— components 层 ——
  // 空态宿主两处均为 bg1：ChatView 流（AppShell content）与 CharactersView 页面
  { file: 'src/components/EmptyState.tsx', line: 11, style: 'root', token: 'colorNeutralForeground3',
    context: '跨域空态占位（Text 默认 base300）', backgrounds: ['colorNeutralBackground1'] },
  // 三态占位块（StateBlock）宿主均为 bg1：页面级（CharactersView/SettingsView
  // 的 AppShell content）、对话框内（CharacterPickGrid 于 DialogSurface 默认 bg1）
  // 与侧栏清单区（root 透明底，宿主 inner bg1）
  { file: 'src/components/StateBlock.tsx', line: 52, style: 'root', token: 'colorNeutralForeground3',
    context: '加载/错误态文案（Text 默认 base300）', backgrounds: ['colorNeutralBackground1'] },
  // —— features/characters（编辑器对话框 = DialogSurface 默认 bg1）——
  // 取色 chip 显式 bg1，hover 染 bg2 不变色
  { file: 'src/features/characters/editor/pieces.tsx', line: 60, style: 'chipTrigger', token: 'colorNeutralForeground2',
    context: '强调色取色器触发钮', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground2'] },
  { file: 'src/features/characters/editor/pieces.tsx', line: 94, style: 'paletteTitle', token: 'colorNeutralForeground3',
    context: '色板面板标题（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/characters/editor/pieces.tsx', line: 129, style: 'paletteListItem', token: 'colorNeutralForeground1',
    context: '色板列表项（裸 button 显式给前景）', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground2'] },
  // 提示叠在预览框（显式 bg2）之上
  { file: 'src/features/characters/editor/pieces.tsx', line: 170, style: 'previewHint', token: 'colorNeutralForeground3',
    context: '演出预览空态提示（base200）', backgrounds: ['colorNeutralBackground2'] },
  // 人设展示态 markdown 加粗：落在 DialogSurface bg1
  { file: 'src/features/characters/editor/pieces.tsx', line: 176, style: 'personaMarkdown .tok.bold', token: 'colorNeutralForeground1',
    context: '人设预览加粗字', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/characters/editor/pieces.tsx', line: 196, style: 'personaHint', token: 'colorNeutralForeground3',
    context: '空人设提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  // —— features/chat（聊天流与账本面板均为显式 bg1）——
  { file: 'src/features/chat/ActivityNotice.tsx', line: 43, style: 'hit', token: 'colorNeutralForeground3',
    context: '幕后活动折叠行（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ActivityNotice.tsx', line: 66, style: 'panel', token: 'colorNeutralForeground3',
    context: '幕后活动展开轨迹（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ActivityNotice.tsx', line: 75, style: 'stepLabel', token: 'colorNeutralForeground2',
    context: '活动步骤本地化标签', backgrounds: ['colorNeutralBackground1'] },
  // 消息卡题头带（2026-09-16 姓名题头化：底缘细线分区、无底面着色）：题头
  // 透明落在卡壳 bg1 上，说话人名 fg1 / 时间 fg3 均按 bg1 配对。旧
  // StreamingMessage.tsx 行内样式用点已随卡壳样式下沉 useMessageCardStyles
  // 迁移，原条目同步移除
  { file: 'src/features/chat/MessageEntry.tsx', line: 57, style: 'speaker', token: 'colorNeutralForeground1',
    context: '消息卡题头说话人名（base300 semibold）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/MessageEntry.tsx', line: 61, style: 'time', token: 'colorNeutralForeground3',
    context: '消息卡题头时间（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/useMessageCardStyles.ts', line: 39, style: 'speaker', token: 'colorNeutralForeground1',
    context: '流式卡题头说话人名（base300 semibold）', backgrounds: ['colorNeutralBackground1'] },
  // ledgerPanel 的 stateBlock 用点已随审计 A1 迁入 StateBlock 承载，本文件不再
  // 有该用点（StateBlock.tsx / useGhostIconButtonStyles.ts 的清单登记归其落地任务）
  { file: 'src/features/chat/ledgerScenes.tsx', line: 54, style: 'sceneMeta', token: 'colorNeutralForeground3',
    context: '场景时间/地点/在场小字（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ledgerScenes.tsx', line: 76, style: 'recapBody', token: 'colorNeutralForeground2',
    context: '桥场回顾正文（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ledgerStates.tsx', line: 27, style: 'stateMarker', token: 'colorNeutralForeground3',
    context: '状态行 · 记号', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ledgerTrace.tsx', line: 36, style: 'sectionMeta', token: 'colorNeutralForeground3',
    context: '轨迹段头会话汇总（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ledgerTrace.tsx', line: 70, style: 'callNo', token: 'colorNeutralForeground3',
    context: '调用行序号（base200）', backgrounds: ['colorNeutralBackground1'] },
  // kind 徽标显式 bg3 底
  { file: 'src/features/chat/ledgerTrace.tsx', line: 80, style: 'kindBadge', token: 'colorNeutralForeground2',
    context: '调用 kind 徽标（base200）', backgrounds: ['colorNeutralBackground3'] },
  { file: 'src/features/chat/ledgerTrace.tsx', line: 99, style: 'callMeta', token: 'colorNeutralForeground3',
    context: '调用元信息 IN/OUT/耗时（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ledgerTrace.tsx', line: 119, style: 'detailLabel', token: 'colorNeutralForeground3',
    context: '展开详情小标（base200 semibold）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ledgerTrace.tsx', line: 124, style: 'detailBody', token: 'colorNeutralForeground2',
    context: '展开详情正文（base200）', backgrounds: ['colorNeutralBackground1'] },
  // 请求消息容器显式 bg2 底：role 分色三支中性前景全部对 bg2 配对
  { file: 'src/features/chat/ledgerTrace.tsx', line: 163, style: 'roleSystem', token: 'colorNeutralForeground3',
    context: '请求消息 system 灰斜体（base200）', backgrounds: ['colorNeutralBackground2'] },
  { file: 'src/features/chat/ledgerTrace.tsx', line: 169, style: 'roleAssistant', token: 'colorNeutralForeground1',
    context: '请求消息 assistant 正文（base200）', backgrounds: ['colorNeutralBackground2'] },
  // 账本开关钮的 foreground 用点已随审计 C2 迁入 useGhostIconButtonStyles 统一
  // 规格，本文件只留排版（钩子文件的清单登记归其落地任务）
  { file: 'src/features/chat/useChatViewStyles.ts', line: 76, style: 'msgHeader', token: 'colorNeutralForeground3',
    context: '消息行时间戳等 meta（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/useChatViewStyles.ts', line: 86, style: 'msgSpeakerUser', token: 'colorNeutralForeground3',
    context: '用户位角色名（base200 semibold）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/useChatViewStyles.ts', line: 102, style: 'reasoning', token: 'colorNeutralForeground3',
    context: '思考过程收拢块（base200）', backgrounds: ['colorNeutralBackground1'] },
  // 引擎场景线 ✦ 记号色：挖空底 = 同对象 --cv-scene-line-bg = bg1
  { file: 'src/features/chat/useChatViewStyles.ts', line: 168, style: "engineThemeVars['--cv-scene-line-mark']", token: 'colorNeutralForeground3',
    context: '引擎场景线 ✦ 记号', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/useLedgerSectionStyles.ts', line: 19, style: 'sectionTitle', token: 'colorNeutralForeground2',
    context: '账本段标题（base200 semibold）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/useLedgerSectionStyles.ts', line: 24, style: 'groupTitle', token: 'colorNeutralForeground3',
    context: '状态分组小标/段空态（base200）', backgrounds: ['colorNeutralBackground1'] },
  // —— components/SettingsCard（自 features/settings 下沉；显式 bg1，页面容器
  // 无底色透到 content bg1）——
  { file: 'src/components/SettingsCard.tsx', line: 42, style: 'icon', token: 'colorNeutralForeground2',
    context: '设置行图标（20px）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/components/SettingsCard.tsx', line: 50, style: 'desc', token: 'colorNeutralForeground3',
    context: '设置项描述（Text size 200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/components/SettingsCard.tsx', line: 69, style: 'footerHint', token: 'colorNeutralForeground3',
    context: '卡片底部提示位（base200）', backgrounds: ['colorNeutralBackground1'] },
  // 服务卡 2026-09-14 照参考稿重排后，ProvidersCard 旧 empty/status 两 fg3 用
  // 点随样式删除/改红字载体而消失（条目同步摘除）；重排后的中性前景新用点在
  // 下方 features/settings 分组登记。（各卡 issues 红字走 colorPaletteRedForeground1，
  // 不属本守卫的中性前景口径。）
  // —— features/settings（服务卡清单-详情重排；页面容器无底色透到 content bg1，
  // 清单项悬停 bg1Hover / 选中 bg1）——
  { file: 'src/features/settings/ProvidersCard.tsx', line: 56, style: 'navItem', token: 'colorNeutralForeground1',
    context: '服务清单项名称（base300，透明底落 bg1，选中态描边盒 bg1）', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover'] },
  { file: 'src/features/settings/ProviderCard.tsx', line: 62, style: 'title', token: 'colorNeutralForeground1',
    context: '详情头服务名大标题（base500 semibold，大文本 3:1 档）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/ProviderCard.tsx', line: 92, style: 'fieldLabel', token: 'colorNeutralForeground2',
    context: '竖排字段标签（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/ProviderCard.tsx', line: 81, style: 'headDelete', token: 'colorNeutralForeground3',
    context: '详情头删除钮图标（16px，悬停染红，palette 红不在本清单）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/ProviderCard.tsx', line: 142, style: 'modelsEmpty', token: 'colorNeutralForeground3',
    context: '空模型列表虚线提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/AddProviderForm.tsx', line: 47, style: 'title', token: 'colorNeutralForeground1',
    context: '新增表单大标题（base500 semibold，大文本 3:1 档）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/AddProviderForm.tsx', line: 50, style: 'desc', token: 'colorNeutralForeground2',
    context: '新增表单描述（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/AddProviderForm.tsx', line: 60, style: 'fieldLabel', token: 'colorNeutralForeground2',
    context: '竖排字段标签（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/AddProviderForm.tsx', line: 98, style: 'modelsEmpty', token: 'colorNeutralForeground3',
    context: '空模型列表虚线提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/AddProviderForm.tsx', line: 117, style: 'footerHint', token: 'colorNeutralForeground3',
    context: '底部「至少添加一个模型」提示（base200）', backgrounds: ['colorNeutralBackground1'] },
];

/** 配对不确定清单（当前为空）：海报渐变底等无法静态定值配对的用点先进此处
 *  只登记不断言，落定修复后转入可配对断言（海报 OnBrand 四用点的转移先例
 *  见 POSTER_ON_BRAND）。 */
const UNPAIRABLE: readonly { file: string; line: number; style: string; token: string; reason: string }[] = [];

/**
 * 选人卡 OnBrand 文字用点（组名留 2026-09-13 自 UNPAIRABLE 修复转入时的
 * 历史叫法，现锚 CharacterPickGrid）：
 * CharacterPickGrid 迷你海报卡的 colorNeutralForegroundOnBrand（OnBrand 双主题
 * 均为 #ffffff，运行时读主题不硬编码）原本直落任意 accent 渐变，用户强调色
 * 原色直出（posterGradientOf 不压暗）可为纯白 → 最坏情形无下界。修复 = 四个
 * 承载元素全部挂 rgba(0,0,0,0.62) 黑实底（PICK_SCRIM_ALPHA，与源文件常量互指）：
 * - name：底部名字条实底（渐变 scrim 只剩视觉过渡职能）；
 * - letter：居中首字徽标（圆形实底，aria-hidden 装饰冗余仍按可读文本配对）；
 * - check：右上角选中对勾角标（实底，同 roleBadge 形态）；
 * - roleBadge：左上角扮演位徽标（原 0.55 → 共享下限 0.62）。
 *
 * 配对数学（最坏合成推导，配对 = 文字色 × 最坏合成背景 ≥4.5）：
 * - 最坏背景 = 纯白 accent #ffffff：合成灰随背景通道值单调，白色使合成最亮；
 * - 合成 = 背景 × (1 − 0.62) 黑实底 → 每通道 255 × 0.38 = 96.9，向上取整
 *   97（取整方向保守：背景更亮 → 对比更低）；
 * - sRGB 相对亮度(97) ≈ 0.1193 → 白字对比 = (1.0+0.05)/(0.1193+0.05) ≈ 6.19
 *   ≥ 4.5（AA 正文线，留 1.7 余量；0.55 档仅 4.76 故弃）；
 * - 实底叠 scrim 时总压暗 = 1 − (1−0.62)(1−s) ≥ 0.62（s ∈ [0,1]），下限不破。
 *
 * 常量名说明：本常量配对的是选人卡（CharacterPickGrid 的 PICK_SCRIM_ALPHA），
 * 2026-09-13 自 POSTER_SCRIM_FLOOR 改名以贴实际管辖面。0.62 家族的其余锚
 * 均已随拍板退役：典藏卡 ⋯ 触发器（2026-09-16 角标菜单裁撤）与世界满幅卡
 * WORLD_BLEED_SCRIM_ALPHA（同日世界页「只保留这一版」定稿裁撤）——现余
 * pick 单锚；同形制再登场时按各自锚组的 git 历史重建。
 */
const PICK_SCRIM_FLOOR = 0.62;

const POSTER_ON_BRAND: readonly { file: string; line: number; style: string; context: string }[] = [
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 77, style: 'letter', context: '居中首字徽标（圆形实底）' },
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 106, style: 'name', context: '底部名字条实底' },
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 121, style: 'check', context: '右上角选中对勾角标（实底）' },
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 134, style: 'roleBadge', context: '左上角扮演位徽标（实底）' },
];

/**
 * 典藏卡 ⋯ 触发器图标锚（2026-09-16 自海报卡组转挂，同日随角标菜单裁撤
 * 移除——「导出按钮放到删除旁边」拍板后触发器不复存在，scrim 机制及
 * 交互态覆写锚一并退场；若将来卡面再挂恒白图形于身份色面上，按本文件
 * git 历史同形态重建锚组）。
 */

/**
 * 世界满幅卡文字用点锚（2026-09-15 Task-05 新增，2026-09-16 随世界页
 * 「只保留这一版」拍板裁撤）：WorldFullBleedCard 与名册行一并退役、卡面
 * 风格切换器拆除后满幅形态无消费方，WORLD_BLEED_SCRIM_ALPHA（0.62 实底）/
 * WORLD_BLEED_META_TEXT_ALPHA（0.8 次级白）两常量与本守卫组随之移除，
 * 0.62 家族收敛为 pick 单锚（见 PICK_SCRIM_FLOOR 注释）。若将来再挂
 * 「恒白文字 × 深色实底」形制，按本文件 git 历史同形态重建锚组。
 */

/**
 * 豁免清单（当前为空：基准 a0a00c0 实测全部可配对组合双主题 ≥4.5）。
 * 键格式：`文件:行 样式类×背景token×主题`；每项注释附实测比值与待修说明。
 * 断言口径：比值 <4.5 且不在本清单 = 失败；在清单但实测已达标 = 失败（防陈旧豁免）。
 */
const EXEMPT: ReadonlySet<string> = new Set([]);

/** 用点定位键（与豁免清单键的前缀部分一致） */
function cite(entry: UsageEntry): string {
  return `${entry.file}:${entry.line} ${entry.style}`;
}

/** 单个 用点×背景×主题 的断言键 */
function pairKey(entry: UsageEntry, bg: BackgroundToken, themeName: string): string {
  return `${cite(entry)}×${bg}×${themeName}`;
}

function ratioOf(theme: ThemeObject, fg: ForegroundToken, bg: BackgroundToken): number {
  const fgRgb = parseHexColor(themeColor(theme, fg));
  const bgRgb = parseHexColor(themeColor(theme, bg));
  if (fgRgb === null || bgRgb === null) {
    throw new Error(`token 值非 #rrggbb：${fg}=${themeColor(theme, fg)} / ${bg}=${themeColor(theme, bg)}`);
  }
  return contrastRatio(fgRgb, bgRgb);
}

/** 读清单引用的源文件；文件不存在时 readFileSync 抛 ENOENT（即存在性断言） */
function readSource(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

describe('UI 层中性前景对比度守卫（WCAG AA，engine 同规格）', () => {
  it('每个用点的 token×背景组合双主题全部 ≥4.5:1（或显式豁免）', () => {
    const violations: string[] = [];
    for (const entry of USAGES) {
      for (const bg of entry.backgrounds) {
        for (const [themeName, theme] of Object.entries(THEMES)) {
          const ratio = ratioOf(theme, entry.token, bg);
          const key = pairKey(entry, bg, themeName);
          if (ratio < WCAG_AA && !EXEMPT.has(key)) {
            violations.push(`${key} = ${ratio.toFixed(2)}:1 < ${WCAG_AA}（${entry.token}，${entry.context}）`);
          }
        }
      }
    }
    expect(violations, `共 ${violations.length} 项不达标：\n${violations.join('\n')}`).toEqual([]);
  });

  it('豁免清单不得含已达标项（修复后须移出，防陈旧豁免）', () => {
    const stale: string[] = [];
    for (const entry of USAGES) {
      for (const bg of entry.backgrounds) {
        for (const [themeName, theme] of Object.entries(THEMES)) {
          const key = pairKey(entry, bg, themeName);
          if (EXEMPT.has(key) && ratioOf(theme, entry.token, bg) >= WCAG_AA) {
            stale.push(key);
          }
        }
      }
    }
    expect(stale, '以下豁免项实测已达标，应从 EXEMPT 移出').toEqual([]);
  });

  it('清单完整性：用点键唯一，引用文件仍存在且仍含对应 token', () => {
    const keys = USAGES.map(cite);
    expect(new Set(keys).size, '清单内 文件:行 样式类 不得重复').toBe(keys.length);
    for (const entry of USAGES) {
      // readSource 对已删除/改名的文件抛 ENOENT，即「用点被移动/删除需同步清单」
      const source = readSource(entry.file);
      expect(source, `文件已无 ${entry.token} 用点（用点被删除需同步清单）：${entry.file}`).toContain(entry.token);
    }
  });

  it('配对不确定清单：条目仍存在且仍含对应 token（修复或决策时同步）', () => {
    for (const entry of UNPAIRABLE) {
      const source = readSource(entry.file);
      expect(source, `文件已无 ${entry.token} 用点：${entry.file}`).toContain(entry.token);
    }
  });

  it('海报 OnBrand 用点：源文件仍持压暗下限常量，OnBrand × 最坏合成背景双主题 ≥4.5', () => {
    // 完整性锚（静态清单惯例，不跨模块 import 源码）：源文件仍含共享常量
    // PICK_SCRIM_ALPHA = 0.62 与 OnBrand 用点（改动需同步 PICK_SCRIM_FLOOR）
    for (const entry of POSTER_ON_BRAND) {
      const source = readSource(entry.file);
      expect(source, `文件已无 OnBrand 用点（需同步 POSTER_ON_BRAND 清单）：${entry.file}`).toContain('colorNeutralForegroundOnBrand');
      expect(source, `压暗下限常量被移除或改值（需同步 PICK_SCRIM_FLOOR）：${entry.file}`).toContain('PICK_SCRIM_ALPHA = 0.62');
    }
    // 最坏合成背景：纯白 accent × (1 − 0.62) 黑实底，通道向上取整保守
    const channel = Math.ceil(255 * (1 - PICK_SCRIM_FLOOR));
    const worst: [number, number, number] = [channel, channel, channel];
    const failures: string[] = [];
    for (const [themeName, theme] of Object.entries(THEMES)) {
      const fgHex: string | undefined = theme['colorNeutralForegroundOnBrand'];
      if (typeof fgHex !== 'string' || fgHex === '') {
        throw new Error(`主题缺 token 值：colorNeutralForegroundOnBrand（${themeName}）`);
      }
      const fg = parseHexColor(fgHex);
      if (fg === null) throw new Error(`token 值非 #rrggbb：colorNeutralForegroundOnBrand=${fgHex}`);
      const ratio = contrastRatio(fg, worst);
      if (ratio < WCAG_AA) {
        failures.push(`海报 OnBrand × 最坏合成 ${themeName} = ${ratio.toFixed(2)}:1 < ${WCAG_AA}`);
      }
    }
    expect(failures, `共 ${failures.length} 项不达标：\n${failures.join('\n')}`).toEqual([]);
  });
});
