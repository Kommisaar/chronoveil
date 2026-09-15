/**
 * 新建会话对话框（FR-007 / FR-014 开局向导，0017 起四段式）：
 * ① 「世界」：从世界卡库单选 1 张（会话必有世界，历法与世界观随卡 D1 快照
 *    带入；不选不能下一步），支持内联建卡——填名即建（worldbook 空、默认
 *    数字历，后续在世界页编辑）；② 「你的角色」：单选 1 张 = 用户扮演位
 *    （D2 必选）；③ 「LLM 阵容」：多选 ≥1 张卡（D5 无上限；D2 允许与扮演位
 *    同卡，扮演位卡上出「你的扮演位」记号）；④ 开局设置：起始锚「第 N 天 ·
 *    时段」（六值下拉，缺省 夜）、首场景地点 / 时间原文（可选）——历法段已
 *    随 0017 裁撤（历法归属世界卡）。
 *
 * 选人卡复用角色页海报卡视觉（CharacterPickGrid，两步共用）；选世界区抽在
 * WorldPickGrid（含内联建卡）。提交语义：「直接开始」=
 * 降级路径，opening 传 null（后端同样无条件 seed 默认锚开场行，day=1 /
 * part=夜 / 日历走世界快照）；「开局并开始」携带表单值。阵容提交为
 * members（用户位在前 + LLM 位按点选序），后端逐卡实例化快照（D1）；
 * worldId 随提交上送，后端事务内实例化世界快照。
 *
 * 本组件为 app 层内聚；组件全用 Fluent v9 既有件，表单惯例对齐
 * CharacterEditorDialog（Text 标签 + aria-label）。
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
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CharacterSummary,
  SessionOpeningInput,
  SessionRosterMember,
  WorldSummary,
} from '../../api/types';
import { CharacterPickGrid } from './CharacterPickGrid';
import { WorldPickGrid } from './WorldPickGrid';

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
});

export interface NewSessionDialogProps {
  open: boolean;
  /** 现役角色清单（侧栏拉取后传入）；null = 加载中。 */
  characters: CharacterSummary[] | null;
  /** 现役世界清单（侧栏拉取后传入）；null = 加载中。 */
  worlds: WorldSummary[] | null;
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  /** 内联建世界出口：父级落库并更新 worlds 清单，返回新世界（本组件选中它）。 */
  onCreateWorld: (name: string) => Promise<WorldSummary>;
  /** 提交建会话：worldId = 选中世界（第一步必选）；members = 阵容（用户位在
   *  前，D2 恰好一扮演位）；opening = null 为「直接开始」降级路径。 */
  onCreate: (
    worldId: number,
    members: SessionRosterMember[],
    opening: SessionOpeningInput | null,
  ) => void;
}

/** 新建会话四段式对话框（FR-014 开局向导：选世界 → 两步选人 → 开局表单）。 */
export function NewSessionDialog(props: NewSessionDialogProps) {
  const { open, characters, worlds, creating, onOpenChange, onCreateWorld, onCreate } = props;
  const styles = useStyles();
  const { t } = useTranslation();

  const [stage, setStage] = useState<'pickWorld' | 'pickUser' | 'pickRoster' | 'form'>('pickWorld');
  const [worldId, setWorldId] = useState<number | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  // LLM 阵容：点选序（Set 保序去重），可含扮演位同卡（D2）
  const [roster, setRoster] = useState<number[]>([]);
  // —— 开局表单（进入表单步时重置回缺省值，不残留上次草稿）——
  const [ficDay, setFicDay] = useState('1');
  const [ficPart, setFicPart] = useState('夜');
  const [location, setLocation] = useState('');
  const [timeNote, setTimeNote] = useState('');

  // 每次打开回到第一步选世界态（全部选择与表单草稿重置，不残留上次）
  useEffect(() => {
    if (open) {
      setStage('pickWorld');
      setWorldId(null);
      setUserId(null);
      setRoster([]);
    }
  }, [open]);

  const advanceToUser = (): void => {
    if (worldId !== null) setStage('pickUser');
  };

  const advanceToRoster = (): void => {
    if (userId !== null) setStage('pickRoster');
  };

  /** 进入表单步：重置开局草稿（返回再进不残留）。 */
  const advanceToForm = (): void => {
    if (roster.length === 0) return;
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
            {stage === 'pickWorld' ? (
              <>
                <Text className={styles.stepTitle}>{t('sessions.wizard.stepWorld')}</Text>
                <div className={styles.dialogHint}>{t('sessions.wizard.pickWorldHint')}</div>
                <WorldPickGrid
                  worlds={worlds}
                  worldId={worldId}
                  onWorldChange={setWorldId}
                  creating={creating}
                  onCreateWorld={onCreateWorld}
                />
              </>
            ) : stage === 'pickUser' ? (
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
                <Text size={300} weight="semibold">
                  {t('sessions.wizard.formTitle')}
                </Text>
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
                    <Text size={200} className={styles.dialogHint}>
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
                    <Text size={200} className={styles.dialogHint}>
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
            {stage === 'pickWorld' && (
              <Button
                appearance="primary"
                disabled={creating || worldId === null}
                onClick={advanceToUser}
              >
                {t('sessions.wizard.next')}
              </Button>
            )}
            {stage === 'pickUser' && (
              <>
                <Button disabled={creating} onClick={() => setStage('pickWorld')}>
                  {t('sessions.wizard.back')}
                </Button>
                <Button
                  appearance="primary"
                  disabled={creating || userId === null}
                  onClick={advanceToRoster}
                >
                  {t('sessions.wizard.next')}
                </Button>
              </>
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
                <Button
                  disabled={creating || worldId === null}
                  onClick={() => {
                    if (worldId !== null) onCreate(worldId, buildMembers(), null);
                  }}
                >
                  {t('sessions.wizard.startDirectly')}
                </Button>
                <Button
                  appearance="primary"
                  disabled={creating || worldId === null}
                  onClick={() => {
                    if (worldId !== null) onCreate(worldId, buildMembers(), buildOpening());
                  }}
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
