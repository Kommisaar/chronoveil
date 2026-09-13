/**
 * 会话删除确认对话框（ADR-009 软删除）：文案明示「聊天记录软删除」，从
 * Sidebar 抽出的纯展示件——开关与删除执行留在父层，本件只负责确认文案与
 * 取消/确认两钮（删除进行中双钮禁用）。C1 收编：模板与交互契约（Esc/背板
 * 可取消、aria 抑制、破坏性键红色弱化）统一落在 ConfirmDialog，本件只做
 * 会话删除的文案组装，外部 props 不变。
 */
import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';

export interface SessionDeleteDialogProps {
  /** 待删会话；null = 关闭。 */
  target: SessionSummary | null;
  /** 待删会话展示标题（父层经标题回退逻辑派生，正文插值用）。 */
  targetTitle: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 会话删除确认：文案明示聊天记录软删除（ADR-009）。 */
export function SessionDeleteDialog(props: SessionDeleteDialogProps) {
  const { target, targetTitle, deleting, onCancel, onConfirm } = props;
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('sessions.delete')}
      content={
        target !== null ? t('sessions.deleteBody', { title: targetTitle }) : null
      }
      confirmLabel={t('sessions.deleteConfirm')}
      cancelLabel={t('sessions.cancel')}
      destructive
      busy={deleting}
      onConfirm={onConfirm}
    />
  );
}
