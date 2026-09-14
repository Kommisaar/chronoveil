// 单套 Provider 详情编辑面板（UI-003「模型服务」，FR-009；双层级 2026-09-09）。
// 2026-09-14 照参考稿重排：大标题（铅笔进入行内改名）+ 全局默认徽标 + 删除钮
// 居右；字段竖排（标签在上、输入在下）：Base URL / API 格式 / API Key；模型
// 列表为盒装行（行内模型名 + 「默认」徽标 + 设为默认 / 删除行内图标钮），空
// 列表显示虚线提示。全局默认是 (provider, model) 二元组：模型行「设为默认」
// 上报父级整对写入；删除确认（含激活占用拦截）由父级承担，本组件只上报意图。
// 模型行删除（U4）：唯一模型或全局默认模型的行先弹确认（防抖自动落盘下误触
// 会静默丢配置），普通行直接删保持轻快。
import {
  Button,
  Input,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircle16Regular,
  Delete16Regular,
  Eye16Regular,
  EyeOff16Regular,
  Info16Regular,
  Add16Regular,
  Pen16Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelSpecDto, ProviderApi, ProviderDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ModelDialog } from './ModelDialog';
import { DropdownPushButton } from '../../components/DropdownPushButton';
import { PROVIDER_PROTOCOLS, PROTOCOL_LABEL_KEYS, validateProvider } from './preferences';

/** 协议 → Base URL 占位示例 i18n key（占位即协议用法提示：anthropic 官方域名
 *  不带 /v1，openai 系带 /v1）。档位本体与行标签见 preferences 的单一事实源。 */
const PROTOCOL_BASE_URL_PLACEHOLDER_KEYS: Record<ProviderApi, string> = {
  openai: 'settings.baseUrlPlaceholderOpenAi',
  anthropic: 'settings.baseUrlPlaceholderAnthropic',
  openai_responses: 'settings.baseUrlPlaceholderOpenAiResponses',
};

