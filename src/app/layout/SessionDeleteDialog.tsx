/**
 * 会话删除确认对话框（ADR-009 软删除）：文案明示「聊天记录软删除」，从
 * Sidebar 抽出的纯展示件（行为零变化）——开关与删除执行留在父层，本件只
 * 负责确认文案与取消/确认两钮（删除进行中双钮禁用）。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '../../api/types';

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
    <Dialog
      open={target !== null}
      onOpenChange={(_, data) => {
        if (!data.open) onCancel();
      }}
    >
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>{t('sessions.delete')}</DialogTitle>
          <DialogContent>
            {target !== null ? t('sessions.deleteBody', { title: targetTitle }) : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={deleting} onClick={onCancel}>
              {t('sessions.cancel')}
            </Button>
            <Button appearance="primary" disabled={deleting} onClick={onConfirm}>
              {t('sessions.deleteConfirm')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
