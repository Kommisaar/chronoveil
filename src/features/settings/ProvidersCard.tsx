// 服务卡装配（UI-003「模型服务」，FR-009）：自 SettingsView 抽出的 provider
// 管理卡，2026-09-14 照参考稿重排为「清单-详情」双栏——顶部整宽「默认模型」
// 设置行（SettingsRow 同形制，右侧级联下拉选供应商→模型）；下方左列服务清单
// （盒形图标 + 名称 + 绿点；绿点 = 全局默认指向该服务，即「生效中」的对位语义），
// 底部「添加供应商」进入缓冲式新增表单（AddProviderForm，确认前不触碰页级
// 草稿）；右栏为选中服务的详情编辑面板（ProviderCard）。无服务时布局不分叉：
// 清单只剩「添加供应商」入口（选中态），右栏即新增表单。选中态是本卡的本地
// UI 态：默认落第一个服务，点清单切换；删除选中服务后经派生回落到第一个剩
// 余服务（选中 id 悬空不清理，避免在删除路径上做额外状态手术）。草稿是页级
// 单一状态（SettingsView 持有）：
// 本件经 onDraftChange（透传父层 setDraft）做函数式更新，provider 增删改的
// 草稿迁移逻辑（改名跟随、默认模型二元组写入、删默认模型回落 withoutModel）
// 自 SettingsView 逐字搬入；保存失败红字（saveError）由父层传入，footer 仅此
// 一项，成功/空闲路径不渲染。
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { Add16Regular, Box16Regular, Chat20Regular, Temperature20Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigDto, ProviderDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DropdownPushButton } from '../../components/DropdownPushButton';
import { SettingsCard, SettingsDivider, SettingsRow } from '../../components/SettingsCard';
import { TooltipSlider } from '../../components/TooltipSlider';
import {
  newProviderId,
  PENALTY_MAX,
  PENALTY_MIN,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TOP_P_MAX,
  TOP_P_MIN,
  withoutModel,
} from './preferences';
import { ProviderCard } from './ProviderCard';
import { AddProviderForm } from './AddProviderForm';

const useStyles = makeStyles({
  // 清单-详情双栏：左列固定宽，右栏吃剩余宽。无服务时同样渲染（清单只剩
  // 「添加供应商」入口，右栏即新增表单），布局不分叉。
  panes: {
    display: 'flex',
    alignItems: 'stretch',
    gap: tokens.spacingHorizontalL,
    padding: '16px 20px',
  },
  // 左列清单：右缘分隔线与详情区分栏（会话侧栏 inner 同款描边语言）
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    flexShrink: 0,
    width: '200px',
    paddingRight: tokens.spacingHorizontalM,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // 清单项（参考稿：盒形图标 + 名称 + 状态点；选中项描边盒）。minWidth 0
  // 保证长名称省略号生效（flex 子项默认 min-width:auto）
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    minHeight: '40px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: '1px solid transparent',
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  // 选中项：描边盒（参考稿 DeepSeek 选中态），悬停不加深（完整 border 简写，
  // 与基础类的 border 简写同槽——griffel 同槽禁简写/长手混用）
  navItemActive: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1 },
  },
  navIcon: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase300,
  },
  navLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 绿点 = 全局默认指向该服务（「生效中」的对位标记，视觉而外无文字）
  navDot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorPaletteGreenForeground1,
  },
  // 添加入口钉在清单底部：清单短时贴近清单，与详情卡自然增长一致
  navAdd: {
    marginTop: tokens.spacingVerticalS,
  },
  // 顶部整宽「默认模型」设置行（SettingsRow 同款形制）的右侧级联钮：定宽
  // 控件位（主题/近景行的控件同位），长文案省略号收进按钮自身
  defaultControl: {
    width: '280px',
  },
  // 「控制温度」行的滑杆：与节奏卡滑杆同宽口径
  temperatureSlider: {
    width: '240px',
  },
  // 右侧面板：吃剩余宽度；minWidth 0 防 Input 撑破分栏
  detail: {
    flex: 1,
    minWidth: 0,
  },
  // 保存失败红字（footer 状态行用）：与页级底部汇总（SettingsView 的 issues）
  // 同款视觉，组件内 makeStyles 本地化（RhythmSettingsCard 抽出同法）
  issues: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  // 保存失败状态行（footer）：minHeight 防状态切换跳动
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minHeight: tokens.spacingVerticalL,
  },
});

export interface ProvidersCardProps {
  /** 整份 config 草稿（父层持有；本件只读，更新经 onDraftChange 回传）。 */
  draft: ConfigDto;
  /** 草稿函数式更新入口（透传父层 setDraft；搬入的更新器逐字保留 null 守卫）。 */
  onDraftChange: (update: (d: ConfigDto | null) => ConfigDto | null) => void;
  /** 上次自动保存落盘失败原因（非 null 时 footer 红字展示；成功/空闲不渲染
   *  footer——状态行已按用户裁定裁撤，仅错误出口保留）。 */
  saveError: string | null;
}

