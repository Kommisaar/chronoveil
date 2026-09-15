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

  it('改名称即上报（无提交动作，改动直传父级表单）', () => {
    renderUi(<FormHarness />);
    const name = screen.getByLabelText('名称');
    fireEvent.change(name, { target: { value: '利维亚的杰洛特' } });
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('利维亚的杰洛特');
  });

  it('称号逐行输入：改值 / 删除 / 添加空行', () => {
    const onTitlesChange = vi.fn();
    renderUi(<FormHarness initialTitles={['布拉维坎的屠夫']} onTitlesChange={onTitlesChange} />);
    const first = screen.getByLabelText('称号 1') as HTMLInputElement;
    expect(first.value).toBe('布拉维坎的屠夫');
    fireEvent.change(first, { target: { value: '利维亚的战士' } });
    expect(onTitlesChange).toHaveBeenLastCalledWith(['利维亚的战士']);
    fireEvent.click(screen.getByRole('button', { name: '添加称号' }));
    expect(onTitlesChange).toHaveBeenLastCalledWith(['利维亚的战士', '']);
    // 删第 0 行：剩空行（空行由载荷侧过滤，UI 允许暂存）
    fireEvent.click(screen.getAllByRole('button', { name: '删除称号' })[0]!);
    expect(onTitlesChange).toHaveBeenLastCalledWith(['']);
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
    expect(document.querySelector('[data-persona-preview]')).toBeTruthy();
    expect(
      document.querySelector('[data-persona-preview]')?.querySelector('.tok.bold')?.textContent,
    ).toBe('加粗');

    // 切编辑：textarea 携带原文
    switchPersonaMode('编辑');
    const textarea = screen.getByLabelText('人设') as HTMLTextAreaElement;
    expect(textarea.value).toBe('**加粗**冷句');
    fireEvent.change(textarea, { target: { value: '改后的人设' } });
    expect(screen.getByLabelText('人设')).toHaveProperty('value', '改后的人设');

    // 切回预览：渲染新文（视图切换不动数据，父级状态即最新）
    switchPersonaMode('预览');
    expect(document.querySelector('[data-persona-preview]')?.textContent).toContain('改后的人设');
    expect(screen.queryByLabelText('人设')).toBeNull();
  });
});
