/**
 * 叙事账本面板（FR-012 状态面板 + 场景史 UI 的合并形态）。
 *
 * 形态：右侧内嵌面板（聊天列的 flex 兄弟，非模态 Dialog）——账本是「边聊边查」
 * 的参照物，模态会挡住聊天流；内嵌列不抢焦点、随外层开关即时开合（ADR：
 * ChatView 侧注释）。
 *
 * 内容两段，顺序固定：
 * - 人物状态：按 scope 分「当前状态」「关系」两组，`key：value` 行；组空省标题，
 *   全空显示空态文案。expiry 不展示（那是结算清算线索，非叙事信息）。
 * - 场景史：idx 倒序（最新在上）。每行 = 场号 + 时间标签 + 地点 + 一行 summary；
 *   时间标签只出一枚（后端编年史并列链 location·timeNote·dateLabel·summary，
 *   前端收成一段保持克制）：timeNote（叙事时间原文，如「第三日黄昏，雨」）最
 *   有味道，优先；缺失回落 dateLabel，再缺拼 ficDay/ficPart（与后端 date_label
 *   数字回退形态同构）。场号行下附「在场：…」次要小字行（present 角色名，已删
 *   角色回退「角色#id」）。元数据全空的场也保留行（场号可辨）。recap 非空的场
 *   （桥场）出「展开回顾」折叠块，默认收起。
 *
 * 数据策略：挂载（打开面板）与 sessionId 变化（会话切换）时重拉场景 / 状态两个
 * 会话级列表 + 角色清单（present id → 名字映射用，v1 单角色会话通常就一个）；生成
 * 终态（streamHub.onTerminal，ADR-005 保证 done 放行前 scenes / character_state
 * 已在库）且属于本会话时静默重拉，无需手动刷新按钮。
 */
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { listCharacterStates, listCharacters, listScenes } from '../../api/commands';
import type { CharacterStateDto, SceneDto } from '../../api/types';
import { streamHub } from './streamHub';

const useStyles = makeStyles({
  panel: {
    width: '320px',
    flexShrink: 0,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    flexShrink: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  // 状态分组小标（组空省略整组含标题）
  groupTitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  stateRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.6',
    wordBreak: 'break-word',
  },
  stateMarker: {
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  stateText: {
    minWidth: 0,
  },
  // 加载 / 错误态：纵向居中的一块
  stateBlock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  // 场景行：头行（场号 + 元信息）+ 一行摘要 + 可选回顾折叠
  sceneRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sceneHead: {
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  sceneNo: {
    flexShrink: 0,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  sceneMeta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  sceneSummary: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.6',
    wordBreak: 'break-word',
  },
  recap: {
    fontSize: tokens.fontSizeBase200,
  },
  recapBody: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
});

/** 时间标签（只出一枚，不堆叠）：timeNote（叙事时间原文）优先；缺失回落
 * dateLabel；再缺拼 ficDay/ficPart（后端 date_label 数字回退同构）；全缺省略。 */
function timeLabelOf(scene: SceneDto, t: TFunction): string | null {
  if (scene.timeNote !== null && scene.timeNote !== '') return scene.timeNote;
  if (scene.dateLabel !== null && scene.dateLabel !== '') return scene.dateLabel;
  const { ficDay: day, ficPart: part } = scene;
  if (day !== null && part !== null) return t('chat.ledger.dayPart', { day, part });
  if (day !== null) return t('chat.ledger.day', { day });
  return part;
}

/** 状态分组（组空由调用方省略整组含标题）：`key：value` 行，expiry 不展示。 */
function StateGroup({ title, rows }: { title: string; rows: CharacterStateDto[] }) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.group}>
      <Text className={styles.groupTitle}>{title}</Text>
      {rows.map((s) => (
        <div key={s.id} className={styles.stateRow}>
          <span className={styles.stateMarker} aria-hidden="true">
            ·
          </span>
          <span className={styles.stateText}>
            {t('chat.ledger.stateRow', { key: s.key, value: s.value })}
          </span>
        </div>
      ))}
    </div>
  );
}

interface LedgerPanelProps {
  /** 当前会话（面板只展示现役会话；切换会话由父级换 prop 触发重拉）。 */
  sessionId: number;
}

