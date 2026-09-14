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
  Input,
  Radio,
  RadioGroup,
  Text,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Book20Regular,
  Color20Regular,
  Globe20Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getConfig, saveConfig } from '../../api/commands';
import type { ConfigDto, LanguageSetting, ThemeSetting } from '../../api/types';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { StateBlock } from '../../components/StateBlock';
import { useUiStore } from '../../stores/ui';
import {
  NEAR_SCENES_MAX,
  NEAR_SCENES_MIN,
  isProviderValid,
  isRhythmValid,
  parseAnimBaseMs,
  parseNearScenes,
  toDraft,
} from './preferences';
import { RhythmSettingsCard } from './RhythmSettingsCard';
import { ProvidersCard } from './ProvidersCard';
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
  issues: {
    color: tokens.colorPaletteRedForeground1,
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
      renderStyle: draft.renderStyle,
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
              renderStyle={draft.renderStyle}
              onRenderStyleChange={(value) => patch({ renderStyle: value })}
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
                    // 边界接单一事实源：preferences.ts NEAR_SCENES_MIN/MAX（与
                    // infra/config.rs、api/mock/config.ts 校验域互指）
                    min={NEAR_SCENES_MIN}
                    max={NEAR_SCENES_MAX}
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

            {/* 服务卡（装配抽在 ProvidersCard）：provider 增删改、空态引导与
                删除确认随卡搬家，页级草稿经 setDraft 透传，footer 修改即保存
                状态行的入参由本层派生传入 */}
            <ProvidersCard
              draft={draft}
              onDraftChange={setDraft}
              saving={saving}
              saveError={saveError}
              dirty={dirty}
              hasIssues={hasIssues}
            />
          </div>

          {hasIssues && !saving ? (
            <Text className={styles.issues}>{issues.join('；')}</Text>
          ) : null}
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
