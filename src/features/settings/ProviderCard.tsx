// 单套 Provider 编辑卡（UI-003「模型服务」，FR-009；双层级 2026-09-09）：
// name / 兼容方式 / base_url / api_key 四行 + 「模型」列表（每行：设为默认单选 +
// 模型名 + 行内删除，底部添加行）+ 删除服务。兼容方式（2026-09-14）选 wire 协议
// （openai / anthropic / openai_responses，Task-01 Rust 侧已支持），下拉复刻件
// 与角色编辑器/设置页同一控件语言；协议决定 baseUrl 的解释方式（Rust 侧路径与
// 鉴权头），Base URL 占位示例随协议自适应，切档不清空已填配置（用户可能只是接
// 了兼容网关，地址与模型保留）。全局默认是 (provider, model) 二元组，选中
// 某模型行的单选即写入整对值；api_key 默认掩码、可见性切换（OQ-001：明文本机
// 存储，掩码仅为输入防窥）。删除确认（含激活占用拦截）与默认选中回落由父级
// ProvidersCard 承担，本组件只上报意图。模型行删除（U4）：唯一模型或全局默认
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
import type { ProviderApi } from '../../api/generated/bindings';
import type { ProviderDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DropdownPushButton } from '../../components/DropdownPushButton';
import { validateProvider } from './preferences';

/** 三协议档位单一事实源（wire 值 = bindings 的 ProviderApi；Task-01 三协议）。
 *  label / 占位示例各用 Record 全量映射，协议扩档时 tsc 强制补齐文案。 */
const PROTOCOLS: readonly ProviderApi[] = ['openai', 'anthropic', 'openai_responses'];

const PROTOCOL_LABEL_KEYS: Record<ProviderApi, string> = {
  openai: 'settings.protocolOpenAi',
  anthropic: 'settings.protocolAnthropic',
  openai_responses: 'settings.protocolOpenAiResponses',
};

/** 占位示例即协议用法提示（anthropic 官方域名不带 /v1，openai 系带 /v1）。 */
const PROTOCOL_BASE_URL_PLACEHOLDER_KEYS: Record<ProviderApi, string> = {
  openai: 'settings.baseUrlPlaceholderOpenAi',
  anthropic: 'settings.baseUrlPlaceholderAnthropic',
  openai_responses: 'settings.baseUrlPlaceholderOpenAiResponses',
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    // 行内档圆角 = borderRadiusMedium（Fluent v9 实测 4px；三档圆角规范
    // 最内档：分组卡 = Large 6px 见 SettingsCard，页面级卡片表面 = 16px 见
    // CharacterEditorDialog surface，规范常量 SURFACE_RADIUS_PAGE_CARD
    // 在 src/components/surfaceSpec.ts）
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
  // 兼容方式下拉撑满输入列：与上下行的 Input 同宽对齐（本卡的行语言是
  // 160px 标签 + 输入列满宽，不同于设置页 SettingsRow 的固定宽控件）
  protocolSelect: {
    width: '100%',
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

  const protocolOptions = PROTOCOLS.map((value) => ({
    value,
    label: t(PROTOCOL_LABEL_KEYS[value]),
  }));

  /** 下拉回传字符串，经档位表映射回 ProviderApi 再上报；find 不到的分支只为
   *  类型收窄存在（下拉契约保证只回传档位 value），非运行时防御。 */
  const selectProtocol = (value: string): void => {
    const match = protocolOptions.find((o) => o.value === value);
    if (match) patch({ api: match.value });
  };

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
      {/* 兼容方式行在名称之后：协议决定 baseUrl 的解释方式，先选协议再填地址 */}
      <div className={styles.field}>
        <Text>{t('settings.protocolCompat')}</Text>
        <DropdownPushButton
          className={styles.protocolSelect}
          ariaLabel={`${provider.id}-protocol`}
          value={provider.api}
          onChange={selectProtocol}
          maxVisibleItems={3}
          options={protocolOptions}
        />
      </div>
      <div className={styles.field}>
        <Text>{t('settings.baseUrl')}</Text>
        <Input
          value={provider.baseUrl}
          aria-label={`${provider.id}-baseUrl`}
          placeholder={t(PROTOCOL_BASE_URL_PLACEHOLDER_KEYS[provider.api])}
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
          留在父级 ProvidersCard 的 removeModel）。 */}
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
