// 服务卡装配（UI-003「模型服务」，FR-009）：自 SettingsView 抽出的 provider
// 管理卡，2026-09-14 改「列表-详情」结构——左列是已配置服务清单（名称 +
// 协议小字 + 默认徽标，选中态视觉沿用会话侧栏的语言：1Selected 底 + 悬停
// 同底），右侧是选中服务的详情编辑面板（ProviderCard，字段与行为不变）。
// 选中态是本卡的本地 UI 态：默认落第一个服务，点清单切换；新建的服务直接
// 落选中（用户随即填表）；删除选中服务后经派生回落到第一个剩余服务（选中
// id 悬空不清理，避免在删除路径上做额外状态手术）。空态时退回单列引导
// （虚线框 + 新建钮），不渲染空左列。草稿是页级单一状态（SettingsView 持
// 有）：本件经 onDraftChange（透传父层 setDraft）做函数式更新，provider
// 增删改的草稿迁移逻辑（改名跟随、默认模型二元组写入、删默认模型回落
// withoutModel）自 SettingsView 逐字搬入；saveError/saving/dirty 等页级派
// 生态由父层计算后传入，本件不做派生。
import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigDto, ProviderDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SettingsCard } from '../../components/SettingsCard';
import {
  newProviderId,
  PROTOCOL_LABEL_KEYS,
  withoutModel,
} from './preferences';
import { ProviderCard } from './ProviderCard';

const useStyles = makeStyles({
  // 列表-详情双栏：左列固定宽（与会话侧栏同档的清单形态），右栏吃剩余宽
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
  // 清单项（会话侧栏 item 同法）：两行——名称 + 协议小字；minWidth 0 保
  // 证长名称省略号生效（flex 子项默认 min-width:auto）
  navItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '2px',
    width: '100%',
    minHeight: '44px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    textAlign: 'left',
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  // 选中态：1Selected 底且悬停不加深（反压基础 hover，侧栏 itemActive 同法）
  navItemActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Selected },
  },
  navLabel: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
  },
  navMeta: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  // 新建钮固定清单底部：清单短时贴近清单（不吸底，与服务卡高度自然增长
  // 的现状一致），marginTop 拉开与末项的间距
  navAdd: {
    marginTop: tokens.spacingVerticalS,
    width: '100%',
  },
  // 右侧详情面板：吃剩余宽度；minWidth 0 防 Input 撑破分栏
  detail: {
    flex: 1,
    minWidth: 0,
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
  // 保存失败红字（footer 状态行用）：与页级底部汇总（SettingsView 的 issues）
  // 同款视觉，组件内 makeStyles 本地化（RhythmSettingsCard 抽出同法）
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
});

export interface ProvidersCardProps {
  /** 整份 config 草稿（父层持有；本件只读，更新经 onDraftChange 回传）。 */
  draft: ConfigDto;
  /** 草稿函数式更新入口（透传父层 setDraft；搬入的更新器逐字保留 null 守卫）。 */
  onDraftChange: (update: (d: ConfigDto | null) => ConfigDto | null) => void;
  /** 修改即保存状态行（页级派生态，footer 展示）：保存中。 */
  saving: boolean;
  /** 修改即保存状态行：上次落盘失败原因（非 null 时红字展示）。 */
  saveError: string | null;
  /** 修改即保存状态行：草稿与载入基线不一致。 */
  dirty: boolean;
}

/** 服务卡：左列服务清单 + 右侧详情编辑 + 空态引导 + 修改即保存状态行 +
 *  删除确认（UI-003）。 */
export function ProvidersCard({
  draft,
  onDraftChange: setDraft,
  saving,
  saveError,
  dirty,
}: ProvidersCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  // 待确认的删除目标（UI-003）：激活中的 provider 要求先转移激活，确认键禁用
  const [deleteTarget, setDeleteTarget] = useState<ProviderDto | null>(null);
  // 左列选中的服务 id（本地 UI 态）：悬空 id 经派生回落第一个服务，不在
  // 删除路径上做状态清理（见组件头注）。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    draft.providers.find((p) => p.id === selectedId) ?? draft.providers[0] ?? null;

  const addProvider = () => {
    // id 在更新器外生成：新建后随即选中该服务（id 只在此一处产生，复用即选中）。
    const id = newProviderId();
    setSelectedId(id);
    setDraft((d) => {
      if (d === null) return d;
      const provider: ProviderDto = {
        id,
        name: '',
        baseUrl: '',
        apiKey: '',
        models: [],
        // 新建服务缺省 OpenAI 兼容协议（详情面板可切三档）。
        api: 'openai',
      };
      return { ...d, providers: [...d.providers, provider] };
    });
  };

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

  const deleteIsActive = deleteTarget !== null && draft?.activeProviderId === deleteTarget.id;

  return (
    <>
      <SettingsCard
        title={t('settings.provider')}
        footer={{
          // 修改即保存状态行（新建入口在左列清单底部，footer 不再放动作钮）
          hint: (
            <div className={styles.status}>
              {saveError ? (
                <Text className={styles.issues} role="alert">
                  {t('settings.saveFailed')}: {saveError}
                </Text>
              ) : saving ? (
                <Text>{t('settings.saving')}</Text>
              ) : dirty ? (
                <Text>{t('settings.autosaveHint')}</Text>
              ) : null}
            </div>
          ),
        }}
      >
        {draft.providers.length === 0 ? (
          <div className={styles.empty}>
            <Text>{t('settings.providerEmpty')}</Text>
            <Button icon={<Add16Regular />} onClick={addProvider}>
              {t('settings.addProvider')}
            </Button>
          </div>
        ) : (
          <div className={styles.panes}>
            {/* 左列：服务清单（选中态按钮 + 协议/默认 meta 行）+ 新建入口。
                清单项可访问名 = 名称 + meta 文本自然拼接（单文本内容）。 */}
            <div className={styles.nav} role="group" aria-label={t('settings.provider')}>
              {draft.providers.map((provider) => {
                const isSelected = selected !== null && provider.id === selected.id;
                const metaParts = [t(PROTOCOL_LABEL_KEYS[provider.api])];
                if (draft.activeProviderId === provider.id) {
                  metaParts.push(t('settings.defaultBadge'));
                }
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className={`${styles.navItem} ${isSelected ? styles.navItemActive : ''}`}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => setSelectedId(provider.id)}
                  >
                    <span className={styles.navLabel}>
                      {provider.name.trim() || t('settings.providerNamePlaceholder')}
                    </span>
                    <span className={styles.navMeta}>{metaParts.join(' · ')}</span>
                  </button>
                );
              })}
              <Button
                className={styles.navAdd}
                icon={<Add16Regular />}
                onClick={addProvider}
              >
                {t('settings.addProvider')}
              </Button>
            </div>
            {/* 右栏：选中服务的详情编辑面板（字段与行为不变）。 */}
            {selected !== null ? (
              <div className={styles.detail}>
                <ProviderCard
                  key={selected.id}
                  provider={selected}
                  isActiveProvider={draft.activeProviderId === selected.id}
                  activeModel={draft.activeModel}
                  onChange={(p) => changeProvider(selected.id, p)}
                  onActivateModel={(model) => activateModel(selected.id, model)}
                  onRemoveModel={(index) => removeModel(selected.id, index)}
                  onDelete={() => setDeleteTarget(selected)}
                />
              </div>
            ) : null}
          </div>
        )}
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
