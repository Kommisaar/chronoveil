// 新增供应商表单（UI-003「模型服务」，2026-09-14 照参考稿新增）：与详情编辑
// 分离的缓冲视图——名称 / Base URL / API Key / API 格式 / 模型列表先在本地表单
// 态里填，点「添加供应商」且校验通过才经 onConfirm 交给父级入草稿（随即被
// 修改即保存链路落盘）。此前「先追加空 provider 再改」的路径会把非法中间态
// 写进草稿、靠页级闸门挡落盘；缓冲表单让非法态根本不进草稿。底部提示与主钮
// 的禁用态照参考稿：未达校验时提示「添加供应商前，请至少添加一个模型。」。
import {
  Button,
  Input,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add16Regular,
  Delete16Regular,
  Info16Regular,
  Pen16Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelSpecDto, ProviderApi, ProviderDto } from '../../api/types';
import { DropdownPushButton } from '../../components/DropdownPushButton';
import {
  isValidHttpUrl,
  PROVIDER_PROTOCOLS,
  PROTOCOL_LABEL_KEYS,
} from './preferences';
import { ModelDialog } from './ModelDialog';

/** 协议 → Base URL 占位示例（与 ProviderCard 同源语义，键表就地复用一份：
 *  两处各一小张 Record，比为此抽共享模块更直白——见 AGENTS.md 简单性约定）。 */
