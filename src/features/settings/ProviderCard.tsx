// 单套 Provider 编辑卡（UI-003「模型服务」，FR-009）：name / base_url /
// api_key / model 四行 + 激活单选 + 删除。api_key 默认掩码、可见性切换
// （OQ-001：明文本机存储，掩码仅为输入防窥）。删除确认（含激活占用拦截）
// 由父级 SettingsView 的 Dialog 承担，本组件只上报意图。
import {
  Button,
  Input,
  Radio,
  RadioGroup,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Delete16Regular, Eye16Regular, EyeOff16Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderDto } from '../../api/types';
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
  issues: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

interface ProviderCardProps {
  provider: ProviderDto;
  /** 该卡是否为当前激活（active_provider_id 指向者） */
  isActive: boolean;
  onChange: (next: ProviderDto) => void;
  onActivate: () => void;
  onDelete: () => void;
}

export function ProviderCard({ provider, isActive, onChange, onActivate, onDelete }: ProviderCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [keyVisible, setKeyVisible] = useState(false);

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
  if (!validity.model) issues.push(t('settings.issueModel'));

  const patch = (partial: Partial<ProviderDto>) => onChange({ ...provider, ...partial });

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <RadioGroup
          aria-label={t('settings.activeProvider')}
          value={isActive ? provider.id : ''}
          onChange={onActivate}
        >
          <Radio value={provider.id} label={t('settings.setActive')} />
        </RadioGroup>
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
        <Text>{t('settings.model')}</Text>
        <Input
          value={provider.model}
          aria-label={`${provider.id}-model`}
          aria-invalid={!validity.model}
          onChange={(_, d) => patch({ model: d.value })}
        />
      </div>

      {issues.length > 0 ? (
        <Text className={styles.issues} role="alert">
          {issues.join('；')}
        </Text>
      ) : null}
    </div>
  );
}
