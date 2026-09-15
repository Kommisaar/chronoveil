// 卡面摘录：把 markdown-lite 正文压成一行短文，供角色卡（persona）与世界卡
// （worldbook）的卡面摘要行使用。剥离规则与渲染引擎的语法子集对齐，事实源是
// src/engine/parser.ts（StreamParser，含文件头的支持清单）：
// - 强调 `*斜体*` / `**加粗**`：闭合对剥标记留正文；未闭合的星号按字面保留
//   （引擎同款回退：段落封存/流结束未闭合按字面吐出，ADR-008）；
// - 场景线 `---` / `===` / `——`（parser.ts 的 SCENE_LINE_RE，整「空行分段块」
//   判定）：整体丢弃——引擎渲染为 hr，无正文可摘；
// - 列表标记（行首 `- ` 无序 / `数字. ` 有序，标记只在行首成立）：剥标记留
//   条目文本；引擎会吐 `• ` / `1. ` 前缀文本，摘录里属装饰性噪声，一并省去。
//   `- ` 后随 `-`/`=`（如 `- - -`）在引擎里是场景线候选失败的字面文本
//   （parser.ts 发现 5），不按列表剥。
// 引擎刻意不支持标题/链接/图片/表格（见 parser.ts 文件头），但导入的角色卡
// 常携带完整 markdown，故额外处置（任务包 Task-01 拍板）：
// - ATX 标题行首 `#`…`######` 标记剥除；
// - 链接 `[文字](url)` 取文字；图片 `![alt](url)` 整体丢弃。
// 其余语法（反引号等）引擎按字面渲染，摘录同样按字面保留。
// 落 lib/ 而非 engine/：纯字符串加工、不碰 DOM（engine 层禁 React 但也不背
// 卡面摘要这种 UI 职责，同 relativeTime.ts 先例）。

/** 场景线判定：与 parser.ts 的 SCENE_LINE_RE 同式（空白含换行，划线单一字符连排）。 */
const SCENE_LINE_RE = /^\s*(-{3,}|={3,}|—{2,})\s*$/;

export function excerptOf(text: string, maxChars: number): string {
  const plain = text
    // 换行归一 \r\n → \n（parser.ts push() 同款）：CRLF 输入下空行分块与
    // 场景线判定才与引擎逐位一致
    .replace(/\r\n?/g, '\n')
    // 图片先于链接处理：`![alt](url)` 内含 `[alt](url)`，先剥链接会错取 alt 当正文
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 场景线按空行分段的「块」判定（引擎语义）：块内已有正文再出现划线是
    // 字面文本（x\n--- 保留），纯划线块才整体丢弃。split(/\n{2,}/) 与引擎
    // 的空行分段（nlRun >= 2）一致。
    .split(/\n{2,}/)
    .filter((block) => !SCENE_LINE_RE.test(block))
    .join('\n\n')
    // 标题行首标记（引擎不支持标题，此处为导入卡兼容，见文件头）
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    // 列表标记（行首成立，与引擎一致；无序 `- ` 后随 -/= 是场景线形态不剥，见文件头）
    .replace(/^[ \t]*-(?![ \t]*[-=])[ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // 强调闭合对剥标记（先双星后单星；内容限定无星，未闭合/混合嵌套按字面保留）
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // 所有空白（含全角空格/换行）压成单空格并 trim
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return '';
  // 恰好等长不加省略号；超长截到 maxChars 追加全角省略号（中日文省略号）
  return plain.length > maxChars ? plain.slice(0, maxChars) + '……' : plain;
}