export function LedgerPanel({ sessionId }: LedgerPanelProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [scenes, setScenes] = useState<SceneDto[] | null>(null);
  const [states, setStates] = useState<CharacterStateDto[] | null>(null);
  // present 角色名映射（id → 名字）：随角色清单一次拉全量，已删角色查不到走回退文案
  const [characterNames, setCharacterNames] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 终态静默重拉 / 手动重试共用的时间点：bump 触发下方拉取 effect 重跑
  const [refreshTick, setRefreshTick] = useState(0);

  // 拉取：打开（挂载）、会话切换（sessionId 变化）、终态 / 重试（refreshTick）。
  // 场景 / 状态按会话查询，角色清单全量（present 映射用，v1 单角色会话通常就一个）；
  // 三者同库同源，失败一并走错误态重试。
  // cancelled 标记防会话快切竞态：过期响应不落 state。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void Promise.all([listScenes(sessionId), listCharacterStates(sessionId), listCharacters()])
      .then(([nextScenes, nextStates, nextCharacters]) => {
        if (cancelled) return;
        setScenes(nextScenes);
        setStates(nextStates);
        setCharacterNames(new Map(nextCharacters.map((c) => [c.id, c.name])));
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshTick]);

  // 新完成消息 → 静默重拉（FR-012）：终态事件（done / error 均已落库，ADR-001）
  // 在 done 放行前 scenes / character_state 已结算在库（ADR-005），直接重拉无竞态；
  // 只认本会话的终态（后台会话的账本不归本面板管）。面板关闭即随卸载摘订阅。
  useEffect(
    () =>
      streamHub.onTerminal((terminalSessionId) => {
        if (terminalSessionId === sessionId) setRefreshTick((tick) => tick + 1);
      }),
    [sessionId],
  );

  const stateList = states ?? [];
  const relationRows = stateList.filter((s) => s.scope === 'relation');
  const stateRows = stateList.filter((s) => s.scope !== 'relation');
  // 倒序（最新在上）：idx 是同会话单调叙事顺序（domain Scene.idx 约定）
  const sceneRows = [...(scenes ?? [])].sort((a, b) => b.idx - a.idx);

  return (
    <aside id="ledger-panel" className={styles.panel} aria-label={t('chat.ledger.title')}>
      <div className={styles.header}>
        <Text className={styles.title}>{t('chat.ledger.title')}</Text>
      </div>
      {loading ? (
        <div className={styles.stateBlock}>
          <Spinner size="tiny" />
          <Text>{t('chat.ledger.loading')}</Text>
        </div>
      ) : failed ? (
        <div className={styles.stateBlock}>
          <Text>{t('chat.ledger.loadFailed')}</Text>
          <Button size="small" onClick={() => setRefreshTick((tick) => tick + 1)}>
            {t('chat.ledger.retry')}
          </Button>
        </div>
      ) : (
        <>
          <section className={styles.section} aria-label={t('chat.ledger.states')}>
            <Text className={styles.sectionTitle}>{t('chat.ledger.states')}</Text>
            {stateList.length === 0 ? (
              <Text className={styles.groupTitle}>{t('chat.ledger.statesEmpty')}</Text>
            ) : (
              <>
                {stateRows.length > 0 && (
                  <StateGroup title={t('chat.ledger.groupState')} rows={stateRows} />
                )}
                {relationRows.length > 0 && (
                  <StateGroup title={t('chat.ledger.groupRelation')} rows={relationRows} />
                )}
              </>
            )}
          </section>
          <section className={styles.section} aria-label={t('chat.ledger.scenes')}>
            <Text className={styles.sectionTitle}>{t('chat.ledger.scenes')}</Text>
            {sceneRows.length === 0 ? (
              <Text className={styles.groupTitle}>{t('chat.ledger.scenesEmpty')}</Text>
            ) : (
              sceneRows.map((scene) => {
                const timeLabel = timeLabelOf(scene, t);
                return (
                  <div key={scene.id} className={styles.sceneRow}>
                    <div className={styles.sceneHead}>
                      <Text className={styles.sceneNo}>
                        {t('chat.ledger.sceneNo', { index: scene.idx })}
                      </Text>
                      {timeLabel !== null && (
                        <span className={styles.sceneMeta}>{timeLabel}</span>
                      )}
                      {scene.location !== null && scene.location !== '' && (
                        <span className={styles.sceneMeta}>{scene.location}</span>
                      )}
                    </div>
                    {scene.present.length > 0 && (
                      // 在场角色：次要小字行（从众 sceneMeta 层级，不抢 summary）；
                      // 已删角色回退「角色#id」；名字拼接从众 CalendarSection 的「、」
                      <div className={styles.sceneMeta}>
                        {t('chat.ledger.present', {
                          names: scene.present
                            .map(
                              (id) =>
                                characterNames.get(id) ??
                                t('chat.ledger.unknownCharacter', { id }),
                            )
                            .join('、'),
                        })}
                      </div>
                    )}
                    {scene.summary !== null && scene.summary !== '' && (
                      <div className={styles.sceneSummary}>{scene.summary}</div>
                    )}
                    {scene.recap !== null && scene.recap !== '' && (
                      // 桥场加厚回顾（Task-03）：默认收起，随场行折叠
                      <Accordion className={styles.recap} collapsible>
                        <AccordionItem value="recap">
                          <AccordionHeader size="small">
                            {t('chat.ledger.expandRecap')}
                          </AccordionHeader>
                          <AccordionPanel>
                            <div className={styles.recapBody}>{scene.recap}</div>
                          </AccordionPanel>
                        </AccordionItem>
                      </Accordion>
                    )}
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </aside>
  );
}
