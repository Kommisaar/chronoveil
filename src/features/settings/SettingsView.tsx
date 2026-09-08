// 设置视图（UI-003 / FR-009，TASK-009 接真）：载入 config.json → 分节卡片
// 草稿编辑 → 显式「保存」整份 saveConfig 原子落盘（ADR-012）。语义要点：
// - saveConfig 是整份覆写：以载入 config 为基做不可变更新，不呈现的字段
//   （directorModel，FR-009 已移除配置项）原样带回；
// - 主题/语言在表单草稿中改动，保存成功后经既有 setTheme/setLanguage
//   即时生效（AppProviders 的 useResolvedTheme 解析，不在此重复实现）；
// - 校验双重兜底：前端禁保存 + Rust save_config 校验（越界经 ApiError 展示）。
// 表单容器卡刻意不加悬停浮起（useCardLiftStyles 备注：避免填写时内容随
// 悬停跳动）。
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Radio,
  RadioGroup,
  Slider,
  Switch,
  Text,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getConfig, saveConfig } from '../../api/commands';
import type { ConfigDto, LanguageSetting, ProviderDto, ThemeSetting } from '../../api/types';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { useUiStore } from '../../stores/ui';
import {
  isProviderValid,
  isRhythmValid,
  newProviderId,
  parseAnimBaseMs,
  toDraft,
} from './preferences';
import { ProviderCard } from './ProviderCard';

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
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  providerList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  // 无 provider 空态（验收 7）：虚线框引导新建
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXL,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
  },
  issues: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
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
  // 只调用既有 ui store 动作（不改 store 定义）；保存成功后驱动 AppProviders
  // 的主题/语言解析即时生效。
  const setTheme = useUiStore((s) => s.setTheme);
  const setLanguage = useUiStore((s) => s.setLanguage);

  const [loaded, setLoaded] = useState<ConfigDto | null>(null);
  const [draft, setDraft] = useState<ConfigDto | null>(null);
  const [animBaseText, setAnimBaseText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProviderDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 载入当次 config（生成侧读当次值不缓存，ADR-012；此处为表单基线）
  useEffect(() => {
    let cancelled = false;
    void getConfig()
      .then((config) => {
        if (cancelled) return;
        setLoaded(config);
        setDraft(toDraft(config));
        setAnimBaseText(String(config.animDurationBase));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const animBase = draft ? parseAnimBaseMs(animBaseText) : null;

  /** 保存将写入的整份 config：草稿为基，directorModel 原样保留（验收 6）。 */
  const next: ConfigDto | null = useMemo(() => {
    if (!loaded || !draft) return null;
    return {
      providers: draft.providers,
      activeProviderId: draft.activeProviderId,
      rhythmMsPerChar: draft.rhythmMsPerChar,
      punctPauseEnabled: draft.punctPauseEnabled,
      animDurationBase: animBase ?? loaded.animDurationBase,
      uiLanguage: draft.uiLanguage,
      uiTheme: draft.uiTheme,
      directorModel: loaded.directorModel,
    };
  }, [loaded, draft, animBase]);

  // 脏状态：保存将写入的内容与载入基线逐字段比对
  const dirty = next !== null && loaded !== null && JSON.stringify(next) !== JSON.stringify(loaded);

  const issues: string[] = [];
  if (draft) {
    if (draft.providers.some((p) => !isProviderValid(p))) issues.push(t('settings.issueProvider'));
    if (!isRhythmValid(draft.rhythmMsPerChar)) issues.push(t('settings.issueRhythm'));
    if (animBase === null) issues.push(t('settings.issueAnimBase'));
  }
  const canSave = draft !== null && issues.length === 0 && !saving;

  const patch = (partial: Partial<ConfigDto>) =>
    setDraft((d) => (d === null ? d : { ...d, ...partial }));

  const addProvider = () =>
    setDraft((d) => {
      if (d === null) return d;
      const provider: ProviderDto = {
        id: newProviderId(),
        name: '',
        baseUrl: '',
        apiKey: '',
        model: '',
      };
      return { ...d, providers: [...d.providers, provider] };
    });

  const changeProvider = (id: string, nextProvider: ProviderDto) =>
    setDraft((d) =>
      d === null
        ? d
        : { ...d, providers: d.providers.map((p) => (p.id === id ? nextProvider : p)) },
    );

  const confirmDelete = () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    setDraft((d) =>
      d === null ? d : { ...d, providers: d.providers.filter((p) => p.id !== target.id) },
    );
  };

  const save = async () => {
    if (!loaded || !draft || !next || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveConfig(next);
      setLoaded(next);
      setDraft(toDraft(next));
      setAnimBaseText(String(next.animDurationBase));
      // 保存成功后主题/语言即时生效（既有 ui store 动作，AppProviders 消费）
      setTheme(draft.uiTheme as ThemeSetting);
      setLanguage(draft.uiLanguage as LanguageSetting);
    } catch (e: unknown) {
      // 后端校验失败（如 rhythm 越界）经 ApiError 展示可读错误（验收 5）
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteIsActive = deleteTarget !== null && draft?.activeProviderId === deleteTarget.id;

  return (
    <div className={page}>
      <Title1 as="h1" className={styles.title}>
        {t('settings.title')}
      </Title1>

      {loadError ? (
        <Text className={styles.issues} role="alert">
          {t('settings.loadFailed')}: {loadError}
        </Text>
      ) : null}

      {draft && loaded ? (
        <>
          <div className={styles.grid}>
            <Card className={styles.card}>
              <Text weight="semibold">{t('settings.appearance')}</Text>
              <div className={styles.field}>
                <Text>{t('settings.theme')}</Text>
                <RadioGroup
                  layout="horizontal"
                  aria-label={t('settings.theme')}
                  value={draft.uiTheme}
                  onChange={(_, d) => patch({ uiTheme: d.value })}
                >
                  <Radio value="system" label={t('settings.themeSystem')} />
                  <Radio value="light" label={t('settings.themeLight')} />
                  <Radio value="dark" label={t('settings.themeDark')} />
                </RadioGroup>
              </div>
              <div className={styles.field}>
                <Text>{t('settings.language')}</Text>
                <RadioGroup
                  layout="horizontal"
                  aria-label={t('settings.language')}
                  value={draft.uiLanguage}
                  onChange={(_, d) => patch({ uiLanguage: d.value })}
                >
                  <Radio value="system" label={t('settings.languageSystem')} />
                  <Radio value="zh" label={t('settings.languageZh')} />
                  <Radio value="en" label={t('settings.languageEn')} />
                </RadioGroup>
              </div>
            </Card>

            <Card className={styles.card}>
              <Text weight="semibold">{t('settings.rhythmCard')}</Text>
              <div className={styles.field}>
                <Text>{t('settings.rhythm', { value: String(draft.rhythmMsPerChar) })}</Text>
                <Slider
                  min={10}
                  max={160}
                  step={5}
                  value={draft.rhythmMsPerChar}
                  aria-label={t('settings.rhythm', { value: String(draft.rhythmMsPerChar) })}
                  onChange={(_, d) => patch({ rhythmMsPerChar: d.value })}
                />
              </div>
              <div className={styles.field}>
                <Text>{t('settings.punctPause')}</Text>
                <Switch
                  checked={draft.punctPauseEnabled}
                  aria-label={t('settings.punctPause')}
                  onChange={(_, d) => patch({ punctPauseEnabled: d.checked })}
                />
              </div>
              <div className={styles.field}>
                <Text>{t('settings.animBase')}</Text>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={animBaseText}
                  aria-label={t('settings.animBase')}
                  onChange={(_, d) => {
                    setAnimBaseText(d.value);
                    const parsed = parseAnimBaseMs(d.value);
                    if (parsed !== null) patch({ animDurationBase: parsed });
                  }}
                />
              </div>
              {animBase === null ? (
                <Text className={styles.issues} role="alert">
                  {t('settings.issueAnimBase')}
                </Text>
              ) : null}
            </Card>

            <Card className={mergeClasses(styles.card, styles.span2)}>
              <div className={styles.cardHead}>
                <Text weight="semibold">{t('settings.provider')}</Text>
                <Button size="small" icon={<Add16Regular />} onClick={addProvider}>
                  {t('settings.addProvider')}
                </Button>
              </div>

              {draft.providers.length === 0 ? (
                <div className={styles.empty}>
                  <Text>{t('settings.providerEmpty')}</Text>
                  <Button icon={<Add16Regular />} onClick={addProvider}>
                    {t('settings.addProvider')}
                  </Button>
                </div>
              ) : (
                <div className={styles.providerList}>
                  {draft.providers.map((provider) => (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      isActive={draft.activeProviderId === provider.id}
                      onChange={(p) => changeProvider(provider.id, p)}
                      onActivate={() => patch({ activeProviderId: provider.id })}
                      onDelete={() => setDeleteTarget(provider)}
                    />
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className={styles.actions}>
            {saveError ? (
              <Text className={styles.issues} role="alert">
                {t('settings.saveFailed')}: {saveError}
              </Text>
            ) : null}
            {dirty && !saveError ? (
              <Badge appearance="tint" color="warning">
                {t('settings.dirty')}
              </Badge>
            ) : null}
            <Button appearance="primary" disabled={!canSave} onClick={() => void save()}>
              {saving ? t('settings.saving') : t('settings.save')}
            </Button>
          </div>

          {issues.length > 0 && !saving ? (
            <Text className={styles.issues}>{issues.join('；')}</Text>
          ) : null}

          {/* 删除确认（UI-003）：激活中的 provider 要求先转移激活，确认键禁用 */}
          <Dialog
            open={deleteTarget !== null}
            onOpenChange={(_, d) => {
              if (!d.open) setDeleteTarget(null);
            }}
          >
            <DialogSurface>
              <DialogBody>
                <DialogTitle>{t('settings.deleteConfirmTitle')}</DialogTitle>
                <DialogContent>
                  {deleteIsActive
                    ? t('settings.deleteActiveBlocked')
                    : t('settings.deleteConfirmBody', {
                        name: deleteTarget?.name.trim() || deleteTarget?.id,
                      })}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setDeleteTarget(null)}>
                    {t('settings.cancel')}
                  </Button>
                  <Button appearance="primary" disabled={deleteIsActive} onClick={confirmDelete}>
                    {t('settings.deleteProvider')}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </>
      ) : null}

      <Text className={styles.hint}>{t('settings.hint')}</Text>
    </div>
  );
}
