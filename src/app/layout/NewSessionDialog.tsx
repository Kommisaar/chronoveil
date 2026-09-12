/**
 * 新建会话对话框（FR-007 / FR-014 开局向导，多角色第 1 步两步选人改造）：
 * 三段式——① 「你的角色」：从角色卡库单选 1 张 = 用户扮演位（D2 必选，不选
 * 不能下一步）；② 「LLM 阵容」：多选 ≥1 张卡作为 LLM 扮演位（D5 阵容无上限；
 * D2 允许与扮演位同卡——自己跟自己对话，UI 不禁止，扮演位卡上出「你的扮演位」
 * 记号）；③ 开局设置：历法五选（跟随角色卡 / 现代公历 / 七曜和历 / 干支历 /
 * 旧都历，选中预设显示静态样例行，不与 fiction_time::date_label 双写实时换算）、
 * 起始锚「第 N 天 · 时段」（六值下拉，缺省 夜）、首场景地点 / 时间原文（可选）。
 *
 * 选人卡复用角色页海报卡视觉（与 CharactersView 同一事实源），适配为对话框
 * 内的可选中迷你卡（aria-pressed 表达选中态），网格视觉件抽在
 * CharacterPickGrid（两步共用）。提交语义：「直接开始」= 降级路径，opening
 * 传 null（后端同样
 * 无条件 seed 默认锚开场行，day=1 / part=夜 / 日历走会话快照）；「开局并开始」
 * 携带表单值。阵容提交为 members（用户位在前 + LLM 位按点选序），后端逐卡
 * 实例化快照（D1）。四内置预设常量与 Rust `domain/fiction_time::presets` 一一
 * 对应——前端只构造 wire DTO（camelCase），落库存储 JSON 由 Rust 序列化 domain
 * 结构得 snake_case，本组件永不手写存储 JSON。预设常量 FR-014 二期起下沉
 * src/components/calendarPresets（角色卡历法编辑共用同一事实源），本组件只消费。
 *
 * 本组件为 app 层内聚（本切片 UI 全在 app 层）；组件全用 Fluent v9 既有件，
 * 表单惯例对齐 CharacterEditorDialog（Text 标签 + aria-label）。
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
import type { CharacterSummary, SessionOpeningInput, SessionRosterMember } from '../../api/types';
import { CALENDAR_PRESETS, type CalendarPresetId } from '../../components/calendarPresets';
import { CharacterPickGrid } from './CharacterPickGrid';

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
  stepTitle: {
    display: 'block',
    marginTop: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
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
  /** 提交建会话：members = 阵容（用户位在前，D2 恰好一扮演位）；
   *  opening = null 为「直接开始」降级路径（FR-014 §7-6）。 */
  onCreate: (members: SessionRosterMember[], opening: SessionOpeningInput | null) => void;
}

/** 新建会话三段式对话框（FR-014 开局向导 + 两步选人）。 */
export function NewSessionDialog(props: NewSessionDialogProps) {
  const { open, characters, creating, onOpenChange, onCreate } = props;
  const styles = useStyles();
  const { t } = useTranslation();

  const [stage, setStage] = useState<'pickUser' | 'pickRoster' | 'form'>('pickUser');
  const [userId, setUserId] = useState<number | null>(null);
  // LLM 阵容：点选序（Set 保序去重），可含扮演位同卡（D2）
  const [roster, setRoster] = useState<number[]>([]);
  // —— 开局表单（进入表单步时重置回缺省值，不残留上次草稿）——
  const [preset, setPreset] = useState<PresetKey>('follow');
  const [ficDay, setFicDay] = useState('1');
  const [ficPart, setFicPart] = useState('夜');
  const [location, setLocation] = useState('');
  const [timeNote, setTimeNote] = useState('');

  // 每次打开回到第一步选人态（全部选择与表单草稿重置，不残留上次）
  useEffect(() => {
    if (open) {
      setStage('pickUser');
      setUserId(null);
      setRoster([]);
    }
  }, [open]);

  const userCharacter = characters?.find((c) => c.id === userId) ?? null;

  const advanceToRoster = (): void => {
    if (userId !== null) setStage('pickRoster');
  };

  /** 进入表单步：重置开局草稿（从众原「选角即重置」语义，返回再进不残留）。 */
  const advanceToForm = (): void => {
    if (roster.length === 0) return;
    setPreset('follow');
    setFicDay('1');
    setFicPart('夜');
    setLocation('');
    setTimeNote('');
    setStage('form');
  };

  const toggleRoster = (characterId: number): void => {
    setRoster((prev) =>
      prev.includes(characterId)
        ? prev.filter((id) => id !== characterId)
        : [...prev, characterId],
    );
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

  /** 阵容 → wire members：用户位在前，LLM 位按点选序（后端按序实例化）。 */
  const buildMembers = (): SessionRosterMember[] => {
    if (userId === null) return [];
    return [
      { characterId: userId, isUser: true },
      ...roster.map((characterId) => ({ characterId, isUser: false })),
    ];
  };

  const followCalendarName = characterCalendarName(userCharacter?.calendarConfig ?? null);
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
            {stage === 'pickUser' ? (
              <>
                <Text className={styles.stepTitle}>{t('sessions.wizard.stepUser')}</Text>
                <div className={styles.dialogHint}>{t('sessions.wizard.pickUserHint')}</div>
                <CharacterPickGrid
                  characters={characters}
                  selectedIds={userId === null ? [] : [userId]}
                  onToggle={(characterId) =>
                    setUserId((current) => (current === characterId ? null : characterId))
                  }
                  userBadgeId={null}
                  disabled={creating}
                />
              </>
            ) : stage === 'pickRoster' ? (
              <>
                <Text className={styles.stepTitle}>{t('sessions.wizard.stepRoster')}</Text>
                <div className={styles.dialogHint}>{t('sessions.wizard.rosterHint')}</div>
                <CharacterPickGrid
                  characters={characters}
                  selectedIds={roster}
                  onToggle={toggleRoster}
                  userBadgeId={userId}
                  disabled={creating}
                />
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
          <DialogActions>
            {stage === 'pickUser' && (
              <Button
                appearance="primary"
                disabled={creating || userId === null}
                onClick={advanceToRoster}
              >
                {t('sessions.wizard.next')}
              </Button>
            )}
            {stage === 'pickRoster' && (
              <>
                <Button disabled={creating} onClick={() => setStage('pickUser')}>
                  {t('sessions.wizard.back')}
                </Button>
                <Button
                  appearance="primary"
                  disabled={creating || roster.length === 0}
                  onClick={advanceToForm}
                >
                  {t('sessions.wizard.next')}
                </Button>
              </>
            )}
            {stage === 'form' && (
              <>
                <Button disabled={creating} onClick={() => setStage('pickRoster')}>
                  {t('sessions.wizard.back')}
                </Button>
                <Button disabled={creating} onClick={() => onCreate(buildMembers(), null)}>
                  {t('sessions.wizard.startDirectly')}
                </Button>
                <Button
                  appearance="primary"
                  disabled={creating}
                  onClick={() => onCreate(buildMembers(), buildOpening())}
                >
                  {t('sessions.wizard.startWithOpening')}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
