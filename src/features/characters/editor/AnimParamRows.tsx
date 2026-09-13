/**
 * 演出参数行组（2026-09-13 用户定稿）：输出动画卡的行 3–5——动效时长 /
 * 打字节奏 / 标点微停。null = 跟随全局（迁移 0013 列语义）：行描述展示全局
 * 当前值（`animFollowingGlobal` 插值），自定义后出「跟随全局」还原钮（点击
 * 清回 null）。范围与 Rust 命令层校验（character_inputs 的 ANIM_*_MIN/MAX）、
 * TS 引擎常量（DUR_MIN_MS 等）三方同源互指；滑杆本身取值在域内，正常路径
 * 不触越界。数值行刻意用滑杆而非数字输入框：受控输入框在修改即保存语义下
 * 会被逐键钳制值打断打字（输入「4」立即变「150」），滑杆无此问题。
 */
import {
  Button,
  Dropdown,
  Option,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { SettingsDivider, SettingsRow } from '../../../components/SettingsCard';
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
  // 滑杆当前值：定宽右对齐，拖动时不跳
  rhythmValue: {
    minWidth: '56px',
    textAlign: 'right',
    color: tokens.colorNeutralForeground2,
  },
  paramSelect: {
    minWidth: '120px',
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
            : undefined
        }
        control={
          <div className={styles.rhythmControl}>
            <TooltipSlider
              className={styles.sliderW160}
              min={DUR_MIN_MS}
              max={DUR_MAX_MS}
              step={10}
              value={durationMs ?? defaults.durationMs}
              onChange={onDurationChange}
              ariaLabel={t('characters.animDuration')}
            />
            <Text className={styles.rhythmValue}>
              {(durationMs ?? defaults.durationMs) + t('characters.animDurationUnit')}
            </Text>
            {durationMs !== null ? (
              <Button
                appearance="subtle"
                size="small"
                onClick={() => onDurationChange(null)}
              >
                {followGlobal}
              </Button>
            ) : null}
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
            : undefined
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
            />
            <Text className={styles.rhythmValue}>
              {(rhythmMs ?? defaults.msPerChar) + t('characters.animRhythmUnit')}
            </Text>
            {rhythmMs !== null ? (
              <Button
                appearance="subtle"
                size="small"
                onClick={() => onRhythmChange(null)}
              >
                {followGlobal}
              </Button>
            ) : null}
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
            : undefined
        }
        control={
          <Dropdown
            className={styles.paramSelect}
            value={
              punctPause === null
                ? followGlobal
                : punctPause
                  ? t('characters.animPunctOn')
                  : t('characters.animPunctOff')
            }
            selectedOptions={[punctPause === null ? '' : punctPause ? 'on' : 'off']}
            onOptionSelect={(_, d) => {
              const v = d.optionValue ?? '';
              onPunctChange(v === '' ? null : v === 'on');
            }}
            aria-label={t('characters.animPunctPause')}
          >
            <Option value="" text={followGlobal}>
              {followGlobal}
            </Option>
            <Option value="on" text={t('characters.animPunctOn')}>
              {t('characters.animPunctOn')}
            </Option>
            <Option value="off" text={t('characters.animPunctOff')}>
              {t('characters.animPunctOff')}
            </Option>
          </Dropdown>
        }
      />
    </>
  );
}
