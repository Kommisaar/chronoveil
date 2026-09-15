// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// excerptOf 契约：剥离规则对齐 src/engine/parser.ts 的 markdown-lite 子集
// （详见 excerpt.ts 文件头的逐条对照），此处覆盖任务包 Task-01 点名的场景。
import { describe, expect, it } from 'vitest';
import { excerptOf } from './excerpt';

describe('excerptOf：纯文本与截断', () => {
  it('短文本原样返回（不截断）', () => {
    expect(excerptOf('旧书店的老板', 20)).toBe('旧书店的老板');
  });

  it('超长截断到 maxChars 并追加全角省略号', () => {
    expect(excerptOf('一二三四五', 3)).toBe('一二三……');
  });

  it('恰好等长不加省略号', () => {
    expect(excerptOf('一二三', 3)).toBe('一二三');
  });

  it('换行/连续空白压成单空格并 trim', () => {
    expect(excerptOf('  第一行\n\n  第二行\t\t第三行 ', 50)).toBe('第一行 第二行 第三行');
  });
});

describe('excerptOf：markdown-lite 剥离', () => {
  it('标题：行首 # 标记剥除，正文保留', () => {
    expect(excerptOf('## 出身\n南方港城', 50)).toBe('出身 南方港城');
  });

  it('列表：无序 `- ` 与有序 `数字. ` 标记剥除', () => {
    expect(excerptOf('- 咳嗽时按左胸\n2. 说话简短', 50)).toBe('咳嗽时按左胸 说话简短');
  });

  it('强调：**加粗** 与 *斜体* 标记剥除，正文保留', () => {
    expect(excerptOf('**加粗**与*斜体*并存', 50)).toBe('加粗与斜体并存');
  });

  it('未闭合星号按字面保留（引擎字面回退，ADR-008）', () => {
    expect(excerptOf('他说*着半句话', 50)).toBe('他说*着半句话');
  });

  it('链接取文字，图片整体丢弃', () => {
    expect(excerptOf('见[旧港地图](http://x)与![插图](http://y)注记', 50)).toBe('见旧港地图与注记');
  });

  it('场景线整块丢弃（--- / === / ——）', () => {
    expect(excerptOf('前段\n\n---\n\n后段', 50)).toBe('前段 后段');
    expect(excerptOf('——', 50)).toBe('');
  });

  it('块内正文后的划线是字面文本（x\\n--- 保留，与引擎一致）', () => {
    expect(excerptOf('台词\n---', 50)).toBe('台词 ---');
  });
});

describe('excerptOf：空与纯符号输入', () => {
  it('空串返回空串', () => {
    expect(excerptOf('', 10)).toBe('');
  });

  it('剥后全空白返回空串（调用方用 personaEmpty/worldbookEmpty 兜底）', () => {
    expect(excerptOf('   \n\t  ', 10)).toBe('');
    expect(excerptOf('![封面](http://x)', 10)).toBe('');
  });

  it('纯符号（孤立星号/井号）按字面保留，不误吞', () => {
    expect(excerptOf('*', 10)).toBe('*');
    expect(excerptOf('###无空格井号', 10)).toBe('###无空格井号');
  });
});
