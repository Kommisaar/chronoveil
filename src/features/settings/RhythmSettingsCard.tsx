/**
 * 节奏卡（FR-009 设置页）：朗读节奏滑杆、标点停顿开关、动效基准数字输入
 * （「文本态 + 解析」输入，非法时卡内行内提示 + 页面底部汇总合计两处，验收 5）。
 * 从 SettingsView 抽出的纯展示卡（行为零变化）：数值草稿与解析结果由父层持有，
 * 本件只回传原始改动（滑杆数值 / 开关态 / 文本态），不自行落盘。
 */
import { Input, Slider, Switch, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Pause20Regular, Sparkle20Regular, Timer20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { SettingsCard, SettingsDivider, SettingsRow } from './SettingsCard';

const useStyles = makeStyles({
  slider: {
    width: '240px',
  },
  animInput: {
    width: '140px',
  },
  // 动效基准非法时的卡片级行内提示（与底部汇总合计两处，验收 5）
  rowIssue: {
    padding: '0 20px 12px',
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

export interface RhythmSettingsCardProps {
  rhythmMsPerChar: number;
  onRhythmChange: (value: number) => void;
  punctPauseEnabled: boolean;
  onPunctPauseChange: (checked: boolean) => void;
  /** 动效基准的文本态（输入框展示值，允许非法中间态）。 */
  animBaseText: string;
  /** 文本态改动回传（解析与草稿写入由父层处理）。 */
  onAnimBaseTextChange: (text: string) => void;
  /** 动效基准解析是否非法（null）——非法时行内提示。 */
  animBaseInvalid: boolean;
}

/** 节奏卡：节奏滑杆 + 标点停顿 + 动效基准（FR-009）。 */
export function RhythmSettingsCard(props: RhythmSettingsCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <SettingsCard title={t('settings.rhythmCard')}>
      <SettingsRow
        icon={<Timer20Regular />}
        title={t('settings.rhythm', { value: String(props.rhythmMsPerChar) })}
        description={t('settings.rhythmDesc')}
        control={
          <Slider
            className={styles.slider}
            min={10}
            max={160}
            step={5}
            value={props.rhythmMsPerChar}
            aria-label={t('settings.rhythm', { value: String(props.rhythmMsPerChar) })}
            onChange={(_, d) => props.onRhythmChange(d.value)}
          />
        }
      />
      <SettingsDivider />
      <SettingsRow
        icon={<Pause20Regular />}
        title={t('settings.punctPause')}
        description={t('settings.punctPauseDesc')}
        control={
          <Switch
            checked={props.punctPauseEnabled}
            aria-label={t('settings.punctPause')}
            onChange={(_, d) => props.onPunctPauseChange(d.checked)}
          />
        }
      />
      <SettingsDivider />
      <SettingsRow
        icon={<Sparkle20Regular />}
        title={t('settings.animBaseRow')}
        description={t('settings.animBaseDesc')}
        control={
          <Input
            className={styles.animInput}
            type="number"
            min={0}
            step={1}
            value={props.animBaseText}
            aria-label={t('settings.animBase')}
            onChange={(_, d) => props.onAnimBaseTextChange(d.value)}
          />
        }
      />
      {props.animBaseInvalid ? (
        <Text className={styles.rowIssue} role="alert">
          {t('settings.issueAnimBase')}
        </Text>
      ) : null}
    </SettingsCard>
  );
}
