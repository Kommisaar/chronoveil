/**
 * 模型配置卡的两条覆写行（2026-09-14 自 pieces.tsx 拆出：原文件触及 500 行
 * 上限；同日按用户定稿改两行独立，各自持有跟随/自定义语义，互不牵连）：
 * - 模型设置行：按钮二级级联菜单（与设置页「默认模型」同件）——一级服务、
 *   二级模型，跟随/清空语义由行内「跟随全局」分段托管；存量模型不在所选
 *   服务列表（服务改配/换服务）时追加为额外叶子，不因菜单命中失败而显示
 *   成跟随。原「默认模型」叶子（只切服务不指名模型，model 空串）已按用户
 *   裁定删除（2026-09-15）：覆写必指名具体模型；模型空串回落到首模型的
 *   语义仅存于全局默认删除路径（解析层）。
 * - 温度行：「跟随|自定义」分段 + 滑杆（AnimParamRows 同法：跟随态滑杆禁用
 *   压暗，切自定义以当前展示值写卡；描述展示当前生效值）。
 * 覆写值为三扁平字段（modelProviderId / modelName / modelTemperature，
 * 列语义：空串 / null = 跟随全局）。
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { ProviderDto } from '../../../api/types';
import { SettingsDivider, SettingsRow } from '../../../components/SettingsCard';
import {
  DropdownPushButton,
  type DropdownPushOption,
} from '../../../components/DropdownPushButton';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { TooltipSlider } from '../../../components/TooltipSlider';

// 温度滑杆值域：与 infra/config.rs TEMPERATURE_MIN/MAX（0–2，默认 0.7）及
// features/settings/preferences.ts 同一约束两端——features 之间禁止互相引用，
// 按「跨文件常量互指」纪律以同值字面量 + 本注释对齐。
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const TEMPERATURE_STEP = 0.1;

// 采样参数三覆写（2026-09-16）：值域与 infra/config.rs 的 TOP_P_MIN/MAX、
// PENALTY_MIN/MAX 及 settings/preferences.ts 同域互指（跨文件常量互指纪律）。
const TOP_P_MIN = 0;
const TOP_P_MAX = 1;
const TOP_P_STEP = 0.05;
const PENALTY_MIN = -2;
const PENALTY_MAX = 2;
const PENALTY_STEP = 0.1;

// 级联叶子复合键分隔符：provider id 为 uuid，'::' 不会出现在真实 id 里
//（与设置页默认模型菜单同一约定，跨文件互指）。
const COMPOSITE_SEP = '::';

const useStyles = makeStyles({
  // 温度行控件：滑杆 + 跟随|自定义分段横排（AnimParamRows 同款行语言）
  tempControl: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  // 滑杆宽度：与 AnimParamRows 的滑杆行同宽口径（挂包裹层）
  slider: {
    width: '160px',
    minWidth: '0px',
  },
  modeSegment: {
    width: '136px',
    minWidth: '0px',
  },
  // 模型设置行级联钮：与温度滑杆同宽（160px）
  modelSelect: {
    width: '160px',
  },
});

export function OverrideSection(props: {
  /** 模型覆写三扁平字段（空串/null = 跟随全局）。 */
  modelProviderId: string;
  modelName: string;
  modelTemperature: number | null;
  /** 模型行写入（级联选叶 / 切分段）：providerId 与模型名成对更新。 */
  onModelOverrideChange: (providerId: string, modelName: string) => void;
  /** 温度行写入；null = 跟随全局。 */
  onTemperatureChange: (value: number | null) => void;
  /** 采样参数三覆写（2026-09-16）；null = 跟随全局，语义同温度行。 */
  modelTopP: number | null;
  onTopPChange: (value: number | null) => void;
  modelFrequencyPenalty: number | null;
  onFrequencyPenaltyChange: (value: number | null) => void;
  modelPresencePenalty: number | null;
  onPresencePenaltyChange: (value: number | null) => void;
  providers: ProviderDto[];
  /** 全局采样温度（animDefaults 派生）：跟随态的展示值与切自定义的落点。 */
  globalTemperature: number;
  /** 全局采样参数基准（animDefaults 派生）：跟随态展示值与切自定义的落点。 */
  globalTopP: number;
  globalFrequencyPenalty: number;
  globalPresencePenalty: number;
  /** 全局默认模型的 (providerId, modelId)（animDefaults 派生；空串 = 未配置）：
   *  跟随态展示值与切自定义的写卡落点（AnimParamRows 同法）。 */
  globalProviderId: string;
  globalModelId: string;
}) {
  const localStyles = useStyles();
  const { t } = useTranslation();
  const { modelProviderId, modelName } = props;
  const selectedProvider = props.providers.find((p) => p.id === modelProviderId);
  // 存量覆写里的模型名不在所选服务列表（服务改配/换服务）→ 追加为额外叶子，
  // 避免菜单命中失败而显示成"跟随全局"却实际覆写着旧值。
  const staleModel =
    selectedProvider !== undefined &&
    modelName !== '' &&
    !selectedProvider.models.some((m) => m.id === modelName)
      ? modelName
      : null;
  // 模型行模式：有覆写即自定义（切自定义瞬间以全局默认写卡，内容即非空，
  // 分段不会弹回）。
  const hasModelOverride = modelProviderId !== '' || modelName !== '';
  const modelMode = hasModelOverride ? 'custom' : 'follow';
  // 级联菜单：一级 = 服务（不可选），二级 = 该服务的模型叶子（存量遗留模型
  // 追加为额外叶子，见 staleModel）。跟随/自定义由行内分段托管，菜单里不放
  // 「跟随全局」叶子。叶子 label 用裸名（服务名在父行上，前缀冗余；触发钮
  // 由组件组合「服务 / 叶」，与设置页默认模型菜单同一契约——见
  // DropdownPushOption.children 注）。
  const modelOptions: DropdownPushOption[] = props.providers.map((p) => ({
    value: p.id,
    label: p.name,
    children: [
      ...(p.id === modelProviderId && staleModel !== null
        ? [{ value: `${p.id}${COMPOSITE_SEP}${staleModel}`, label: staleModel }]
        : []),
      ...p.models.map((m) => ({
        value: `${p.id}${COMPOSITE_SEP}${m.id}`,
        label: m.id,
      })),
    ],
  }));
  // 触发钮值：自定义显覆写复合键；跟随显全局默认（按钮禁用只作展示，
  // AnimParamRows 的「禁用滑杆显全局值」同法）。全局未配置 → 空串命中跟随叶子。
  const overrideComposite =
    modelProviderId === '' ? '' : `${modelProviderId}${COMPOSITE_SEP}${modelName}`;
  const globalComposite = `${props.globalProviderId}${COMPOSITE_SEP}${props.globalModelId}`;
  const onModelSelect = (composite: string): void => {
    // 叶子恒为「providerId::modelId」形（跟随语义走分段，不经菜单）。
    const sep = composite.indexOf(COMPOSITE_SEP);
    props.onModelOverrideChange(
      composite.slice(0, sep),
      composite.slice(sep + COMPOSITE_SEP.length),
    );
  };
  const temperature = props.modelTemperature;
  // 采样标量行构造（温度 + 三采样行共用，2026-09-16）：null = 跟随全局，
  // 跟随态滑杆禁用压暗展示全局值，切自定义以当前展示值写卡（与温度行既有
  // 语义逐字对齐）。
  const samplingRow = (args: {
    title: string;
    value: number | null;
    globalValue: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number | null) => void;
    format: (value: number) => string;
  }) => {
    const custom = args.value !== null;
    const shown = args.value ?? args.globalValue;
    return (
      <SettingsRow
        title={args.title}
        description={
          custom
            ? t('characters.animCustomized', { value: args.format(shown) })
            : t('characters.animFollowingGlobal', { value: args.format(args.globalValue) })
        }
        control={
          <div className={localStyles.tempControl}>
            <TooltipSlider
              className={localStyles.slider}
              min={args.min}
              max={args.max}
              step={args.step}
              value={shown}
              onChange={args.onChange}
              ariaLabel={args.title}
              formatValue={args.format}
              disabled={!custom}
            />
            <SegmentedControl
              className={localStyles.modeSegment}
              ariaLabel={args.title}
              value={custom ? 'custom' : 'follow'}
              onChange={(v) => args.onChange(v === 'custom' ? args.value ?? args.globalValue : null)}
              options={[
                { value: 'follow', label: t('characters.animModeFollow') },
                { value: 'custom', label: t('characters.animModeCustom') },
              ]}
            />
          </div>
        }
      />
    );
  };
  return (
    <>
      {/* 行 1：模型设置——级联菜单按钮 + 跟随|自定义分段（AnimParamRows 版式：
          跟随态按钮禁用、展示全局默认；切自定义以当前展示值（全局默认）写卡）。 */}
      <SettingsRow
        title={t('characters.modelOverride')}
        description={
          modelMode === 'follow' ? t('characters.overrideFollowDesc') : t('characters.overrideHint')
        }
        control={
          <div className={localStyles.tempControl}>
            <DropdownPushButton
              className={localStyles.modelSelect}
              ariaLabel={t('characters.modelOverride')}
              value={modelMode === 'custom' ? overrideComposite : globalComposite}
              placeholder={t('characters.followGlobal')}
              maxVisibleItems={8}
              options={modelOptions}
              onChange={onModelSelect}
              disabled={modelMode === 'follow'}
            />
            <SegmentedControl
              className={localStyles.modeSegment}
              ariaLabel={t('characters.modelOverride')}
              value={modelMode}
              onChange={(v) => {
                if (v === 'custom') {
                  // 切自定义：以当前展示值（全局默认）写卡——内容即非空，分段
                  // 稳定停在自定义；全局未配置时写空（仍跟随，按钮不启用）。
                  props.onModelOverrideChange(props.globalProviderId, props.globalModelId);
                } else {
                  // 切跟随：清模型覆写（温度不动）。
                  props.onModelOverrideChange('', '');
                }
              }}
              options={[
                { value: 'follow', label: t('characters.animModeFollow') },
                { value: 'custom', label: t('characters.animModeCustom') },
              ]}
            />
          </div>
        }
      />
      <SettingsDivider />
      {/* 行 2：温度——独立「跟随|自定义」+ 滑杆（跟随态滑杆禁用压暗，
          切自定义以当前展示值写卡；描述展示当前生效值）。 */}
      {samplingRow({
        title: t('characters.temperature'),
        value: temperature,
        globalValue: props.globalTemperature,
        min: TEMPERATURE_MIN,
        max: TEMPERATURE_MAX,
        step: TEMPERATURE_STEP,
        onChange: props.onTemperatureChange,
        format: (value) => value.toFixed(1),
      })}
      {/* 行 3–5：采样参数三行（2026-09-16）——top_p / 频率惩罚 / 存在惩罚，
          与温度行同款跟随语义；惩罚仅 OpenAI 兼容协议消费（wire 层取舍）。 */}
      {samplingRow({
        title: t('characters.topP'),
        value: props.modelTopP,
        globalValue: props.globalTopP,
        min: TOP_P_MIN,
        max: TOP_P_MAX,
        step: TOP_P_STEP,
        onChange: props.onTopPChange,
        format: (value) => value.toFixed(2),
      })}
      {samplingRow({
        title: t('characters.frequencyPenalty'),
        value: props.modelFrequencyPenalty,
        globalValue: props.globalFrequencyPenalty,
        min: PENALTY_MIN,
        max: PENALTY_MAX,
        step: PENALTY_STEP,
        onChange: props.onFrequencyPenaltyChange,
        format: (value) => value.toFixed(1),
      })}
      {samplingRow({
        title: t('characters.presencePenalty'),
        value: props.modelPresencePenalty,
        globalValue: props.globalPresencePenalty,
        min: PENALTY_MIN,
        max: PENALTY_MAX,
        step: PENALTY_STEP,
        onChange: props.onPresencePenaltyChange,
        format: (value) => value.toFixed(1),
      })}
    </>
  );
}
