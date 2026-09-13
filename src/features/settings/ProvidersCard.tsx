// 服务卡装配（UI-003「模型服务」，FR-009）：自 SettingsView 抽出的 provider
// 管理卡（2026-09-14 Task-13/CAND-22 纯搬移，行为零变化）——新建入口、provider
// 列表（ProviderCard 逐套编辑）与空态引导、footer 修改即保存状态行、删除确认
// 对话框（含激活占用拦截）。草稿是页级单一状态（SettingsView 持有）：本件经
// onDraftChange（透传父层 setDraft）做函数式更新，provider 增删改的草稿迁移
// 逻辑（改名跟随、默认模型二元组写入、删默认模型回落 withoutModel）自
// SettingsView 逐字搬入；saveError/saving/dirty/hasIssues 等页级派生态由父层
// 计算后传入，本件不做派生。
import { Badge, Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigDto, ProviderDto } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SettingsCard } from '../../components/SettingsCard';
import { newProviderId, withoutModel } from './preferences';
import { ProviderCard } from './ProviderCard';

const useStyles = makeStyles({
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
  /** 修改即保存状态行：整份草稿存在校验问题。 */
  hasIssues: boolean;
}

/** 服务卡：provider 新建/列表/空态 + 修改即保存状态行 + 删除确认（UI-003）。 */
export function ProvidersCard({
  draft,
  onDraftChange: setDraft,
  saving,
  saveError,
  dirty,
  hasIssues,
}: ProvidersCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  // 待确认的删除目标（UI-003）：激活中的 provider 要求先转移激活，确认键禁用
  const [deleteTarget, setDeleteTarget] = useState<ProviderDto | null>(null);

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

  const deleteIsActive = deleteTarget !== null && draft?.activeProviderId === deleteTarget.id;

  return (
    <>
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
