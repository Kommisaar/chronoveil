/**
 * 会话分叉确认对话框（时间线分叉，Task-44）：从叙事账本场景行「从此分叉」
 * 进入——输入新会话标题（默认「原标题（分叉）」，由父层派生填入）并确认。
 * 开关、标题输入值与分叉执行都留在父层（LedgerPanel），本件负责文案、输入
 * 框与取消 / 确认两钮（分叉进行中或标题为空时禁用确认）。失败文案经 error
 * prop 就地显示（错误必须可见，禁止静默）。
 * C1 收编：对话框模板与交互契约（Esc/背板可取消、aria 抑制、动作键样式）
 * 统一落在 ConfirmDialog，本件只做分叉特有的正文组装；外部 props 不变。
 */
import { Input, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { SceneDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';

const useStyles = makeStyles({
  titleField: {
    display: 'block',
    marginTop: tokens.spacingVerticalS,
  },
  error: {
    display: 'block',
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

export interface ForkSessionDialogProps {
  /** 分叉锚点场（正文插值场号）；null = 关闭。 */
  target: SceneDto | null;
  /** 标题输入框当前值（受控，父层持有）。 */
  title: string;
  onTitleChange: (value: string) => void;
  /** 分叉请求进行中（双钮禁用，防重复提交）。 */
  forking: boolean;
  /** 分叉失败文案（就地显示）；null = 无。 */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 会话分叉确认（Task-44）：标题输入 + 场号插值文案，错误就地可见。 */
export function ForkSessionDialog(props: ForkSessionDialogProps) {
  const { target, title, onTitleChange, forking, error, onCancel, onConfirm } = props;
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('chat.ledger.forkDialogTitle')}
      content={
        <>
          {target !== null &&
            t('chat.ledger.forkIntro', {
              scene: t('chat.ledger.sceneNo', { index: target.idx }),
            })}
          <Input
            className={styles.titleField}
            aria-label={t('chat.ledger.forkTitleField')}
            placeholder={t('chat.ledger.forkTitleField')}
            value={title}
            disabled={forking}
            onChange={(_, data) => onTitleChange(data.value)}
          />
          {error !== null && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
        </>
      }
      confirmLabel={forking ? t('chat.ledger.forking') : t('chat.ledger.forkConfirm')}
      cancelLabel={t('sessions.cancel')}
      busy={forking}
      confirmDisabled={title.trim().length === 0}
      onConfirm={onConfirm}
    />
  );
}
