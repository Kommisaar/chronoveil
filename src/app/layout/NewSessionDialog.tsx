/**
 * 新建会话对话框（FR-007 / FR-014 开局向导）：侧栏「+」入口的两段式表单——
 * ① 选角色（点击锁定，可「返回重选」）；② 开局设置：历法五选（跟随角色卡 /
 * 现代公历 / 七曜和历 / 干支历 / 旧都历，选中预设显示静态样例行，不与
 * fiction_time::date_label 双写实时换算）、起始锚「第 N 天 · 时段」（六值下拉，
 * 缺省 夜）、首场景地点 / 时间原文（可选）。
 *
 * 提交语义：「直接开始」= 降级路径，opening 传 null（后端同样无条件 seed 默认锚
 * 开场行，day=1 / part=夜 / 日历走角色卡快照，等价原有单击建会话）；「开局并开始」
 * 携带表单值。四内置预设常量与 Rust `domain/fiction_time::presets` 一一对应——
 * 前端只构造 wire DTO（camelCase），落库存储 JSON 由 Rust 序列化 domain 结构得
 * snake_case，本组件永不手写存储 JSON。预设常量 FR-014 二期起下沉
 * src/components/calendarPresets（角色卡历法编辑共用同一事实源），本组件只消费。
 *
 * 本组件为 app 层内聚（本切片 UI 全在 app 层，不越 feature 边界）；组件全用
 * Fluent v9 既有件，表单惯例对齐 CharacterEditorDialog（Text 标签 + aria-label）。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Input,
  Option,
  Radio,
  RadioGroup,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterSummary, SessionOpeningInput } from '../../api/types';
import { CALENDAR_PRESETS, type CalendarPresetId } from '../../components/calendarPresets';

/** 历法五选项键：follow = 角色卡快照兜底（wire 传 null）。 */
type PresetKey = 'follow' | CalendarPresetId;
type ConcretePreset = CalendarPresetId;

/** 选中预设的静态样例行（预设常量自带说明文本，i18n key）。 */
const SAMPLE_KEYS: Record<ConcretePreset, string> = {
  modern: 'sessions.wizard.sampleModern',
  seven: 'sessions.wizard.sampleSeven',
  ganzhi: 'sessions.wizard.sampleGanzhi',
  fantasy: 'sessions.wizard.sampleFantasy',
};

/** 时段六值（BR-003）：value = 落库值（与 Rust fiction_time::PARTS 一致），
 *  labelKey = 显示文案（英文档位显示「原值 (译名)」，落库仍为原值）。 */
const FIC_PARTS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: '清晨', labelKey: 'sessions.wizard.partDawn' },
  { value: '上午', labelKey: 'sessions.wizard.partMorning' },
  { value: '午后', labelKey: 'sessions.wizard.partAfternoon' },
  { value: '黄昏', labelKey: 'sessions.wizard.partDusk' },
  { value: '夜', labelKey: 'sessions.wizard.partNight' },
  { value: '深夜', labelKey: 'sessions.wizard.partLateNight' },
];

/** 从角色卡日历 JSON 读历法名（FR-014：跟随角色卡项显示用；坏 JSON 静默降级）。 */
function characterCalendarName(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === 'string' && name !== '' ? name : null;
  } catch {
    return null;
  }
}

const useStyles = makeStyles({
  dialogHint: {
    marginTop: tokens.spacingVerticalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  characterList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    marginTop: tokens.spacingVerticalS,
  },
  characterItem: {
    // 原生 button 抹平默认外观（原 Sidebar 条目 buttonReset 语义内联至此）
    width: '100%',
    border: 'none',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minHeight: '40px',
    borderRadius: tokens.borderRadiusMedium,
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':active': { backgroundColor: tokens.colorNeutralBackground1Pressed },
    ':disabled': { opacity: 0.5, cursor: 'default' },
  },
  characterAvatar: {
    width: '28px',
    height: '28px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  characterName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalS,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  anchorRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
  },
  dayInput: { width: '120px' },
  partDropdown: { minWidth: '160px' },
  sample: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'pre-wrap',
  },
});

export interface NewSessionDialogProps {
  open: boolean;
  /** 现役角色清单（侧栏拉取后传入）；null = 加载中。 */
  characters: CharacterSummary[] | null;
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  /** 提交建会话：opening = null 为「直接开始」降级路径（FR-014 §7-6）。 */
  onCreate: (characterId: number, opening: SessionOpeningInput | null) => void;
}

