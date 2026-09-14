/**
 * 节奏卡（FR-009 设置页）：出场动画风格下拉、动效基准滑杆、朗读节奏滑杆、
 * 标点停顿开关。从 SettingsView 抽出的纯展示卡（行为零变化）：草稿由父层
 * 持有，本件只回传改动，不自行落盘。
 * 行序 2026-09-14 对齐角色编辑器「输出动画」卡（风格 → 基准 → 节奏 → 标点）；
 * 滑杆 2026-09-14 换自绘复刻件 TooltipSlider（与编辑器弃用 Fluent Slider 同
 * 一口径，见 TooltipSlider 头注）——动效基准随之从「文本态 + 解析」输入简化
 * 为滑杆（值域内拖动，不再有非法中间态与 issueAnimBase 错误路径）。
 */
import { Switch, makeStyles } from '@fluentui/react-components';
import { Pause20Regular, Sparkle20Regular, Timer20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { DropdownPushButton } from '../../components/DropdownPushButton';
import { SettingsCard, SettingsDivider, SettingsRow } from '../../components/SettingsCard';
import { TooltipSlider } from '../../components/TooltipSlider';
// 滑杆与动效基准边界常量引用引擎单一事实源（与 characters/editor/AnimParamRows.tsx 同法），
// 不在组件内再写死数值（AGENTS.md「跨文件常量互指」已知坑）。
import { ANIM_STYLES, DUR_MAX_MS, DUR_MIN_MS, RHYTHM_MAX_MS, RHYTHM_MIN_MS } from '../../engine';

const useStyles = makeStyles({
  slider: {
    width: '240px',
  },
  // 全局风格下拉（复刻件）：三段档宽度口径，18 风格直显 8 行内滚
  styleSelect: {
    width: '200px',
  },
});

export interface RhythmSettingsCardProps {
  rhythmMsPerChar: number;
  onRhythmChange: (value: number) => void;
  /** 全局出场动画风格（2026-09-14）：新角色与「跟随全局」角色的演出回落值。 */
  renderStyle: string;
  onRenderStyleChange: (value: string) => void;
  punctPauseEnabled: boolean;
  onPunctPauseChange: (checked: boolean) => void;
  /** 动效基准 ms（引擎渲染值域内，滑杆限位）。 */
  animDurationBase: number;
  onAnimDurationBaseChange: (value: number) => void;
}

/** 风格 id → 展示标签；表外遗留串原样回显（与 pieces.tsx 的 styleLabelOf 同法）。 */
function styleLabelOf(id: string): string {
  return ANIM_STYLES.find((s) => s.id === id)?.label ?? id;
}

/** 节奏卡：风格下拉 + 动效基准/节奏滑杆 + 标点停顿（FR-009）。 */
export function RhythmSettingsCard(props: RhythmSettingsCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    // 卡标题与角色编辑器「输出动画」卡同源（characters.sectionAnim）。
    <SettingsCard title={t('characters.sectionAnim')}>
      <SettingsRow
        icon={<Sparkle20Regular />}
        title={t('characters.renderStyle')}
        description={t('characters.animFollowingGlobal', { value: styleLabelOf(props.renderStyle) })}
        control={
          <DropdownPushButton
            className={styles.styleSelect}
            ariaLabel={t('characters.renderStyle')}
            value={props.renderStyle}
            onChange={props.onRenderStyleChange}
            maxVisibleItems={8}
            options={ANIM_STYLES.map((s) => ({ value: s.id, label: s.label, detail: s.id }))}
          />
        }
      />
      <SettingsDivider />
      <SettingsRow
        icon={<Timer20Regular />}
        title={t('characters.animDuration')}
        description={t('characters.animFollowingGlobal', {
          value: `${props.animDurationBase}${t('characters.animDurationUnit')}`,
        })}
        control={
          <TooltipSlider
            className={styles.slider}
            min={DUR_MIN_MS}
            max={DUR_MAX_MS}
            step={10}
            value={props.animDurationBase}
            onChange={props.onAnimDurationBaseChange}
            ariaLabel={t('characters.animDuration')}
          />
        }
      />
      <SettingsDivider />
      <SettingsRow
        icon={<Timer20Regular />}
        title={t('characters.animRhythm')}
        description={t('characters.animFollowingGlobal', {
          value: `${props.rhythmMsPerChar}${t('characters.animRhythmUnit')}`,
        })}
        control={
          <TooltipSlider
            className={styles.slider}
            min={RHYTHM_MIN_MS}
            max={RHYTHM_MAX_MS}
            step={5}
            value={props.rhythmMsPerChar}
            onChange={props.onRhythmChange}
            ariaLabel={t('characters.animRhythm')}
          />
        }
      />
      <SettingsDivider />
      <SettingsRow
        icon={<Pause20Regular />}
        title={t('characters.animPunctPause')}
        description={t('characters.animFollowingGlobal', {
          value: props.punctPauseEnabled ? t('characters.animPunctOn') : t('characters.animPunctOff'),
        })}
        control={
          <Switch
            checked={props.punctPauseEnabled}
            aria-label={t('characters.animPunctPause')}
            onChange={(_, d) => props.onPunctPauseChange(d.checked)}
          />
        }
      />
    </SettingsCard>
  );
}
