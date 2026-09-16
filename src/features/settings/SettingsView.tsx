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
  Textarea,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Book20Regular,
  ChatSettings20Regular,
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
  parseNearScenes,
  toDraft,
} from './preferences';
import { RhythmSettingsCard } from './RhythmSettingsCard';
import { ProvidersCard } from './ProvidersCard';
import { SettingsCard, SettingsDivider, SettingsRow } from '../../components/SettingsCard';
import { SegmentedControl } from '../../components/SegmentedControl';
import { MarkdownPreviewBox } from '../../components/MarkdownPreviewBox';

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
  // 系统提示词内容区：标题行下的全宽块（渲染预览 / 输入框），随卡面内距
  // （与角色编辑器人设块同结构，2026-09-15 用户定稿仿人设形态）
  systemPromptBody: {
    display: 'block',
    padding: '0px 20px 12px',
  },
  // Fluent Textarea 默认不自撑满父容器，显式拉满卡面可用宽
  systemPromptTextarea: {
    width: '100%',
  },
  // 系统提示词「预览|编辑」分段（与编辑器人设的 personaMode 同款行语言）
  systemPromptMode: {
    width: '112px',
    minWidth: '0px',
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
  // 近景场景数（近景窗口可选化）：「文本态 + 解析」输入。
  const [nearScenesText, setNearScenesText] = useState('');
  // 系统提示词预览 / 编辑是纯视图切换：不参与数据（落库走修改即保存，
  // 与角色编辑器人设块同款）。
  const [systemPromptEditing, setSystemPromptEditing] = useState(false);
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
        setNearScenesText(String(config.nearScenes));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      animDurationBase: draft.animDurationBase,
      renderStyle: draft.renderStyle,
      uiLanguage: draft.uiLanguage,
      uiTheme: draft.uiTheme,
      directorModel: loaded.directorModel,
      nearScenes: nearScenes ?? loaded.nearScenes,
      systemPrompt: draft.systemPrompt,
      temperature: draft.temperature,
      topP: draft.topP,
      frequencyPenalty: draft.frequencyPenalty,
      presencePenalty: draft.presencePenalty,
    };
  }, [loaded, draft, nearScenes]);

  // 脏状态：保存将写入的内容与载入基线逐字段比对
  const dirty = next !== null && loaded !== null && JSON.stringify(next) !== JSON.stringify(loaded);

  // 校验问题清单（非法即挡自动保存）：不再页面级渲染（各卡自带行内提示，
  // 页底汇总结语义重复，2026-09-14 按用户裁定裁撤），仅作保存闸门。
  const issues: string[] = [];
  if (draft) {
    if (draft.providers.some((p) => !isProviderValid(p))) issues.push(t('settings.issueProvider'));
    if (!isRhythmValid(draft.rhythmMsPerChar)) issues.push(t('settings.issueRhythm'));
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
              animDurationBase={draft.animDurationBase}
              onAnimDurationBaseChange={(value) => patch({ animDurationBase: value })}
            />

            {/* 上下文卡：近景窗口（ADR-004 参数化，数字输入）+ 全局系统提示词
                （2026-09-15，注入每次请求 system 消息最前段，仿角色编辑器人设块的
                预览/编辑切换形态） */}
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
              <SettingsDivider />
              <SettingsRow
                icon={<ChatSettings20Regular />}
                title={t('settings.systemPrompt')}
                description={t('settings.systemPromptDesc')}
                control={
                  <SegmentedControl
                    className={styles.systemPromptMode}
                    ariaLabel={t('settings.systemPromptViewLabel')}
                    value={systemPromptEditing ? 'edit' : 'preview'}
                    onChange={(v) => setSystemPromptEditing(v === 'edit')}
                    options={[
                      { value: 'preview', label: t('settings.systemPromptModePreview') },
                      { value: 'edit', label: t('settings.systemPromptModeEdit') },
                    ]}
                  />
                }
              />
              <div className={styles.systemPromptBody}>
                {systemPromptEditing ? (
                  <Textarea
                    className={styles.systemPromptTextarea}
                    value={draft.systemPrompt}
                    rows={4}
                    onChange={(_, d) => patch({ systemPrompt: d.value })}
                    aria-label={t('settings.systemPrompt')}
                    placeholder={t('settings.systemPromptPlaceholder')}
                  />
                ) : (
                  <MarkdownPreviewBox
                    text={draft.systemPrompt}
                    hint={t('settings.systemPromptPlaceholder')}
                  />
                )}
              </div>
            </SettingsCard>

            {/* 服务卡（装配抽在 ProvidersCard）：provider 增删改、空态引导与
                删除确认随卡搬家，页级草稿经 setDraft 透传；自动保存失败红字
                传入卡内 footer，成功/空闲路径不渲染状态行 */}
            <ProvidersCard draft={draft} onDraftChange={setDraft} saveError={saveError} />
          </div>
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

    </div>
  );
}
