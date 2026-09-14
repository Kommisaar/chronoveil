// 添加/编辑模型对话框（UI-003，2026-09-14 模型元数据化；参考外部管理面板）：
// 模型 ID + 上下文窗口 + 最大输出 Token + 输入/输出模态。文本模态恒选（本应用
// 的对话链路只消费文本，锁死不可取消；图片/视频/PDF 为向前预留的可勾选项），
// 输出类型现阶段恒为文本。对话框只回传 ModelSpecDto，落 draft 由父级负责；
// 保存键在模型 ID 为空或数值非法时禁用（数值要求非负整数）。
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Checkbox,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { LockClosed16Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelModality, ModelSpecDto } from '../../api/types';

const useStyles = makeStyles({
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalM,
  },
  fieldLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  // 模态芯片行：勾选框横排
  modalityRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  // 文本模态锁死：禁用勾选 + 锁形图标（可读地说明「不可取消」）
  lockedLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
  },
});

/** 参考稿新增对话框的预填缺省（与 Rust ModelSpec::from_id 缺省同源互指）。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

/** 文本模态恒在（对话链路仅消费文本）；输出模态现阶段恒为文本。 */
const TEXT_ONLY: ModelModality[] = ['text'];

export interface ModelDialogProps {
  open: boolean;
  /** 编辑目标；null = 新增（用缺省值预填）。 */
  initial: ModelSpecDto | null;
  onConfirm: (spec: ModelSpecDto) => void;
  /** 受控开合唯一出口：Esc / 背板 / 取消键统一回传 false。 */
  onOpenChange: (open: boolean) => void;
}

/** 本地可编辑数值字段的解析：空串/非法 → null（保存键禁用，不做静默钳边）。 */
function parseNonNegativeInt(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  return Number(text);
}

export function ModelDialog({ open, initial, onConfirm, onOpenChange }: ModelDialogProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_CONTEXT_WINDOW));
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(DEFAULT_MAX_OUTPUT_TOKENS));
  const [inputTypes, setInputTypes] = useState<ModelModality[]>(TEXT_ONLY);

  // 打开瞬间以 initial 重置表单（编辑回灌；新增回缺省）——对话框内容随开关
  // 重建，避免上一次输入残留。数值字段单位为 K：显示 = 原始 token / 1000，
  // 保存 = 输入 × 1000（非千倍数值会有取整损失，本应用的量纲均为千倍）。
  useEffect(() => {
    if (open) {
      setId(initial?.id ?? '');
      setContextWindow(String(Math.round((initial?.contextWindow ?? DEFAULT_CONTEXT_WINDOW) / 1000)));
      setMaxOutputTokens(String(Math.round((initial?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) / 1000)));
      setInputTypes(initial?.inputTypes ?? TEXT_ONLY);
    }
  }, [open, initial]);

  const parsedContext = parseNonNegativeInt(contextWindow);
  const parsedOutput = parseNonNegativeInt(maxOutputTokens);
  const idValid = id.trim() !== '';
  const valid = idValid && parsedContext !== null && parsedOutput !== null;

  const confirm = () => {
    if (!valid) return;
    onConfirm({
      id: id.trim(),
      contextWindow: parsedContext! * 1000,
      maxOutputTokens: parsedOutput! * 1000,
      inputTypes: inputTypes.length > 0 ? inputTypes : TEXT_ONLY,
      outputTypes: TEXT_ONLY,
    });
    onOpenChange(false);
  };

  const toggleInput = (modality: ModelModality, checked: boolean) => {
    setInputTypes((types) =>
      checked ? [...types, modality] : types.filter((m) => m !== modality),
    );
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>
            {initial === null ? t('settings.modelDialogAddTitle') : t('settings.modelDialogEditTitle')}
          </DialogTitle>
          <DialogContent>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="model-dialog-id">
                {t('settings.modelId')}
              </label>
              <Input
                id="model-dialog-id"
                value={id}
                placeholder={t('settings.modelIdPlaceholder')}
                aria-invalid={!idValid}
                onChange={(_, d) => setId(d.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="model-dialog-context">
                {t('settings.contextWindow')}
              </label>
              <Input
                id="model-dialog-context"
                type="number"
                min={0}
                step={1}
                value={contextWindow}
                aria-invalid={parsedContext === null}
                onChange={(_, d) => setContextWindow(d.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="model-dialog-max-output">
                {t('settings.maxOutputTokens')}
              </label>
              <Input
                id="model-dialog-max-output"
                type="number"
                min={0}
                step={1}
                value={maxOutputTokens}
                aria-invalid={parsedOutput === null}
                onChange={(_, d) => setMaxOutputTokens(d.value)}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.inputTypes')}</span>
              <div className={styles.modalityRow}>
                <Checkbox
                  checked
                  disabled
                  label={
                    <span className={styles.lockedLabel}>
                      {t('settings.modalityText')}
                      <LockClosed16Regular />
                    </span>
                  }
                />
                <Checkbox
                  checked={inputTypes.includes('image')}
                  label={t('settings.modalityImage')}
                  onChange={(_, d) => toggleInput('image', d.checked === true)}
                />
              </div>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.outputTypes')}</span>
              <div className={styles.modalityRow}>
                <Checkbox
                  checked
                  disabled
                  label={
                    <span className={styles.lockedLabel}>
                      {t('settings.modalityText')}
                      <LockClosed16Regular />
                    </span>
                  }
                />
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              {t('settings.cancel')}
            </Button>
            <Button appearance="primary" disabled={!valid} onClick={confirm}>
              {t('settings.save')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
