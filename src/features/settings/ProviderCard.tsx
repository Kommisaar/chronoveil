// 单套 Provider 编辑卡（UI-003「模型服务」，FR-009；双层级 2026-09-09）：
// name / base_url / api_key 三行 + 「模型」列表（每行：设为默认单选 + 模型名 +
// 行内删除，底部添加行）+ 删除服务。全局默认是 (provider, model) 二元组，选中
// 某模型行的单选即写入整对值；api_key 默认掩码、可见性切换（OQ-001：明文本机
// 存储，掩码仅为输入防窥）。删除确认（含激活占用拦截）与默认选中回落由父级
// SettingsView 承担，本组件只上报意图。模型行删除（U4）：唯一模型或全局默认
// 模型的行先弹确认（防抖自动落盘下误触会静默丢配置），普通行直接删保持轻快。
import {
  Button,
  Input,
  Radio,
  RadioGroup,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add16Regular,
  Delete16Regular,
  Eye16Regular,
  EyeOff16Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { validateProvider } from './preferences';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  field: {
    display: 'grid',
    gridTemplateColumns: '160px minmax(0, 1fr)',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  modelsLabel: {
    alignSelf: 'start',
    paddingTop: tokens.spacingVerticalS,
  },
  models: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  modelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  modelInput: {
    flex: 1,
    minWidth: 0,
  },
  addRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
  },
  issues: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

interface ProviderCardProps {
  provider: ProviderDto;
  /** 全局默认 (provider, model) 是否指向本服务 */
  isActiveProvider: boolean;
  /** 全局默认模型名（仅 isActiveProvider 时用于行选中态展示） */
  activeModel: string | null;
  onChange: (next: ProviderDto) => void;
  /** 选中某模型行「设为默认」：父级写入 activeProviderId + activeModel 整对值 */
  onActivateModel: (model: string) => void;
  /** 删除第 index 个模型：父级负责默认选中回落 */
  onRemoveModel: (index: number) => void;
  onDelete: () => void;
}

export function ProviderCard({
  provider,
  isActiveProvider,
  activeModel,
  onChange,
  onActivateModel,
  onRemoveModel,
  onDelete,
}: ProviderCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [keyVisible, setKeyVisible] = useState(false);
  const [newModel, setNewModel] = useState('');
  // 待确认的模型行删除目标（U4）：null = 无；确认前不触碰 draft。
  const [removeTarget, setRemoveTarget] = useState<{ index: number; model: string } | null>(
    null,
  );

  const validity = validateProvider(provider);
  const issues: string[] = [];
  if (!validity.name) issues.push(t('settings.issueName'));
  if (!validity.baseUrl) {
    issues.push(
      provider.baseUrl.trim() === ''
        ? t('settings.issueBaseUrlRequired')
        : t('settings.issueBaseUrlInvalid'),
    );
  }
  if (provider.models.length === 0) issues.push(t('settings.issueModels'));

  const patch = (partial: Partial<ProviderDto>) => onChange({ ...provider, ...partial });

  const renameModel = (index: number, name: string) =>
    patch({ models: provider.models.map((m, i) => (i === index ? name : m)) });

  const addModel = () => {
    const name = newModel.trim();
    if (name === '' || provider.models.includes(name)) return;
    onChange({ ...provider, models: [...provider.models, name] });
    setNewModel('');
  };

  const addOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addModel();
    }
  };

  /** 模型行删除意图入口（U4）：唯一模型或全局默认模型先弹确认（误触静默丢
   *  配置的高危行），普通行直接删保持轻快。 */
  const requestRemoveModel = (index: number, model: string): void => {
    const isOnlyModel = provider.models.length === 1;
    const isGlobalDefault =
      isActiveProvider && activeModel !== null && activeModel === model;
    if (isOnlyModel || isGlobalDefault) {
      setRemoveTarget({ index, model });
      return;
    }
    onRemoveModel(index);
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <Text weight="semibold">{provider.name.trim() || t('settings.providerNamePlaceholder')}</Text>
        <Button
          size="small"
          appearance="subtle"
          icon={<Delete16Regular />}
          aria-label={`${t('settings.deleteProvider')} ${provider.name}`}
          onClick={onDelete}
        >
          {t('settings.deleteProvider')}
        </Button>
      </div>

      <div className={styles.field}>
        <Text>{t('settings.providerName')}</Text>
        <Input
          value={provider.name}
          aria-label={`${provider.id}-name`}
          placeholder={t('settings.providerNamePlaceholder')}
          aria-invalid={!validity.name}
          onChange={(_, d) => patch({ name: d.value })}
        />
      </div>
      <div className={styles.field}>
        <Text>{t('settings.baseUrl')}</Text>
        <Input
          value={provider.baseUrl}
          aria-label={`${provider.id}-baseUrl`}
          placeholder="https://api.example.com/v1"
          aria-invalid={!validity.baseUrl}
          onChange={(_, d) => patch({ baseUrl: d.value })}
        />
      </div>
      <div className={styles.field}>
        <Text>{t('settings.apiKey')}</Text>
        <Input
          type={keyVisible ? 'text' : 'password'}
          value={provider.apiKey}
          aria-label={`${provider.id}-apiKey`}
          onChange={(_, d) => patch({ apiKey: d.value })}
          contentAfter={
            <Button
              size="small"
              appearance="transparent"
              icon={keyVisible ? <EyeOff16Regular /> : <Eye16Regular />}
              aria-label={keyVisible ? t('settings.hideApiKey') : t('settings.showApiKey')}
              onClick={() => setKeyVisible((v) => !v)}
            />
          }
        />
      </div>

      <div className={styles.field}>
        <Text className={styles.modelsLabel}>{t('settings.models')}</Text>
        <div className={styles.models}>
          {provider.models.map((model, index) => {
            const isDefault =
              isActiveProvider && activeModel !== null && activeModel === model;
            return (
              <div key={`${model}-${index}`} className={styles.modelRow}>
                <RadioGroup
                  aria-label={t('settings.activeProvider')}
                  value={isDefault ? provider.id : ''}
                  onChange={() => onActivateModel(model)}
                >
                  <Radio value={provider.id} label={t('settings.setActive')} />
                </RadioGroup>
                <Input
                  className={styles.modelInput}
                  value={model}
                  aria-label={`${provider.id}-model-${index}`}
                  aria-invalid={model.trim() === ''}
                  onChange={(_, d) => renameModel(index, d.value)}
                />
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Delete16Regular />}
                  aria-label={`${t('settings.deleteModel')} ${model}`}
                  onClick={() => requestRemoveModel(index, model)}
                />
              </div>
            );
          })}
          <div className={styles.addRow}>
            <Input
              className={styles.modelInput}
              value={newModel}
              aria-label={`${provider.id}-newModel`}
              placeholder={t('settings.modelPlaceholder')}
              onChange={(_, d) => setNewModel(d.value)}
              onKeyDown={addOnEnter}
            />
            <Button
              size="small"
              icon={<Add16Regular />}
              aria-label={t('settings.addModel')}
              disabled={newModel.trim() === ''}
              onClick={addModel}
            >
              {t('settings.addModel')}
            </Button>
          </div>
        </div>
      </div>

      {issues.length > 0 ? (
        <Text className={styles.issues} role="alert">
          {issues.join('；')}
        </Text>
      ) : null}

      {/* U4 高危模型行删除确认：取消不触碰 draft；确认才上报父级（回落逻辑
          留在父级 SettingsView 的 removeModel）。 */}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t('settings.deleteModelConfirmTitle')}
        content={
          removeTarget
            ? t('settings.deleteModelConfirmBody', { model: removeTarget.model })
            : ''
        }
        confirmLabel={t('settings.deleteModel')}
        cancelLabel={t('settings.cancel')}
        destructive
        onConfirm={() => {
          if (removeTarget) onRemoveModel(removeTarget.index);
          setRemoveTarget(null);
        }}
      />
    </div>
  );
}
