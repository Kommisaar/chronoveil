// 设置视图（UI-003 / FR-009，TASK-009 接真；2026-09-09 起改「修改即保存」）：
// 载入 config.json → 分节卡片直接编辑，草稿合法即防抖自动 saveConfig 原子
// 落盘（ADR-012），无显式保存按钮。语义要点：
// - saveConfig 是整份覆写：以载入 config 为基做不可变更新，不呈现的字段
//   （directorModel，FR-009 已移除配置项）原样带回；
// - 自动保存只在整份草稿校验通过时触发：provider 必填/节奏/动效基准非法时
//   就地展示问题、不落盘，改正后自动续存；保存失败不自动重试，待下一次
//   修改再试（lastAttempted 挡住同内容的重复尝试）；
// - 主题/语言改动即经既有 setTheme/setLanguage 即时生效（AppProviders 的
//   useResolvedTheme 解析），落盘交给自动保存；
// - 后端校验兜底：Rust save_config 校验（越界经 ApiError 展示）。
// 表单容器卡刻意不加悬停浮起（useCardLiftStyles 备注：避免填写时内容随
// 悬停跳动）。
import {
  Badge,
  Button,
  Input,
  Radio,
  RadioGroup,
  Text,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add16Regular,
  Book20Regular,
  Color20Regular,
  Globe20Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getConfig, saveConfig } from '../../api/commands';
import type { ConfigDto, LanguageSetting, ProviderDto, ThemeSetting } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { StateBlock } from '../../components/StateBlock';
import { useUiStore } from '../../stores/ui';
import {
  isProviderValid,
  isRhythmValid,
  newProviderId,
  parseAnimBaseMs,
  parseNearScenes,
  toDraft,
  withoutModel,
} from './preferences';
import { RhythmSettingsCard } from './RhythmSettingsCard';
import { ProviderCard } from './ProviderCard';
import { SettingsCard, SettingsDivider, SettingsRow } from '../../components/SettingsCard';

/** 自动保存防抖：停止修改后延迟落盘（滑杆拖动/逐键输入不逐帧写盘）。 */
const AUTOSAVE_DEBOUNCE_MS = 600;

