/**
 * 三态占位块（审计 A1 前置）：加载 / 空 / 错误的页面级区块统一形态。
 * 收编对象（消费方接入是后续任务，现状文件只读作设计基准）——收编前各视图
 * 各写各的：加载态有 Spinner tiny + 文案（ledgerPanel）/ 无指示 / 整页空白
 * 三种；错误态有红字 div / Text role="alert" / 账本文案 + 重试钮三种。
 *
 * 设计基准 = ledgerPanel 的加载 / 错误块：加载为 Spinner size="tiny" + 次级
 * 前景文案，错误为文案 + Button size="small" 重试钮；错误容器 role="alert"
 * 使文案即时播报给读屏（对齐 ChatView 发送失败提示的 A1 先例）；空态直接
 * 透传 EmptyState（action 契约即 EmptyStateAction，原样复用不另立类型）。
 *
 * 用法：
 * ```tsx
 * <StateBlock state="loading" label={t('...loading')} />
 * <StateBlock state="empty" label={t('...empty')} action={{ label, onClick, icon? }} />
 * <StateBlock state="error" label={t('...failed')} onRetry={{ label: t('...retry'), onClick }} />
 * ```
 *
 * 布局为占满父容器的垂直居中留白（页面级区块语义，与 EmptyState 的 root
 * 同款 height:100%——同一容器内三态切换不跳布局）；间距全走 Fluent token。
 * 不做动效（占位块保持最简，克制动效属各视图的入场语言）；文案全部由调用方
 * 传入（组件不内置文案，无 i18n 登记点）。
 */
import { Button, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { EmptyState, type EmptyStateAction } from './EmptyState';

export type StateBlockState = 'loading' | 'empty' | 'error';

export interface StateBlockProps {
  state: StateBlockState;
  /** 状态文案（加载说明 / 空态指引 / 错误说明），全由调用方传。 */
  label: string;
  /** empty 态直达动作，原样透传 EmptyState；其他态忽略。 */
  action?: EmptyStateAction | undefined;
  /**
   * error 态重试钮（文案 + 可选图标 + 回调；组件不内置「重试」文案，故不采用
   * onRetry: () => void 形态）。省略 = 只展示错误文案；其他态忽略。
   */
  onRetry?: EmptyStateAction | undefined;
}

const useStyles = makeStyles({
  // 形态对齐 ledgerPanel 的加载/错误块（纵向排列、次级前景、细字、token 间距）
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

/** 三态占位块：loading = Spinner + 文案，error = role="alert" 文案 + 可选重试，empty = EmptyState。 */
export function StateBlock({ state, label, action, onRetry }: StateBlockProps) {
  const styles = useStyles();
  if (state === 'empty') {
    return <EmptyState message={label} action={action} />;
  }
  return (
    <div className={styles.root} role={state === 'error' ? 'alert' : undefined}>
      {state === 'loading' && <Spinner size="tiny" />}
      <Text>{label}</Text>
      {state === 'error' && onRetry !== undefined && (
        <Button
          size="small"
          // 图标可省：条件展开（exactOptionalPropertyTypes 下不可给 Fluent 的
          // icon 槽位显式传 undefined）
          {...(onRetry.icon !== undefined ? { icon: onRetry.icon } : {})}
          onClick={onRetry.onClick}
        >
          {onRetry.label}
        </Button>
      )}
    </div>
  );
}
