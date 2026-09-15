// 基础信息卡（2026-09-15 常驻编辑重设计）：身份行输入框常驻（无铅笔/对钩/
// Esc 还原机制，改动直接上报父级）、称号逐行增删改、人设独立「预览|编辑」
// 切换（默认渲染预览，切编辑出 textarea）。受控组件用带状态的包装器驱动；
// 其余行（强调色取色器）在 pieces.test.tsx 单独覆盖，此处不重复。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../i18n';
import { IdentityField } from './IdentityField';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

/** 受控包装器：持有身份字段状态并回传，模拟父级表单接线。 */
function FormHarness(props: {
  initialTitles?: string[];
  onTitlesChange?: (value: string[]) => void;
}) {
  const [name, setName] = useState('杰洛特');
  const [titles, setTitles] = useState(props.initialTitles ?? []);
  const [persona, setPersona] = useState('**加粗**冷句');
  return (
    <IdentityField
      name={name}
      onNameChange={setName}
      gender="男"
      onGenderChange={vi.fn()}
      age="百余岁"
      onAgeChange={vi.fn()}
      titles={titles}
      onTitlesChange={(v) => {
        props.onTitlesChange?.(v);
        setTitles(v);
      }}
      persona={persona}
      onPersonaChange={setPersona}
      accentColor={null}
      baseColor="#6b46b8"
      onAccentColorChange={vi.fn()}
      canSave
    />
  );
}

/** 切换人设「预览|编辑」分段。 */
function switchPersonaMode(mode: '预览' | '编辑') {
  const group = screen.getByRole('radiogroup', { name: '人设视图' });
  fireEvent.click(
    [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === mode)!,
  );
}

afterEach(cleanup);

describe('IdentityField 常驻编辑（2026-09-15 重设计）', () => {
  it('身份行输入框常驻：打开即输入态，无重命名/保存按钮', () => {
    renderUi(<FormHarness />);
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('杰洛特');
    expect((screen.getByLabelText('性别') as HTMLInputElement).value).toBe('男');
    expect((screen.getByLabelText('年龄') as HTMLInputElement).value).toBe('百余岁');
    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('名称全宽身份块置顶（2026-09-15 晚间重设计）：先于性别行渲染，label 仍为「名称」', () => {
    renderUi(<FormHarness />);
    const name = screen.getByLabelText('名称');
    // 卡内首个输入是名称（身份首键置顶），性别次级行跟随其后；宽度无法在
    // jsdom 断言（无布局引擎），置顶以文档顺序为准
    expect(
      screen.getByLabelText('性别').compareDocumentPosition(name) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it('称号全宽身份块（Task-07 修正）：性别/年龄行之后、无行标题，group 语义仍在', () => {
    renderUi(<FormHarness />);
    // 称号块弃 SettingsRow 行形态（control 收缩槽溢出缺陷），比照名称块独立
    // 成块；宽度无法在 jsdom 断言（无布局引擎），位置以文档顺序为准。
    // 读屏可达性由 TitlesChips 自带 role=group + aria-label 承担（无可见行标题）
    const titles = screen.getByRole('group', { name: '称号' });
    expect(
      titles.compareDocumentPosition(screen.getByLabelText('性别')) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(
      titles.compareDocumentPosition(screen.getByLabelText('年龄')) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it('改名称即上报（无提交动作，改动直传父级表单）', () => {
    renderUi(<FormHarness />);
    const name = screen.getByLabelText('名称');
    fireEvent.change(name, { target: { value: '利维亚的杰洛特' } });
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('利维亚的杰洛特');
  });

  it('称号行接线 TitlesChips：点添加 → 输入 → Enter，chip 经表单数据流上屏', () => {
    renderUi(<FormHarness initialTitles={['布拉维坎的屠夫']} />);
    // chip 形态（交互细节在 TitlesChips.test.tsx 全覆盖，此处只验证接线）
    expect(screen.getByText('布拉维坎的屠夫')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加称号' }));
    const input = screen.getByPlaceholderText('如：布拉维坎的屠夫');
    fireEvent.change(input, { target: { value: '利维亚的战士' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('利维亚的战士')).toBeTruthy();
  });

  it('canSave=false：卡面底部出名称必填提示', () => {
    renderUi(
      <IdentityField
        name="   "
        onNameChange={vi.fn()}
        gender=""
        onGenderChange={vi.fn()}
        age=""
        onAgeChange={vi.fn()}
        titles={[]}
        onTitlesChange={vi.fn()}
        persona=""
        onPersonaChange={vi.fn()}
        accentColor={null}
        baseColor="#6b46b8"
        onAccentColorChange={vi.fn()}
        canSave={false}
      />,
    );
    expect(screen.getByText('名称必填')).toBeTruthy();
  });
});

describe('IdentityField 人设独立切换（预览|编辑）', () => {
  it('默认预览态：markdown 渲染直插 DOM；切编辑出 textarea，改文即上报；切回预览', () => {
    renderUi(<FormHarness />);
    // 默认渲染预览（引擎静态渲染，加粗进 tok.bold）
    expect(document.querySelector('[data-markdown-preview]')).toBeTruthy();
    expect(
      document.querySelector('[data-markdown-preview]')?.querySelector('.tok.bold')?.textContent,
    ).toBe('加粗');

    // 切编辑：textarea 携带原文
    switchPersonaMode('编辑');
    const textarea = screen.getByLabelText('人设') as HTMLTextAreaElement;
    expect(textarea.value).toBe('**加粗**冷句');
    fireEvent.change(textarea, { target: { value: '改后的人设' } });
    expect(screen.getByLabelText('人设')).toHaveProperty('value', '改后的人设');

    // 切回预览：渲染新文（视图切换不动数据，父级状态即最新）
    switchPersonaMode('预览');
    expect(document.querySelector('[data-markdown-preview]')?.textContent).toContain('改后的人设');
    expect(screen.queryByLabelText('人设')).toBeNull();
  });
});