const useStyles = makeStyles({
  title: {
    marginBottom: tokens.spacingVerticalL,
  },
  // 2026-09-10 行结构卡片：单列纵排（参照外部截图的宽卡片行布局），
  // 不再两栏并排——行式布局需要宽度才舒展
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  animInput: {
    width: '140px',
  },
  // 近景场景数非法时的卡片级行内提示（与底部汇总合计两处，验收 5）
  rowIssue: {
    padding: '0 20px 12px',
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  providerList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  // 服务卡行区与卡边的内距（ProviderCard 列表 / 空态共用）
  providerBody: {
    display: 'flex',
    flexDirection: 'column',
    padding: '16px 20px',
  },
  // 无 provider 空态（验收 7）：虚线框引导新建。引导型空态的合理特例——
  // 不收编进 EmptyState/StateBlock（那是「无数据可看」的占位语义）；这里
  // 是表单区内的「下一步行动引导」，需要虚线框 + 行内新建钮的分量感
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
  // 修改即保存状态（置于服务卡底部提示位）：minHeight 防状态切换跳动
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minHeight: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  hint: {
    marginTop: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  // 配置加载中的占位容器（A1 三态收编，此前整页空白）：给 StateBlock 一个
  // 视觉上有分量的留白高度
  loading: {
    display: 'flex',
    minHeight: '200px',
    alignItems: 'center',
    justifyContent: 'center',
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
  // 近景场景数（近景窗口可选化）：与动效基准同款「文本态 + 解析」输入。
  const [nearScenesText, setNearScenesText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProviderDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 最近一次实际尝试落盘的整份 payload：保存失败后挡住自动重试（同内容
  // 不再试，待下一次修改生成新 payload 再试）。
  const lastAttemptedRef = useRef('');

  // 载入当次 config（生成侧读当次值不缓存，ADR-012；此处为表单基线）
  useEffect(() => {
    let cancelled = false;
    void getConfig()
      .then((config) => {
        if (cancelled) return;
        setLoaded(config);
        setDraft(toDraft(config));
        setAnimBaseText(String(config.animDurationBase));
        setNearScenesText(String(config.nearScenes));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const animBase = draft ? parseAnimBaseMs(animBaseText) : null;
  const nearScenes = draft ? parseNearScenes(nearScenesText) : null;

  /** 保存将写入的整份 config：草稿为基，directorModel 原样保留（验收 6）。 */
  const next: ConfigDto | null = useMemo(() => {
    if (!loaded || !draft) return null;
    return {
      providers: draft.providers,
      activeProviderId: draft.activeProviderId,
      activeModel: draft.activeModel,
      rhythmMsPerChar: draft.rhythmMsPerChar,
      punctPauseEnabled: draft.punctPauseEnabled,
      animDurationBase: animBase ?? loaded.animDurationBase,
      uiLanguage: draft.uiLanguage,
      uiTheme: draft.uiTheme,
      directorModel: loaded.directorModel,
      nearScenes: nearScenes ?? loaded.nearScenes,
    };
  }, [loaded, draft, animBase, nearScenes]);

  // 脏状态：保存将写入的内容与载入基线逐字段比对
  const dirty = next !== null && loaded !== null && JSON.stringify(next) !== JSON.stringify(loaded);

  const issues: string[] = [];
  if (draft) {
    if (draft.providers.some((p) => !isProviderValid(p))) issues.push(t('settings.issueProvider'));
    if (!isRhythmValid(draft.rhythmMsPerChar)) issues.push(t('settings.issueRhythm'));
    if (animBase === null) issues.push(t('settings.issueAnimBase'));
    if (nearScenes === null) issues.push(t('settings.issueNearScenes'));
  }
  const hasIssues = issues.length > 0;

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
        models: [],
      };
      return { ...d, providers: [...d.providers, provider] };
    });

  const changeProvider = (id: string, nextProvider: ProviderDto) =>
    setDraft((d) => {
      if (d === null) return d;
      // 全局默认模型跟随改名：默认指向本服务且原选中模型在改动后同位置换了名，
      // 则默认跟随新名（删除行走 withoutModel 的回落逻辑，不在此处理）。
      let activeModel = d.activeModel;
      const prev = d.providers.find((p) => p.id === id);
      if (
        prev &&
        d.activeProviderId === id &&
        activeModel !== null &&
        nextProvider.models.length === prev.models.length
      ) {
        const idx = prev.models.indexOf(activeModel);
        if (idx >= 0 && nextProvider.models[idx] !== activeModel) {
          activeModel = nextProvider.models[idx]!;
        }
      }
      return {
        ...d,
        activeModel,
        providers: d.providers.map((p) => (p.id === id ? nextProvider : p)),
      };
    });

  /** 模型行「设为默认」：整对写入 (activeProviderId, activeModel)。 */
  const activateModel = (providerId: string, model: string) =>
    setDraft((d) => (d === null ? d : { ...d, activeProviderId: providerId, activeModel: model }));

  /** 删除模型行：默认选中指向被删模型时同步回落（置 null，解析层取第一个模型）。 */
  const removeModel = (providerId: string, index: number) =>
    setDraft((d) => {
      if (d === null) return d;
      const provider = d.providers.find((p) => p.id === providerId);
      if (!provider) return d;
      const next = withoutModel(d, provider, index);
      return {
        ...d,
        activeModel: next.activeModel,
        providers: d.providers.map((p) => (p.id === providerId ? next.provider : p)),
      };
    });

  const confirmDelete = () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    setDraft((d) =>
      d === null ? d : { ...d, providers: d.providers.filter((p) => p.id !== target.id) },
    );
  };

  const save = async () => {
    if (!loaded || !draft || !next || saving || hasIssues) return;
    lastAttemptedRef.current = JSON.stringify(next);
    setSaving(true);
    setSaveError(null);
    try {
      await saveConfig(next);
      setLoaded(next);
      setDraft(toDraft(next));
      setAnimBaseText(String(next.animDurationBase));
      setNearScenesText(String(next.nearScenes));
    } catch (e: unknown) {
      // 后端校验失败（如 rhythm 越界）经 ApiError 展示可读错误（验收 5）；
      // 不自动重试，待下一次修改由自动保存再试。
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // 修改即保存：草稿合法且与载入基线不一致时防抖落盘。effect 依赖随渲染
  // 重建的 save/issues，重跑只会重置计时器；真正触发条件由早退分支把守。
  useEffect(() => {
    if (!loaded || !next || !dirty || hasIssues) return;
    const payload = JSON.stringify(next);
    if (payload === lastAttemptedRef.current) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  const deleteIsActive = deleteTarget !== null && draft?.activeProviderId === deleteTarget.id;

  return (
    <div className={page}>
      <Title1 as="h1" className={styles.title}>
        {t('settings.title')}
      </Title1>

      {/* A1 三态收编：草稿未就绪时 loading 占位（此前整页空白）或载入失败
          红字；错误态保留原有 Text 形态（载入失败无自动重试路径，重试 =
          重新进入设置页） */}
      {draft && loaded ? (
        <>
          <div className={styles.stack}>
            <SettingsCard title={t('settings.appearance')}>
              <SettingsRow
                icon={<Color20Regular />}
                title={t('settings.theme')}
                description={t('settings.themeDesc')}
                control={
                  <RadioGroup
                    layout="horizontal"
                    aria-label={t('settings.theme')}
                    value={draft.uiTheme}
                    onChange={(_, d) => {
                      patch({ uiTheme: d.value });
                      // 改动即生效（既有 ui store 动作，AppProviders 消费），落盘交自动保存
                      setTheme(d.value as ThemeSetting);
                    }}
                  >
                    <Radio value="system" label={t('settings.themeSystem')} />
                    <Radio value="light" label={t('settings.themeLight')} />
                    <Radio value="dark" label={t('settings.themeDark')} />
                  </RadioGroup>
                }
              />
              <SettingsDivider />
              <SettingsRow
                icon={<Globe20Regular />}
                title={t('settings.language')}
                description={t('settings.languageDesc')}
                control={
                  <RadioGroup
                    layout="horizontal"
                    aria-label={t('settings.language')}
                    value={draft.uiLanguage}
                    onChange={(_, d) => {
                      patch({ uiLanguage: d.value });
                      setLanguage(d.value as LanguageSetting);
                    }}
                  >
                    <Radio value="system" label={t('settings.languageSystem')} />
                    <Radio value="zh" label={t('settings.languageZh')} />
                    <Radio value="en" label={t('settings.languageEn')} />
                  </RadioGroup>
                }
              />
            </SettingsCard>

            {/* 节奏卡（视觉件抽在 RhythmSettingsCard）：文本态与解析留在本层 */}
            <RhythmSettingsCard
              rhythmMsPerChar={draft.rhythmMsPerChar}
              onRhythmChange={(value) => patch({ rhythmMsPerChar: value })}
              punctPauseEnabled={draft.punctPauseEnabled}
              onPunctPauseChange={(checked) => patch({ punctPauseEnabled: checked })}
              animBaseText={animBaseText}
              onAnimBaseTextChange={(text) => {
                setAnimBaseText(text);
                const parsed = parseAnimBaseMs(text);
                if (parsed !== null) patch({ animDurationBase: parsed });
              }}
              animBaseInvalid={animBase === null}
            />

            {/* 近景窗口可选化（ADR-004 参数化）：近景携带的已结算场景数，数字输入 */}
            <SettingsCard title={t('settings.contextCard')}>
              <SettingsRow
                icon={<Book20Regular />}
                title={t('settings.nearScenes')}
                description={t('settings.nearScenesDesc')}
                control={
                  <Input
                    className={styles.animInput}
                    type="number"
                    min={1}
                    max={6}
                    step={1}
                    value={nearScenesText}
                    aria-label={t('settings.nearScenes')}
                    onChange={(_, d) => {
                      setNearScenesText(d.value);
                      const parsed = parseNearScenes(d.value);
                      if (parsed !== null) patch({ nearScenes: parsed });
                    }}
                  />
                }
              />
              {nearScenes === null ? (
                <Text className={styles.rowIssue} role="alert">
                  {t('settings.issueNearScenes')}
                </Text>
              ) : null}
            </SettingsCard>

            <SettingsCard
              title={t('settings.provider')}
              footer={{
                // 修改即保存状态行（原先独占一行的状态区挪进底部提示位）
                hint: (
                  <div className={styles.status}>
                    {saveError ? (
                      <Text className={styles.issues} role="alert">
                        {t('settings.saveFailed')}: {saveError}
                      </Text>
                    ) : saving ? (
                      <Text>{t('settings.saving')}</Text>
                    ) : dirty && hasIssues ? (
                      <Badge appearance="tint" color="warning">
                        {t('settings.dirty')}
                      </Badge>
                    ) : dirty ? (
                      <Text>{t('settings.autosaveHint')}</Text>
                    ) : null}
                  </div>
                ),
                actions: (
                  <Button appearance="primary" icon={<Add16Regular />} onClick={addProvider}>
                    {t('settings.addProvider')}
                  </Button>
                ),
              }}
            >
              <div className={styles.providerBody}>
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
                        isActiveProvider={draft.activeProviderId === provider.id}
                        activeModel={draft.activeModel}
                        onChange={(p) => changeProvider(provider.id, p)}
                        onActivateModel={(model) => activateModel(provider.id, model)}
                        onRemoveModel={(index) => removeModel(provider.id, index)}
                        onDelete={() => setDeleteTarget(provider)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </SettingsCard>
          </div>

          {hasIssues && !saving ? (
            <Text className={styles.issues}>{issues.join('；')}</Text>
          ) : null}

          {/* 删除确认（UI-003）：激活中的 provider 要求先转移激活，确认键禁用。
              C1 收编：Esc/背板可取消，删除键红色弱化、取消键为主键。 */}
          <ConfirmDialog
            open={deleteTarget !== null}
            onOpenChange={(open) => {
              if (!open) setDeleteTarget(null);
            }}
            title={t('settings.deleteConfirmTitle')}
            content={
              deleteIsActive
                ? t('settings.deleteActiveBlocked')
                : t('settings.deleteConfirmBody', {
                    name: deleteTarget?.name.trim() || deleteTarget?.id,
                  })
            }
            confirmLabel={t('settings.deleteProvider')}
            cancelLabel={t('settings.cancel')}
            destructive
            confirmDisabled={deleteIsActive}
            onConfirm={confirmDelete}
          />
        </>
      ) : loadError !== null ? (
        <Text className={styles.issues} role="alert">
          {t('settings.loadFailed')}: {loadError}
        </Text>
      ) : (
        <div className={styles.loading}>
          <StateBlock state="loading" label={t('settings.loading')} />
        </div>
      )}

      <Text className={styles.hint}>{t('settings.hint')}</Text>
    </div>
  );
}