/** 新建会话两段式对话框（FR-014 开局向导）。 */
export function NewSessionDialog(props: NewSessionDialogProps) {
  const { open, characters, creating, onOpenChange, onCreate } = props;
  const styles = useStyles();
  const { t } = useTranslation();

  const [stage, setStage] = useState<'pick' | 'form'>('pick');
  const [selected, setSelected] = useState<CharacterSummary | null>(null);
  // —— 开局表单（切换角色时重置回缺省值）——
  const [preset, setPreset] = useState<PresetKey>('follow');
  const [ficDay, setFicDay] = useState('1');
  const [ficPart, setFicPart] = useState('夜');
  const [location, setLocation] = useState('');
  const [timeNote, setTimeNote] = useState('');

  // 每次打开回到选角色态（表单值随选角重置，不残留上次草稿）
  useEffect(() => {
    if (open) {
      setStage('pick');
      setSelected(null);
    }
  }, [open]);

  const pickCharacter = (character: CharacterSummary): void => {
    setSelected(character);
    setPreset('follow');
    setFicDay('1');
    setFicPart('夜');
    setLocation('');
    setTimeNote('');
    setStage('form');
  };

  const backToPick = (): void => {
    setStage('pick');
    setSelected(null);
  };

  /** 表单值 → wire 开局包。空串/非法数字归 None（= 后端缺省 1 / 夜）。 */
  const buildOpening = (): SessionOpeningInput => {
    const day = Number(ficDay);
    const trim = (value: string): string | null => {
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    };
    return {
      calendar: preset === 'follow' ? null : CALENDAR_PRESETS[preset],
      ficDay: Number.isInteger(day) && day >= 1 ? day : null,
      ficPart,
      location: trim(location),
      timeNote: trim(timeNote),
    };
  };

  const followCalendarName = characterCalendarName(selected?.calendarConfig ?? null);
  const followLabel = followCalendarName
    ? t('sessions.wizard.followWithCalendar', { name: followCalendarName })
    : t('sessions.wizard.followWithoutCalendar');

  /** 时段落库值 → 显示文案（英文档位为「原值 (译名)」；未知值原样显示）。 */
  const partLabel = (value: string): string => {
    const part = FIC_PARTS.find((p) => p.value === value);
    return part === undefined ? value : t(part.labelKey);
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>{t('sessions.new')}</DialogTitle>
          <DialogContent>
            {stage === 'pick' ? (
              <>
                <div className={styles.dialogHint}>{t('sessions.pickCharacter')}</div>
                {characters === null ? null : characters.length === 0 ? (
                  <div className={styles.dialogHint}>{t('sessions.noCharacters')}</div>
                ) : (
                  <div className={styles.characterList}>
                    {characters.map((character) => (
                      <button
                        key={character.id}
                        type="button"
                        className={styles.characterItem}
                        disabled={creating}
                        onClick={() => pickCharacter(character)}
                      >
                        <span className={styles.characterAvatar} aria-hidden="true">
                          {character.name.slice(0, 1)}
                        </span>
                        <span className={styles.characterName}>{character.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.form}>
                <div className={styles.field}>
                  <Text size={300} weight="semibold">
                    {t('sessions.wizard.formTitle')}：{t('sessions.wizard.calendar')}
                  </Text>
                  <RadioGroup
                    value={preset}
                    onChange={(_, data) => setPreset(data.value as PresetKey)}
                    aria-label={t('sessions.wizard.calendar')}
                  >
                    <Radio value="follow" label={t('sessions.wizard.presetFollow')} />
                    <Radio value="modern" label={t('sessions.wizard.presetModern')} />
                    <Radio value="seven" label={t('sessions.wizard.presetSeven')} />
                    <Radio value="ganzhi" label={t('sessions.wizard.presetGanzhi')} />
                    <Radio value="fantasy" label={t('sessions.wizard.presetFantasy')} />
                  </RadioGroup>
                  <Text size={200} className={styles.sample}>
                    {preset === 'follow'
                      ? followLabel
                      : t(SAMPLE_KEYS[preset as ConcretePreset])}
                  </Text>
                </div>
                <div className={styles.anchorRow}>
                  <div className={styles.field}>
                    <Text size={300} weight="semibold">
                      {t('sessions.wizard.ficDay')}
                    </Text>
                    <Input
                      type="number"
                      min={1}
                      className={styles.dayInput}
                      value={ficDay}
                      onChange={(_, data) => setFicDay(data.value)}
                      aria-label={t('sessions.wizard.ficDayField')}
                    />
                  </div>
                  <div className={styles.field}>
                    <Text size={300} weight="semibold">
                      {t('sessions.wizard.ficPart')}
                    </Text>
                    <Dropdown
                      className={styles.partDropdown}
                      value={partLabel(ficPart)}
                      selectedOptions={[ficPart]}
                      onOptionSelect={(_, data) => setFicPart(data.optionValue ?? '夜')}
                      aria-label={t('sessions.wizard.ficPart')}
                    >
                      {FIC_PARTS.map((part) => (
                        <Option key={part.value} value={part.value} text={t(part.labelKey)}>
                          {t(part.labelKey)}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>
                </div>
                <div className={styles.field}>
                  <Text size={300} weight="semibold">
                    {t('sessions.wizard.firstLocation')}
                    <Text size={200} className={styles.sample}>
                      {' '}
                      {t('sessions.wizard.optional')}
                    </Text>
                  </Text>
                  <Input
                    value={location}
                    onChange={(_, data) => setLocation(data.value)}
                    aria-label={`${t('sessions.wizard.firstLocation')}（${t('sessions.wizard.optional')}）`}
                  />
                </div>
                <div className={styles.field}>
                  <Text size={300} weight="semibold">
                    {t('sessions.wizard.firstTimeNote')}
                    <Text size={200} className={styles.sample}>
                      {' '}
                      {t('sessions.wizard.optional')}
                    </Text>
                  </Text>
                  <Input
                    value={timeNote}
                    onChange={(_, data) => setTimeNote(data.value)}
                    aria-label={`${t('sessions.wizard.firstTimeNote')}（${t('sessions.wizard.optional')}）`}
                  />
                </div>
              </div>
            )}
          </DialogContent>
          {stage === 'form' && selected !== null && (
            <DialogActions>
              <Button disabled={creating} onClick={backToPick}>
                {t('sessions.wizard.back')}
              </Button>
              <Button
                disabled={creating}
                onClick={() => onCreate(selected.id, null)}
              >
                {t('sessions.wizard.startDirectly')}
              </Button>
              <Button
                appearance="primary"
                disabled={creating}
                onClick={() => onCreate(selected.id, buildOpening())}
              >
                {t('sessions.wizard.startWithOpening')}
              </Button>
            </DialogActions>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
