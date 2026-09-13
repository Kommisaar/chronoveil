/**
 * 确认对话框族统一模板（C1 审计收编）：五处确认对话框（角色丢弃/删除、
 * 会话删除、provider 删除、分叉确认，另含 provider 模型行删除 U4）此前各写
 * 各的 Fluent Dialog 样板——Esc/背板可否关闭、aria 抑制、破坏性按钮强调
 * 各不一致。本组件收口为单一事实源：
 * - Esc / 背板点击 / 取消键统一走 onOpenChange(false)（受控开合唯一出口，
 *   收编前 CharactersView 两处无 onOpenChange，Esc 无法取消）；
 * - DialogSurface aria-describedby={undefined} 族内统一（无 DialogDescription
 *   时抑制 Fluent 的 aria 警告）；
 * - destructive=true：取消键升为主键（安全动作优先聚焦），确认键红色描边
 *   弱化——收编前破坏性确认键一律 appearance="primary"，与安全主键无区分。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';

const useStyles = makeStyles({
  // 破坏性确认键：secondary 底型（描边）上覆红色前景/边框，与品牌色主键区分
  destructiveConfirm: {
    color: tokens.colorPaletteRedForeground1,
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
  },
});

export interface ConfirmDialogProps {
  open: boolean;
  /** 受控开合唯一出口：Esc / 背板 / 取消键统一回传 false，关闭由父层落地。 */
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 正文：字符串或任意节点（如分叉确认的标题输入框 + 就地错误）。 */
  content: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** 破坏性确认：取消键为主键、确认键红色描边弱化（安全动作优先）。 */
  destructive?: boolean;
  /** 进行中：双钮禁用防重复提交（删除请求在途等）。 */
  busy?: boolean;
  /** 仅确认键禁用（前置校验未过：激活占用拦截、标题为空等）。 */
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

/** 确认对话框族统一模板：取消（含 Esc/背板）走 onOpenChange(false)，确认走 onConfirm。 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    onOpenChange,
    title,
    content,
    confirmLabel,
    cancelLabel,
    destructive = false,
    busy = false,
    confirmDisabled = false,
    onConfirm,
  } = props;
  const styles = useStyles();
  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        onOpenChange(data.open);
      }}
    >
      {/* 无 DialogDescription 正文节点，显式 undefined 抑制 Fluent aria 警告 */}
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>{content}</DialogContent>
          <DialogActions>
            <Button
              appearance={destructive ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              className={destructive ? styles.destructiveConfirm : undefined}
              appearance={destructive ? 'secondary' : 'primary'}
              disabled={busy || confirmDisabled}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
