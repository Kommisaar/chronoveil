/**
 * 人物状态清除确认对话框（FR-012 手动清除，Task-09）：从叙事账本状态行
 * 「清除状态」进入——确认后软删该状态行（ADR-009 墓碑），行立即从账本消失，
 * 后续结算不会恢复该键（结算 prompt 状态集只含在世行）。开关与清除执行都留在
 * 父层（LedgerPanel），本件负责文案与取消 / 确认两钮（清除进行中时双钮禁用）。
 * 失败文案经 error prop 就地显示（错误必须可见，禁止静默）。
 * C1 收编：对话框模板与交互契约（Esc/背板可取消、aria 抑制、动作键样式）
 * 统一落在 ConfirmDialog，本件只做清除特有的正文组装；外部 props 不变。
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { CharacterStateDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';

const useStyles = makeStyles({
  error: {
    display: 'block',
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

export interface ClearStateDialogProps {
  /** 待清除的状态行（正文插值键值）；null = 关闭。 */
  target: CharacterStateDto | null;
  /** 清除请求进行中（双钮禁用，防重复提交）。 */
  clearing: boolean;
  /** 清除失败文案（就地显示）；null = 无。 */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 人物状态清除确认（Task-09）：键值插值文案 + 破坏性确认，错误就地可见。 */
export function ClearStateDialog(props: ClearStateDialogProps) {
  const { target, clearing, error, onCancel, onConfirm } = props;
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('chat.ledger.clearStateDialogTitle')}
      content={
        <>
          {target !== null &&
            t('chat.ledger.clearStateIntro', { key: target.key, value: target.value })}
          {error !== null && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
        </>
      }
      confirmLabel={clearing ? t('chat.ledger.clearing') : t('chat.ledger.clearStateConfirm')}
      cancelLabel={t('sessions.cancel')}
      busy={clearing}
      destructive
      onConfirm={onConfirm}
    />
  );
}
