// 设置卡片结构件冒烟（2026-09-10 行结构卡片定稿）：SettingsCard 标题/分隔线/
// 底部动作行（可选）、SettingsRow 图标+标题/描述+右侧控件（描述可选）、
// SettingsDivider 独立分隔线。结构件只管布局，断言落在渲染内容与结构存在性。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsCard, SettingsDivider, SettingsRow } from './SettingsCard';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

afterEach(cleanup);

describe('SettingsCard', () => {
  it('标题 + 分区内容 + 结构件头部分隔线', () => {
    const { container } = renderUi(
      <SettingsCard title="节奏">
        <div>行内容</div>
      </SettingsCard>,
    );
    expect(screen.getByText('节奏')).toBeTruthy();
    expect(screen.getByText('行内容')).toBeTruthy();
    // 头部分隔线恰好一条（role="presentation"）
    expect(container.querySelectorAll('[role="presentation"]')).toHaveLength(1);
  });

  it('footer 缺省：不出底部动作行', () => {
    renderUi(
      <SettingsCard title="外观">
        <div>行内容</div>
      </SettingsCard>,
    );
    expect(screen.queryByText('已保存')).toBeNull();
    expect(screen.queryByRole('button', { name: '新建' })).toBeNull();
  });

  it('footer：hint 左（状态文案）、actions 右（动作按钮），追加一条分隔线', () => {
    const { container } = renderUi(
      <SettingsCard
        title="模型服务"
        footer={{
          hint: <span>已保存</span>,
          actions: <button type="button">新建</button>,
        }}
      >
        <div>行内容</div>
      </SettingsCard>,
    );
    expect(screen.getByText('已保存')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建' })).toBeTruthy();
    expect(container.querySelectorAll('[role="presentation"]')).toHaveLength(2);
  });

  it('footer 可只给 hint（actions 省略不炸）', () => {
    renderUi(
      <SettingsCard title="模型服务" footer={{ hint: <span>更改将自动保存</span> }}>
        <div>行内容</div>
      </SettingsCard>,
    );
    expect(screen.getByText('更改将自动保存')).toBeTruthy();
  });
});

describe('SettingsRow', () => {
  it('图标 + 标题 + 描述 + 右侧控件齐全', () => {
    renderUi(
      <SettingsRow
        icon={<svg data-testid="row-icon" />}
        title="主题"
        description="界面配色"
        control={<button type="button">切换</button>}
      />,
    );
    expect(screen.getByTestId('row-icon')).toBeTruthy();
    expect(screen.getByText('主题')).toBeTruthy();
    expect(screen.getByText('界面配色')).toBeTruthy();
    expect(screen.getByRole('button', { name: '切换' })).toBeTruthy();
  });

  it('description 省略：不渲染描述节点，标题/控件不受影响', () => {
    renderUi(
      <SettingsRow
        icon={<svg data-testid="row-icon" />}
        title="标点停顿"
        control={<button type="button">开关</button>}
      />,
    );
    expect(screen.getByText('标点停顿')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开关' })).toBeTruthy();
  });
});

describe('SettingsDivider', () => {
  it('独立渲染一条 presentation 分隔线', () => {
    const { container } = renderUi(
      <div>
        <div>上一行</div>
        <SettingsDivider />
        <div>下一行</div>
      </div>,
    );
    expect(screen.getByText('上一行')).toBeTruthy();
    expect(container.querySelectorAll('[role="presentation"]')).toHaveLength(1);
  });
});