const useStyles = makeStyles({
  // 详情面板直接铺在卡面上（参考稿无内嵌盒子），纵向排布
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    minWidth: 0,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  // 服务名大标题；省略号防长名挤压右侧动作钮
  title: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  titleInput: {
    flex: 1,
    minWidth: 0,
    maxWidth: '320px',
  },
  // 全局默认徽标：浅绿底 + 深绿字的小圆角片（与「已启用」语义对位——本应用
  // 无启用/禁用概念，全局默认指向即「生效中」）
  defaultChip: {
    flexShrink: 0,
    padding: `1px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    color: tokens.colorPaletteGreenForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  headDelete: {
    marginLeft: 'auto',
    color: tokens.colorNeutralForeground3,
    ':hover': { color: tokens.colorPaletteRedForeground1 },
  },
  // 竖排字段：标签在上（次级前景小字），输入占满整行
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
  // 模型列表区（标签 + 盒装行 + 添加钮）
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
  // 行内「默认」徽标：与头部徽标同款视觉（字号更小）
  rowDefaultChip: {
    flexShrink: 0,
    padding: `0 ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    color: tokens.colorPaletteGreenForeground1,
    fontSize: tokens.fontSizeBase200,
    lineHeight: '20px',
  },
  // 空模型列表虚线提示（参考稿同款语义）
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
  issues: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

interface ProviderCardProps {
  provider: ProviderDto;
  /** 全局默认 (activeProviderId) 是否指向本服务（默认徽标与模型行徽标前提） */
  isDefaultProvider: boolean;
  /** 全局默认模型名（仅 isDefaultProvider 时用于行「默认」徽标展示） */
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
  isDefaultProvider,
  activeModel,
  onChange,
  onActivateModel,
  onRemoveModel,
  onDelete,
}: ProviderCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [keyVisible, setKeyVisible] = useState(false);
  // 标题行内改名（铅笔进入；Enter/失焦提交——改名经 patch 实时回流草稿）。
  const [renaming, setRenaming] = useState(false);
  // 待确认的模型行删除目标（U4）：null = 无；确认前不触碰 draft。
  const [removeTarget, setRemoveTarget] = useState<{ index: number; model: string } | null>(
    null,
  );
  // 添加/编辑模型对话框：index = 编辑目标行；null = 关闭。
  const [modelDialog, setModelDialog] = useState<
    | { mode: 'add' }
    | { mode: 'edit'; index: number }
    | null
  >(null);

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

  const renameModel = (index: number, id: string) =>
    patch({ models: provider.models.map((m, i) => (i === index ? { ...m, id } : m)) });

  /** 添加/编辑模型对话框确认：新元数据写入目标行（添加 = 追加一行）。 */
  const confirmModelDialog = (spec: ModelSpecDto) => {
    if (modelDialog === null) return;
    const models =
      modelDialog.mode === 'add'
        ? [...provider.models, spec]
        : provider.models.map((m, i) => (i === modelDialog.index ? spec : m));
    patch({ models });
  };

  const renameOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      setRenaming(false);
    }
  };

  /** 模型行删除意图入口（U4）：唯一模型或全局默认模型先弹确认（误触静默丢
   *  配置的高危行），普通行直接删保持轻快。 */
  const requestRemoveModel = (index: number, model: string): void => {
    const isOnlyModel = provider.models.length === 1;
    const isGlobalDefault =
      isDefaultProvider && activeModel !== null && activeModel === model;
    if (isOnlyModel || isGlobalDefault) {
      setRemoveTarget({ index, model });
      return;
    }
    onRemoveModel(index);
  };

  const protocolOptions = PROVIDER_PROTOCOLS.map((value) => ({
    value,
    label: t(PROTOCOL_LABEL_KEYS[value]),
  }));

  /** 下拉回传字符串，经档位表映射回 ProviderApi 再上报；find 不到的分支只为
   *  类型收窄存在（下拉契约保证只回传档位 value），非运行时防御。 */
  const selectProtocol = (value: string): void => {
    const match = protocolOptions.find((o) => o.value === value);
    if (match) patch({ api: match.value });
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {renaming ? (
          <Input
            className={styles.titleInput}
            value={provider.name}
            aria-label={`${provider.id}-name`}
            placeholder={t('settings.providerNamePlaceholder')}
            autoFocus
            onChange={(_, d) => patch({ name: d.value })}
            onKeyDown={renameOnEnter}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <>
            <Text className={styles.title}>
              {provider.name.trim() || t('settings.providerNamePlaceholder')}
            </Text>
            <Button
              size="small"
              appearance="subtle"
              icon={<Pen16Regular />}
              aria-label={`${t('settings.rename')} ${provider.name}`}
              onClick={() => setRenaming(true)}
            />
          </>
        )}
        {isDefaultProvider ? (
          <span className={styles.defaultChip}>{t('settings.defaultBadge')}</span>
        ) : null}
        <Button
          size="small"
          appearance="subtle"
          className={styles.headDelete}
          icon={<Delete16Regular />}
          aria-label={`${t('settings.deleteProvider')} ${provider.name}`}
          onClick={onDelete}
        />
      </div>

      <div className={styles.field}>
        <Text className={styles.fieldLabel}>{t('settings.baseUrl')}</Text>
        <Input
          value={provider.baseUrl}
          aria-label={`${provider.id}-baseUrl`}
          placeholder={t(PROTOCOL_BASE_URL_PLACEHOLDER_KEYS[provider.api])}
          aria-invalid={!validity.baseUrl}
          onChange={(_, d) => patch({ baseUrl: d.value })}
        />
      </div>
      <div className={styles.field}>
        <Text className={styles.fieldLabel}>{t('settings.protocolCompat')}</Text>
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
        <Text className={styles.fieldLabel}>{t('settings.apiKey')}</Text>
        <Input
          type={keyVisible ? 'text' : 'password'}
          value={provider.apiKey}
          aria-label={`${provider.id}-apiKey`}
          placeholder={t('settings.apiKeyPlaceholder')}
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

      <div className={styles.models}>
        <Text className={styles.fieldLabel}>{t('settings.models')}</Text>
        {provider.models.length === 0 ? (
          <div className={styles.modelsEmpty}>
            <Info16Regular />
            {t('settings.modelsEmpty')}
          </div>
        ) : (
          <div className={styles.modelList}>
            {provider.models.map((model, index) => {
              const isDefaultModel =
                isDefaultProvider && activeModel !== null && activeModel === model.id;
              return (
                <div key={index} className={styles.modelRow}>
                  <Input
                    className={styles.modelInput}
                    value={model.id}
                    aria-label={`${provider.id}-model-${index}`}
                    aria-invalid={model.id.trim() === ''}
                    onChange={(_, d) => renameModel(index, d.value)}
                  />
                  {isDefaultModel ? (
                    <span className={styles.rowDefaultChip}>{t('settings.defaultBadge')}</span>
                  ) : (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<CheckmarkCircle16Regular />}
                      aria-label={`${t('settings.setActive')} ${model.id}`}
                      onClick={() => onActivateModel(model.id)}
                    />
                  )}
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
                    aria-label={`${t('settings.deleteModel')} ${model.id}`}
                    onClick={() => requestRemoveModel(index, model.id)}
                  />
                </div>
              );
            })}
          </div>
        )}
        <Button
          className={styles.addModelBtn}
          size="small"
          icon={<Add16Regular />}
          aria-label={t('settings.addModel')}
          onClick={() => setModelDialog({ mode: 'add' })}
        >
          {t('settings.addModel')}
        </Button>
        <ModelDialog
          open={modelDialog !== null}
          initial={
            modelDialog?.mode === 'edit' ? (provider.models[modelDialog.index] ?? null) : null
          }
          onConfirm={confirmModelDialog}
          onOpenChange={(open) => {
            if (!open) setModelDialog(null);
          }}
        />
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
