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
 *   CharacterEditorDialog 等均未覆写背景）；
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
 * - 海报渐变底（任意 accent 原色直出）无法静态配对，进 UNPAIRABLE（配对不确定
 *   清单），只登记不断言比值，待后续批次决策。
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
  // 活动栏条目（图标+文字标签）：rail 显式 bg1；hover 染 bg1Hover；选中染 bg1Selected
  { file: 'src/app/layout/ActivityBar.tsx', line: 55, style: 'item', token: 'colorNeutralForeground2',
    context: '导航条目（base300 文字 + 20px 图标）', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover', 'colorNeutralBackground1Selected'] },
  // 侧栏收起后的展开钮：显式 bg1（hover 变体见下一条）
  { file: 'src/app/layout/AppShell.tsx', line: 45, style: 'expandBtn', token: 'colorNeutralForeground2',
    context: '展开钮图标（20px）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/AppShell.tsx', line: 51, style: 'expandBtn:hover', token: 'colorNeutralForeground1',
    context: '展开钮悬停态', backgrounds: ['colorNeutralBackground1Hover'] },
  // 新建会话对话框内（DialogSurface 默认 bg1）
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 17, style: 'hint', token: 'colorNeutralForeground3',
    context: '空角色库提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/NewSessionDialog.tsx', line: 85, style: 'dialogHint', token: 'colorNeutralForeground3',
    context: '对话框步骤提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/NewSessionDialog.tsx', line: 112, style: 'sample', token: 'colorNeutralForeground3',
    context: '历法预设样例行', backgrounds: ['colorNeutralBackground1'] },
  // 会话侧栏：inner 显式 bg1；条目 hover bg1Hover / 选中 bg1Selected
  { file: 'src/app/layout/Sidebar.tsx', line: 114, style: 'item', token: 'colorNeutralForeground1',
    context: '会话条目标题', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover', 'colorNeutralBackground1Selected'] },
  // 删除钮 fg3 只出现在透明底常态（hover 整体换红色，palette 红不在本清单）
  { file: 'src/app/layout/Sidebar.tsx', line: 139, style: 'deleteBtn', token: 'colorNeutralForeground3',
    context: '条目删除钮图标（16px）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/Sidebar.tsx', line: 180, style: 'section', token: 'colorNeutralForeground3',
    context: '「会话」分组小标（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/app/layout/Sidebar.tsx', line: 200, style: 'iconBtn', token: 'colorNeutralForeground2',
    context: '头部图标钮（新建/收起，20px）', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover'] },
  { file: 'src/app/layout/Sidebar.tsx', line: 215, style: 'meta', token: 'colorNeutralForeground3',
    context: '条目相对时间/分叉标识（base200）', backgrounds: ['colorNeutralBackground1', 'colorNeutralBackground1Hover', 'colorNeutralBackground1Selected'] },
  { file: 'src/app/layout/Sidebar.tsx', line: 220, style: 'empty', token: 'colorNeutralForeground3',
    context: '空清单提示（base200）', backgrounds: ['colorNeutralBackground1'] },
  // —— components 层 ——
  // 空态宿主两处均为 bg1：ChatView 流（AppShell content）与 CharactersView 页面
  { file: 'src/components/EmptyState.tsx', line: 11, style: 'root', token: 'colorNeutralForeground3',
    context: '跨域空态占位（Text 默认 base300）', backgrounds: ['colorNeutralBackground1'] },
  // —— features/characters（编辑器对话框 = DialogSurface 默认 bg1）——
  { file: 'src/features/characters/editor/pieces.tsx', line: 36, style: 'sectionTitle', token: 'colorNeutralForeground3',
    context: '折叠段小标（base200 semibold）', backgrounds: ['colorNeutralBackground1'] },
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
  { file: 'src/features/characters/editor/pieces.tsx', line: 206, style: 'collapseBtn', token: 'colorNeutralForeground1',
    context: '覆写折叠钮（hover 换品牌色，不在本清单）', backgrounds: ['colorNeutralBackground1'] },
  // —— features/chat（聊天流与账本面板均为显式 bg1）——
  { file: 'src/features/chat/ActivityBar.tsx', line: 39, style: 'hit', token: 'colorNeutralForeground3',
    context: '幕后活动折叠行（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ActivityBar.tsx', line: 62, style: 'panel', token: 'colorNeutralForeground3',
    context: '幕后活动展开轨迹（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ActivityBar.tsx', line: 71, style: 'stepLabel', token: 'colorNeutralForeground2',
    context: '活动步骤本地化标签', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/StreamingMessage.tsx', line: 41, style: 'header', token: 'colorNeutralForeground3',
    context: '流式消息头部角色名占位（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/chat/ledgerPanel.tsx', line: 67, style: 'stateBlock', token: 'colorNeutralForeground3',
    context: '账本加载/错误态（base200）', backgrounds: ['colorNeutralBackground1'] },
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
  // —— features/settings（SettingsCard 显式 bg1；页面容器无底色透到 content bg1）——
  { file: 'src/features/settings/SettingsCard.tsx', line: 42, style: 'icon', token: 'colorNeutralForeground2',
    context: '设置行图标（20px）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/SettingsCard.tsx', line: 50, style: 'desc', token: 'colorNeutralForeground3',
    context: '设置项描述（Text size 200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/SettingsCard.tsx', line: 69, style: 'footerHint', token: 'colorNeutralForeground3',
    context: '卡片底部提示位（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/SettingsView.tsx', line: 99, style: 'empty', token: 'colorNeutralForeground3',
    context: '无 provider 空态（SettingsCard 内）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/SettingsView.tsx', line: 111, style: 'status', token: 'colorNeutralForeground3',
    context: '修改即保存状态行（base200）', backgrounds: ['colorNeutralBackground1'] },
  { file: 'src/features/settings/SettingsView.tsx', line: 116, style: 'hint', token: 'colorNeutralForeground3',
    context: '设置页尾注（base200，页面 bg1）', backgrounds: ['colorNeutralBackground1'] },
];

/** 配对不确定清单：海报渐变底（accent 原色直出 = 任意 hex）无法静态配对。 */
const UNPAIRABLE: readonly { file: string; line: number; style: string; token: string; reason: string }[] = [
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 64, style: 'letter', token: 'colorNeutralForegroundOnBrand',
    reason: '首字直落海报渐变（posterGradientOf：accent 原色直出可为任意色，含全白），无压暗层，最坏情形无下界；默认 6 组深色调色板下白字 ≥6:1，但用户强调色不受约束。待修方向：约束 accent 亮度或加 scrim。' },
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 82, style: 'name', token: 'colorNeutralForegroundOnBrand',
    reason: '名字落在底部黑 scrim（0.65→0 渐变）叠任意 accent 上：以文字上缘最浅处（scrim≈0.52）× 全白 accent 估算 ≈4.3:1，可低于 AA；以 scrim 顶格 0.65 估算 7.0:1。位置相关，无法静态定值。待修方向：scrim 底端加深或名字区加实底。' },
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 94, style: 'check', token: 'colorNeutralForegroundOnBrand',
    reason: '选中对勾位于卡片上部（scrim 覆盖不到），同 letter：任意 accent 底无下界。待修方向：对勾加角标底。' },
  { file: 'src/app/layout/CharacterPickGrid.tsx', line: 106, style: 'roleBadge', token: 'colorNeutralForegroundOnBrand',
    reason: '徽标自带 rgba(0,0,0,0.55) 实底叠任意 accent：全白 accent 最坏合成 #737373，白字 4.74:1 恰过线，但合成值依赖 scrim 不透明度假设，余量过薄（<0.25）。待修方向：徽标底改不透明深色。' },
];

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
    expect(UNPAIRABLE.length, '海报渐变底用点必须显式登记（当前 4 项 OnBrand）').toBeGreaterThan(0);
  });
});
