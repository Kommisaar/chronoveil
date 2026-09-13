import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { ReactElement } from 'react';

/** 空态直达动作（U5）：图标 + 文案 + 点击行为的声明式描述。 */
export interface EmptyStateAction {
  label: string;
  // Fluent Button 的 icon 槽位收窄到 ReactElement（exactOptionalPropertyTypes
  // 下 ReactNode 过宽），调用方传 Fluent 图标组件的 JSX 即可；可省（Task-05 起
  // StateBlock 原样透传本契约，无图标动作钮合法——账本重试钮先例），渲染时分支
  icon?: ReactElement;
  onClick: () => void;
}

const useStyles = makeStyles({
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    color: tokens.colorNeutralForeground3,
  },
});

/**
 * 跨域共享的空态占位；icon（可选）渲染在文案上方（默认无图标，纯文案布局与
 * 收编前一致；尺寸由调用方选定——Fluent 图标组件自带档位，颜色随 root 的
 * 次级前景）；提供 action 时在文案下方渲染直达动作钮。
 */
export function EmptyState({
  message,
  action,
  icon,
}: {
  message: string;
  // prop 类型显式带 | undefined：exactOptionalPropertyTypes 下 StateBlock 等
  // 调用方持有的「可能为 undefined」值才能原样透传
  action?: EmptyStateAction | undefined;
  icon?: ReactElement | undefined;
}) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      {icon !== undefined && icon}
      <Text>{message}</Text>
      {action !== undefined && (
        <Button
          appearance="primary"
          // icon 可省：条件展开（exactOptionalPropertyTypes 下不可给 Fluent 的
          // icon 槽位显式传 undefined）
          {...(action.icon !== undefined ? { icon: action.icon } : {})}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
