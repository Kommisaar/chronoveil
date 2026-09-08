// 设置视图（FR-009）。两栏分组卡片——窄卡（外观/节奏偏好）并排，宽卡
// （LLM Provider）横跨两栏（卡片样式照抄 relay-harbor 设置页；控件列由
// 其固定 220px 改为弹性 minmax(0,1fr)，半宽卡片下固定列会溢出）。
// 表单容器卡刻意不加悬停浮起（useCardLiftStyles 备注：避免填写时内容随
// 悬停跳动）。界面原型：主题/语言入 ui store 即时生效；config.json 读写
// 在阶段 6 接入（ADR-012）。
import {
  Card,
  Dropdown,
  Input,
  Option,
  Slider,
  Switch,
  Text,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LanguageSetting, ThemeSetting } from '../../api/types';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { useUiStore } from '../../stores/ui';

const useStyles = makeStyles({
  title: {
    marginBottom: tokens.spacingVerticalL,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: tokens.spacingVerticalL,
  },
  span2: {
    gridColumn: '1 / -1',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  field: {
    display: 'grid',
    gridTemplateColumns: '160px minmax(0, 1fr)',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  hint: {
    marginTop: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export function SettingsView() {
  const styles = useStyles();
  const page = usePageContainerStyles('settings');
  const { t } = useTranslation();
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  const setTheme = useUiStore((s) => s.setTheme);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [rhythm, setRhythm] = useState(45);
  const [punctPause, setPunctPause] = useState(true);

  const themeOptions: [ThemeSetting, string][] = [
    ['system', t('settings.themeSystem')],
    ['light', t('settings.themeLight')],
    ['dark', t('settings.themeDark')],
  ];
  const languageOptions: [LanguageSetting, string][] = [
    ['system', t('settings.languageSystem')],
    ['zh', t('settings.languageZh')],
    ['en', t('settings.languageEn')],
  ];
  const rhythmLabel = t('settings.rhythm', { value: String(rhythm) });

  return (
    <div className={page}>
      <Title1 as="h1" className={styles.title}>
        {t('settings.title')}
      </Title1>

      <div className={styles.grid}>
        <Card className={styles.card}>
          <Text weight="semibold">{t('settings.appearance')}</Text>
          <div className={styles.field}>
            <Text>{t('settings.theme')}</Text>
            <Dropdown
              value={themeOptions.find(([v]) => v === theme)?.[1] ?? ''}
              selectedOptions={[theme]}
              onOptionSelect={(_, d) => setTheme(d.optionValue as ThemeSetting)}
            >
              {themeOptions.map(([value, label]) => (
                <Option key={value} value={value}>
                  {label}
                </Option>
              ))}
            </Dropdown>
          </div>
          <div className={styles.field}>
            <Text>{t('settings.language')}</Text>
            <Dropdown
              value={languageOptions.find(([v]) => v === language)?.[1] ?? ''}
              selectedOptions={[language]}
              onOptionSelect={(_, d) => setLanguage(d.optionValue as LanguageSetting)}
            >
              {languageOptions.map(([value, label]) => (
                <Option key={value} value={value}>
                  {label}
                </Option>
              ))}
            </Dropdown>
          </div>
        </Card>

        <Card className={styles.card}>
          <Text weight="semibold">{t('settings.rhythmCard')}</Text>
          <div className={styles.field}>
            <Text>{rhythmLabel}</Text>
            <Slider
              min={10}
              max={160}
              step={5}
              value={rhythm}
              aria-label={rhythmLabel}
              onChange={(_, d) => setRhythm(d.value)}
            />
          </div>
          <div className={styles.field}>
            <Text>{t('settings.punctPause')}</Text>
            <Switch
              checked={punctPause}
              aria-label={t('settings.punctPause')}
              onChange={(_, d) => setPunctPause(d.checked)}
            />
          </div>
        </Card>

        <Card className={mergeClasses(styles.card, styles.span2)}>
          <Text weight="semibold">{t('settings.provider')}</Text>
          <div className={styles.field}>
            <Text>{t('settings.baseUrl')}</Text>
            <Input value={baseUrl} onChange={(_, d) => setBaseUrl(d.value)} />
          </div>
          <div className={styles.field}>
            <Text>{t('settings.apiKey')}</Text>
            <Input type="password" value={apiKey} onChange={(_, d) => setApiKey(d.value)} />
          </div>
          <div className={styles.field}>
            <Text>{t('settings.model')}</Text>
            <Input value={model} onChange={(_, d) => setModel(d.value)} />
          </div>
        </Card>
      </div>

      <Text className={styles.hint}>{t('settings.hint')}</Text>
    </div>
  );
}
