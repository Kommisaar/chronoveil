/**
 * 演出参数行组（2026-09-13 用户定稿）：输出动画卡的行 3–5——动效时长 /
 * 打字节奏 / 标点微停。null = 跟随全局（迁移 0013 列语义）：行描述展示全局
 * 当前值。范围与 Rust 命令层校验（character_inputs 的 ANIM_*_MIN/MAX）、
 * TS 引擎常量（DUR_MIN_MS 等）三方同源互指；滑杆本身取值在域内，正常路径
 * 不触越界。数值行刻意用滑杆而非数字输入框：受控输入框在修改即保存语义下
 * 会被逐键钳制值打断打字（输入「4」立即变「150」），滑杆无此问题。
 * 标点微停 2026-09-14 换自绘复刻件 SegmentedControl（分段选择器 + 指示条
 * 滑动动画），三段映射 null / true / false。行描述 2026-09-14 用户定稿
 * 始终显示（避免覆写切换时描述消失造成结构跳动）：跟随全局用
 * `animFollowingGlobal` 插值，覆写态前缀改「自定义」（`animCustomized`）。
 * 时长/节奏 2026-09-14 同日换「跟随|自定义」分段托管 null/数值模式：
 * 跟随态滑条禁用压暗，切「自定义」以当前展示值写卡（不再用还原钮）。
 */
import {
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { SettingsDivider, SettingsRow } from '../../../components/SettingsCard';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { TooltipSlider } from '../../../components/TooltipSlider';
import { DUR_MAX_MS, DUR_MIN_MS, RHYTHM_MAX_MS, RHYTHM_MIN_MS } from '../../../engine';
import type { AnimDefaults } from './useEditorForm';

const useStyles = makeStyles({
  rhythmControl: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  // 滑杆宽度：挂在 TooltipSlider 包裹层（自绘实现的根容器，轨与透明原生 input 满宽随层）
  sliderW160: {
    width: '160px',
    minWidth: '0px',
  },
  // 分段选择器宽度：容纳最长段文案「跟随全局」四字不换行（三段等宽 200px），
  // 与滑杆行同宽语言（挂 SegmentedControl 轨道层）
  paramSegment: {
    width: '200px',
    minWidth: '0px',
  },
  // 时长/节奏行的跟随|自定义模式段（「跟随全局」四字不换行的窄档）
  modeSegment: {
    width: '136px',
    minWidth: '0px',
  },
});

export interface AnimParamRowsProps {
  /** 卡覆写值；null = 跟随全局。 */
  durationMs: number | null;
  rhythmMs: number | null;
  punctPause: boolean | null;
  /** 「跟随全局」基准（全局配置派生）：null 行的展示值与滑杆落点。 */
  defaults: AnimDefaults;
  onDurationChange: (value: number | null) => void;
  onRhythmChange: (value: number | null) => void;
  onPunctChange: (value: boolean | null) => void;
}

export function AnimParamRows(props: AnimParamRowsProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const {
    durationMs,
    rhythmMs,
    punctPause,
    defaults,
    onDurationChange,
    onRhythmChange,
    onPunctChange,
  } = props;

  const followGlobal = t('characters.followGlobal');

  return (
    <>
      <SettingsRow
        title={t('characters.animDuration')}
        description={
          durationMs === null
            ? t('characters.animFollowingGlobal', {
                value: `${defaults.durationMs}${t('characters.animDurationUnit')}`,
              })
            : t('characters.animCustomized', {
                value: `${durationMs}${t('characters.animDurationUnit')}`,
              })
        }
        control={
          <div className={styles.rhythmControl}>
            {/* 跟随态滑条禁用（压暗置灰），值由分段「跟随」托管；切「自定义」
                即以当前展示值写卡（2026-09-14 用户定稿） */}
            <TooltipSlider
              className={styles.sliderW160}
              min={DUR_MIN_MS}
              max={DUR_MAX_MS}
              step={10}
              value={durationMs ?? defaults.durationMs}
              onChange={onDurationChange}
              ariaLabel={t('characters.animDuration')}
              disabled={durationMs === null}
            />
            <SegmentedControl
              className={styles.modeSegment}
              ariaLabel={t('characters.animDuration')}
              value={durationMs === null ? 'follow' : 'custom'}
              onChange={(v) =>
                onDurationChange(v === 'custom' ? (durationMs ?? defaults.durationMs) : null)
              }
              options={[
                { value: 'follow', label: t('characters.animModeFollow') },
                { value: 'custom', label: t('characters.animModeCustom') },
              ]}
            />
          </div>
        }
      />
      <SettingsDivider />
      <SettingsRow
        title={t('characters.animRhythm')}
        description={
          rhythmMs === null
            ? t('characters.animFollowingGlobal', {
                value: `${defaults.msPerChar}${t('characters.animRhythmUnit')}`,
              })
            : t('characters.animCustomized', {
                value: `${rhythmMs}${t('characters.animRhythmUnit')}`,
              })
        }
        control={
          <div className={styles.rhythmControl}>
            <TooltipSlider
              className={styles.sliderW160}
              min={RHYTHM_MIN_MS}
              max={RHYTHM_MAX_MS}
              step={5}
              value={rhythmMs ?? defaults.msPerChar}
              onChange={onRhythmChange}
              ariaLabel={t('characters.animRhythm')}
              disabled={rhythmMs === null}
            />
            <SegmentedControl
              className={styles.modeSegment}
              ariaLabel={t('characters.animRhythm')}
              value={rhythmMs === null ? 'follow' : 'custom'}
              onChange={(v) =>
                onRhythmChange(v === 'custom' ? (rhythmMs ?? defaults.msPerChar) : null)
              }
              options={[
                { value: 'follow', label: t('characters.animModeFollow') },
                { value: 'custom', label: t('characters.animModeCustom') },
              ]}
            />
          </div>
        }
      />
      <SettingsDivider />
      <SettingsRow
        title={t('characters.animPunctPause')}
        description={
          punctPause === null
            ? t('characters.animFollowingGlobal', {
                value: defaults.punctPause
                  ? t('characters.animPunctOn')
                  : t('characters.animPunctOff'),
              })
            : t('characters.animCustomized', {
                value: punctPause ? t('characters.animPunctOn') : t('characters.animPunctOff'),
              })
        }
        control={
          // 2026-09-14 换自绘复刻件 SegmentedControl（分段选择器，指示条
          // 滑动动画）：三段 '' / 'on' / 'off' 映射 null / true / false
          <SegmentedControl
            className={styles.paramSegment}
            ariaLabel={t('characters.animPunctPause')}
            value={punctPause === null ? '' : punctPause ? 'on' : 'off'}
            onChange={(v) => onPunctChange(v === '' ? null : v === 'on')}
            options={[
              { value: '', label: followGlobal },
              { value: 'on', label: t('characters.animPunctOn') },
              { value: 'off', label: t('characters.animPunctOff') },
            ]}
          />
        }
      />
    </>
  );
}