const PROTOCOL_BASE_URL_PLACEHOLDER_KEYS: Record<ProviderApi, string> = {
  openai: 'settings.baseUrlPlaceholderOpenAi',
  anthropic: 'settings.baseUrlPlaceholderAnthropic',
  openai_responses: 'settings.baseUrlPlaceholderOpenAiResponses',
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    minWidth: 0,
  },
  title: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  desc: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  fieldLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  protocolSelect: {
    width: '100%',
  },
  models: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  modelList: {
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  modelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    ':not(:first-child)': {
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },
  modelInput: {
    flex: 1,
    minWidth: 0,
  },
  modelsEmpty: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  addModelBtn: {
    alignSelf: 'flex-start',
  },
  // 底部确认区：细分隔线 + 主钮（即时红字提示在分隔线上方一行）
  footer: {
    display: 'flex',
    alignItems: 'center',
    paddingTop: tokens.spacingVerticalM,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // 就地校验提示：挂在各自字段/区块正下方（红字小字）
  fieldIssue: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

export interface AddProviderFormProps {
  /** 校验通过后上交整套 provider（不含 id——id 由父级生成并顺带选中）。 */
  onConfirm: (provider: Omit<ProviderDto, 'id'>) => void;
}

/** 新增供应商缓冲表单：草稿入参为零——确认前不触碰页级 draft。 */
export function AddProviderForm({ onConfirm }: AddProviderFormProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [api, setApi] = useState<ProviderApi>('openai');
  const [models, setModels] = useState<ModelSpecDto[]>([]);
  // 添加/编辑模型对话框：index = 编辑目标行；null = 关闭。
  const [modelDialog, setModelDialog] = useState<
    | { mode: 'add' }
    | { mode: 'edit'; index: number }
    | null
  >(null);

  const candidate: Omit<ProviderDto, 'id'> = { name, baseUrl, apiKey, models, api };

  const issues: string[] = [];
  if (name.trim() === '') issues.push(t('settings.issueName'));
  if (baseUrl.trim() === '') issues.push(t('settings.issueBaseUrlRequired'));
  else if (!isValidHttpUrl(baseUrl.trim())) issues.push(t('settings.issueBaseUrlInvalid'));
  if (models.length === 0 || models.some((m) => m.id.trim() === '')) {
    issues.push(t('settings.issueModels'));
  }


  const renameModel = (index: number, id: string) =>
    setModels((m) => m.map((x, i) => (i === index ? { ...x, id } : x)));

  /** 添加/编辑模型对话框确认：新元数据写入目标行（添加 = 追加一行）。 */
  const confirmModelDialog = (spec: ModelSpecDto) => {
    if (modelDialog === null) return;
    const next =
      modelDialog.mode === 'add'
        ? [...models, spec]
        : models.map((m, i) => (i === modelDialog.index ? spec : m));
    setModels(next);
  };

  const protocolOptions = PROVIDER_PROTOCOLS.map((value) => ({
    value,
    label: t(PROTOCOL_LABEL_KEYS[value]),
  }));
  const selectProtocol = (value: string): void => {
    const match = protocolOptions.find((o) => o.value === value);
    if (match) setApi(match.value);
  };

  return (
    <div className={styles.root}>
      <Text className={styles.title}>{t('settings.providerAddTitle')}</Text>
      <Text className={styles.desc}>{t('settings.providerAddDesc')}</Text>

      <div className={styles.field}>
        <Text className={styles.fieldLabel}>{t('settings.providerName')}</Text>
        <Input
          value={name}
          aria-label="add-name"
          placeholder={t('settings.providerNamePlaceholder')}
          aria-invalid={name.trim() === ''}
          onChange={(_, d) => setName(d.value)}
        />
        {name.trim() === '' ? (
          <Text className={styles.fieldIssue} role="alert">
            {t('settings.issueName')}
          </Text>
        ) : null}
      </div>
      <div className={styles.field}>
        <Text className={styles.fieldLabel}>{t('settings.baseUrl')}</Text>
        <Input
          value={baseUrl}
          aria-label="add-baseUrl"
          placeholder={t(PROTOCOL_BASE_URL_PLACEHOLDER_KEYS[api])}
          aria-invalid={!isValidHttpUrl(baseUrl.trim())}
          onChange={(_, d) => setBaseUrl(d.value)}
        />
        {baseUrl.trim() === '' ? (
          <Text className={styles.fieldIssue} role="alert">
            {t('settings.issueBaseUrlRequired')}
          </Text>
        ) : !isValidHttpUrl(baseUrl.trim()) ? (
          <Text className={styles.fieldIssue} role="alert">
            {t('settings.issueBaseUrlInvalid')}
          </Text>
        ) : null}
      </div>
      <div className={styles.field}>
        <Text className={styles.fieldLabel}>{t('settings.apiKey')}</Text>
        <Input
          value={apiKey}
          aria-label="add-apiKey"
          placeholder={t('settings.apiKeyPlaceholder')}
          onChange={(_, d) => setApiKey(d.value)}
        />
      </div>
      <div className={styles.field}>
        <Text className={styles.fieldLabel}>{t('settings.protocolCompat')}</Text>
        <DropdownPushButton
          className={styles.protocolSelect}
          ariaLabel="add-protocol"
          value={api}
          onChange={selectProtocol}
          maxVisibleItems={3}
          options={protocolOptions}
        />
      </div>

      <div className={styles.models}>
        <Text className={styles.fieldLabel}>{t('settings.models')}</Text>
        {models.length === 0 ? (
          <div className={styles.modelsEmpty}>
            <Info16Regular />
            {t('settings.modelsEmpty')}
          </div>
        ) : (
          <div className={styles.modelList}>
            {models.map((model, index) => (
              <div key={index} className={styles.modelRow}>
                <Input
                  className={styles.modelInput}
                  value={model.id}
                  aria-label={`add-model-${index}`}
                  aria-invalid={model.id.trim() === ''}
                  onChange={(_, d) => renameModel(index, d.value)}
                />
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Pen16Regular />}
                  aria-label={`${t('settings.modelDialogEditTitle')} ${model.id}`}
                  onClick={() => setModelDialog({ mode: 'edit', index })}
                />
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Delete16Regular />}
                  aria-label={`${t('settings.deleteModel')} ${model.id || index}`}
                  onClick={() => setModels((m) => m.filter((_, i) => i !== index))}
                />
              </div>
            ))}
          </div>
        )}
        <Button
          className={styles.addModelBtn}
          size="small"
          icon={<Add16Regular />}
          onClick={() => setModelDialog({ mode: 'add' })}
        >
          {t('settings.addModel')}
        </Button>
        {models.length === 0 || models.some((m) => m.id.trim() === '') ? (
          <Text className={styles.fieldIssue} role="alert">
            {t('settings.issueModels')}
          </Text>
        ) : null}
        <ModelDialog
          open={modelDialog !== null}
          initial={modelDialog?.mode === 'edit' ? (models[modelDialog.index] ?? null) : null}
          onConfirm={confirmModelDialog}
          onOpenChange={(open) => {
            if (!open) setModelDialog(null);
          }}
        />
      </div>

      <div className={styles.footer}>
        <Button
          appearance="primary"
          disabled={issues.length > 0}
          onClick={() => onConfirm(candidate)}
        >
          {t('settings.addProvider')}
        </Button>
      </div>
    </div>
  );
}