/** 服务卡：左列服务清单 + 右侧详情/新增表单 + 修改即保存失败行 + 删除确认
 *  （UI-003）。 */
export function ProvidersCard({
  draft,
  onDraftChange: setDraft,
  saveError,
}: ProvidersCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  // 待确认的删除目标（UI-003）：激活中的 provider 要求先转移激活，确认键禁用
  const [deleteTarget, setDeleteTarget] = useState<ProviderDto | null>(null);
  // 左列选中的服务 id（本地 UI 态）：悬空 id 经派生回落第一个服务，不在
  // 删除路径上做状态清理（见组件头注）。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 新增模式：右栏切换为缓冲式 AddProviderForm（确认前不触碰页级草稿）。
  const [adding, setAdding] = useState(false);
  const selected =
    draft.providers.find((p) => p.id === selectedId) ?? draft.providers[0] ?? null;
  // 无服务时新增表单即右栏（也不再渲染空清单列）
  const inAddMode = adding || draft.providers.length === 0;

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
        const idx = prev.models.findIndex((m) => m.id === activeModel);
        if (idx >= 0 && nextProvider.models[idx] !== undefined && nextProvider.models[idx]!.id !== activeModel) {
          activeModel = nextProvider.models[idx]!.id;
        }
      }
      return {
        ...d,
        activeModel,
        providers: d.providers.map((p) => (p.id === id ? nextProvider : p)),
      };
    });

  /** 缓冲新增确认：id 在父级此处生成（顺带落选中），整套入草稿并由修改即
   *  保存链路落盘。 */
  const confirmAdd = (provider: Omit<ProviderDto, 'id'>) => {
    const id = newProviderId();
    setAdding(false);
    setSelectedId(id);
    setDraft((d) => (d === null ? d : { ...d, providers: [...d.providers, { ...provider, id }] }));
  };

  /** 模型行「设为默认」：整对写入 (activeProviderId, activeModel)。 */
  const activateModel = (providerId: string, model: string) =>
    setDraft((d) => (d === null ? d : { ...d, activeProviderId: providerId, activeModel: model }));

  // 「默认模型」级联菜单：一级 = 供应商、二级 = 模型。叶子 value 用
  // 「providerId::modelId」复合键（provider id 为 uuid，'::' 不可能撞），选中
  // 后拆回整对写入全局默认。叶子 label 是裸模型名——二级菜单里服务名就在父行
  // 上（2026-09-14 用户反馈去前缀），触发钮由组件组合「服务 / 模型」补回。
  const defaultOptions = draft.providers.map((p) => ({
    value: p.id,
    label: p.name.trim() || t('settings.providerNamePlaceholder'),
    children: p.models.map((m) => ({
      value: `${p.id}::${m.id}`,
      label: m.id,
    })),
  }));
  const defaultValue =
    draft.activeProviderId !== null && draft.activeModel !== null
      ? `${draft.activeProviderId}::${draft.activeModel}`
      : '';
  const confirmDefault = (composite: string) => {
    const sep = composite.indexOf('::');
    if (sep < 0) return;
    activateModel(composite.slice(0, sep), composite.slice(sep + 2));
  };

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

  const deleteIsActive = deleteTarget !== null && draft?.activeProviderId === deleteTarget.id;

  return (
    <>
      <SettingsCard
        title={t('settings.provider')}
        // footer 仅承载自动保存失败红字（错误必须可见）；成功/空闲路径不渲染
        // footer，正常使用中状态行整体不存在。（exactOptionalPropertyTypes 下
        // 不能显式传 footer=undefined，用条件展开表达「无 footer」。）
        {...(saveError !== null
          ? {
              footer: {
                hint: (
                  <div className={styles.status}>
                    <Text className={styles.issues} role="alert">
                      {t('settings.saveFailed')}: {saveError}
                    </Text>
                  </div>
                ),
              },
            }
          : {})}
      >
        {/* 顶部整宽「默认模型」行（与其他设置卡行同形制）：左图标 + 标题/描述，
            右侧级联下拉（一级供应商、二级模型）；行下分隔线隔开双栏区。 */}
        <SettingsRow
          icon={<Chat20Regular />}
          title={t('settings.defaultModel')}
          description={t('settings.defaultModelDesc')}
          control={
            <DropdownPushButton
              className={styles.defaultControl}
              ariaLabel={t('settings.defaultModel')}
              value={defaultValue}
              placeholder={t('settings.defaultModelNone')}
              maxVisibleItems={8}
              options={defaultOptions}
              onChange={confirmDefault}
            />
          }
        />
        <SettingsDivider />
        {/* 控制温度行：滑杆 0–2（步进 0.1）天然限位，值域内无非法中间态，
            改动随整份草稿走修改即保存链路落盘。 */}
        <SettingsRow
          icon={<Temperature20Regular />}
          title={t('settings.temperature')}
          description={t('settings.temperatureDesc', { value: draft.temperature.toFixed(1) })}
          control={
            <TooltipSlider
              className={styles.temperatureSlider}
              min={TEMPERATURE_MIN}
              max={TEMPERATURE_MAX}
              step={0.1}
              value={draft.temperature}
              onChange={(value) =>
                setDraft((d) => (d === null ? d : { ...d, temperature: value }))
              }
              ariaLabel={t('settings.temperature')}
              formatValue={(value) => value.toFixed(1)}
            />
          }
        />
        <SettingsDivider />
        {/* 核采样 top_p 行（2026-09-16 采样参数三键）：滑杆 0–1（步进 0.05），
            1 = 不截断；三协议都下发。 */}
        <SettingsRow
          title={t('settings.topP')}
          description={t('settings.topPDesc', { value: draft.topP.toFixed(2) })}
          control={
            <TooltipSlider
              className={styles.temperatureSlider}
              min={TOP_P_MIN}
              max={TOP_P_MAX}
              step={0.05}
              value={draft.topP}
              onChange={(value) => setDraft((d) => (d === null ? d : { ...d, topP: value }))}
              ariaLabel={t('settings.topP')}
              formatValue={(value) => value.toFixed(2)}
            />
          }
        />
        <SettingsDivider />
        {/* 频率惩罚行：滑杆 −2–2（步进 0.1），正值压重复措辞（角色扮演长对话
            的复读痛点）；仅 OpenAI 兼容协议下发（协议适配层取舍，见
            infra/llm/wire_openai）。 */}
        <SettingsRow
          title={t('settings.frequencyPenalty')}
          description={t('settings.frequencyPenaltyDesc', { value: draft.frequencyPenalty.toFixed(1) })}
          control={
            <TooltipSlider
              className={styles.temperatureSlider}
              min={PENALTY_MIN}
              max={PENALTY_MAX}
              step={0.1}
              value={draft.frequencyPenalty}
              onChange={(value) =>
                setDraft((d) => (d === null ? d : { ...d, frequencyPenalty: value }))
              }
              ariaLabel={t('settings.frequencyPenalty')}
              formatValue={(value) => value.toFixed(1)}
            />
          }
        />
        <SettingsDivider />
        {/* 存在惩罚行：滑杆 −2–2（步进 0.1），正值鼓励引入新话题；下发域同
            频率惩罚。 */}
        <SettingsRow
          title={t('settings.presencePenalty')}
          description={t('settings.presencePenaltyDesc', { value: draft.presencePenalty.toFixed(1) })}
          control={
            <TooltipSlider
              className={styles.temperatureSlider}
              min={PENALTY_MIN}
              max={PENALTY_MAX}
              step={0.1}
              value={draft.presencePenalty}
              onChange={(value) =>
                setDraft((d) => (d === null ? d : { ...d, presencePenalty: value }))
              }
              ariaLabel={t('settings.presencePenalty')}
              formatValue={(value) => value.toFixed(1)}
            />
          }
        />
        <SettingsDivider />
        <div className={styles.panes}>
          {/* 左列：服务清单（盒形图标 + 名称 + 全局默认绿点）+ 添加供应商。
              清单项可访问名 = 名称文本自然拼接（图标 aria-hidden）。 */}
          <div className={styles.nav} role="group" aria-label={t('settings.provider')}>
            {draft.providers.map((provider) => {
              const isDefaultProvider = draft.activeProviderId === provider.id;
              const isSelected = !inAddMode && selected !== null && provider.id === selected.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  className={`${styles.navItem} ${isSelected ? styles.navItemActive : ''}`}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => {
                    setAdding(false);
                    setSelectedId(provider.id);
                  }}
                >
                  <Box16Regular className={styles.navIcon} aria-hidden />
                  <span className={styles.navLabel}>
                    {provider.name.trim() || t('settings.providerNamePlaceholder')}
                  </span>
                  {isDefaultProvider ? <span className={styles.navDot} aria-hidden /> : null}
                </button>
              );
            })}
            <button
              type="button"
              className={`${styles.navItem} ${styles.navAdd} ${inAddMode ? styles.navItemActive : ''}`}
              aria-current={inAddMode ? 'true' : undefined}
              onClick={() => setAdding(true)}
            >
              <Add16Regular className={styles.navIcon} aria-hidden />
              <span className={styles.navLabel}>{t('settings.addProvider')}</span>
            </button>
          </div>
          {/* 右栏：新增缓冲表单或选中服务的详情编辑面板（无服务时 inAddMode
              恒真，右栏即新增表单，左列只剩添加入口）。 */}
          <div className={styles.detail}>
            {inAddMode ? (
              <AddProviderForm onConfirm={confirmAdd} />
            ) : selected !== null ? (
              <ProviderCard
                key={selected.id}
                provider={selected}
                isDefaultProvider={draft.activeProviderId === selected.id}
                activeModel={draft.activeModel}
                onChange={(p) => changeProvider(selected.id, p)}
                onActivateModel={(model) => activateModel(selected.id, model)}
                onRemoveModel={(index) => removeModel(selected.id, index)}
                onDelete={() => setDeleteTarget(selected)}
              />
            ) : null}
          </div>
        </div>
      </SettingsCard>

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
  );
}
