/**
 * 设置卡片结构件（2026-09-10 用户参照外部截图定稿）：标题栏 + 全宽细分隔
 * 线 + 「图标 | 标题/描述 | 右侧控件」行 + 可选底部动作行（提示左、动作右）。
 * 结构件只管布局与分隔，不承载业务语义。行间分隔线由使用方显式插
 * <SettingsDivider />——griffel 不支持 :first-child 一类选择器，行自身
 * 不画边框；卡片用普通 div 而非 Fluent Card：分隔线要全宽通到卡边，
 * 内距交给分区自己，不值得和 Card 默认内距打架。
 */
import type { ReactNode } from 'react';
import { Text, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    // 分组卡圆角 = borderRadiusLarge（Fluent v9 实测 6px，非 8px；三档圆角
    // 规范中间档：行内 = Medium 4px 见 ProviderCard，页面级卡片表面 = 16px
    // 见 CharacterEditorDialog surface，规范常量 SURFACE_RADIUS_PAGE_CARD
    // 在 src/components/surfaceSpec.ts）
    borderRadius: tokens.borderRadiusLarge,
  },
  header: {
    padding: '14px 20px 12px',
  },
  sep: {
    height: '1px',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralStroke2,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: '12px 20px',
  },
  icon: {
    display: 'flex',
    fontSize: '20px',
    color: tokens.colorNeutralForeground2,
  },
  labels: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  desc: {
    color: tokens.colorNeutralForeground3,
  },
  control: {
    display: 'flex',
    justifyContent: 'flex-end',
    minWidth: 0,
  },
  footer: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: '12px 20px',
  },
  // 底部提示位带 minHeight：状态文字出现/消失时动作按钮不跳位
  footerHint: {
    display: 'flex',
    alignItems: 'center',
    minHeight: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  footerActions: {
    display: 'flex',
    alignItems: 'center',
  },
});

export function SettingsCard(props: {
  title: string;
  children: ReactNode;
  /** 底部动作行：hint 左（常放状态/说明），actions 右（常放主按钮） */
  footer?: { hint?: ReactNode; actions?: ReactNode };
}) {
  const styles = useStyles();
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <Text size={400} weight="semibold">
          {props.title}
        </Text>
      </div>
      <div className={styles.sep} role="presentation" />
      <div className={styles.body}>{props.children}</div>
      {props.footer ? (
        <>
          <div className={styles.sep} role="presentation" />
          <div className={styles.footer}>
            <div className={styles.footerHint}>{props.footer.hint}</div>
            <div className={styles.footerActions}>{props.footer.actions}</div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** 单行：左图标 + 标题/描述两行文字 + 右侧控件（垂直居中） */
export function SettingsRow(props: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
}) {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      <div className={styles.icon}>{props.icon}</div>
      <div className={styles.labels}>
        <Text size={300} weight="semibold">
          {props.title}
        </Text>
        {props.description ? (
          <Text size={200} className={styles.desc}>
            {props.description}
          </Text>
        ) : null}
      </div>
      <div className={styles.control}>{props.control}</div>
    </div>
  );
}

/** 行间细分隔线（全宽） */
export function SettingsDivider() {
  const styles = useStyles();
  return <div className={styles.sep} role="presentation" />;
}
