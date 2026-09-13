import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { ReactElement } from 'react';

/** 空态直达动作（U5）：图标 + 文案 + 点击行为的声明式描述。 */
export interface EmptyStateAction {
  label: string;
  // Fluent Button 的 icon 槽位收窄到 ReactElement（exactOptionalPropertyTypes
  // 下 ReactNode 过宽），调用方传 Fluent 图标组件的 JSX 即可
  icon: ReactElement;
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

/** 跨域共享的空态占位；提供 action 时在文案下方渲染直达动作钮。 */
export function EmptyState({ message, action }: { message: string; action?: EmptyStateAction }) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Text>{message}</Text>
      {action !== undefined && (
        <Button appearance="primary" icon={action.icon} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
