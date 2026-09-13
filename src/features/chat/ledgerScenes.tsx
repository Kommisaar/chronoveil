/**
 * 叙事账本第二段：场景史。
 *
 * idx 倒序（最新在上）。每行 = 场号 + 时间标签 + 地点 + 一行 summary；时间
 * 标签只出一枚（后端编年史并列链 location·timeNote·dateLabel·summary，前端
 * 收成一段保持克制）：timeNote（叙事时间原文，如「第三日黄昏，雨」）最有味
 * 道，优先；缺失回落 dateLabel，再缺拼 ficDay/ficPart（与后端 date_label 数
 * 字回退形态同构）。场号行下附「在场：…」次要小字行（present 角色名，已删
 * 角色回退「角色#id」）。元数据全空的场也保留行（场号可辨）。recap 非空的
 * 场（桥场）出「展开回顾」折叠块，默认收起。
 *
 * 数据由面板壳拉取后经 props 下发（在场实例名映射同样由壳从 ui store 派生），
 * 本组件只管渲染；每行附「从此分叉」入口（时间线分叉，Task-44），点击经
 * onFork 上抛，对话框与执行在面板壳。
 */
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { BranchFork16Regular } from '@fluentui/react-icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { SceneDto } from '../../api/types';
import { useLedgerSectionStyles } from './useLedgerSectionStyles';

const useStyles = makeStyles({
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
  // 分叉入口钮：头行右缘（对齐该文件克制的小件交互），图标钮带完整 aria 标注
  forkBtn: {
    marginLeft: 'auto',
    flexShrink: 0,
    alignSelf: 'center',
    minWidth: '24px',
    height: '24px',
    padding: '0px',
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

export interface LedgerScenesSectionProps {
  /** 会话级场景列表（面板壳拉取；null = 拉取未落定，渲染为空列表）。 */
  scenes: SceneDto[] | null;
  /** 在场实例 id → 名（多角色第 1 步），由面板壳从 ui store 会话清单的
   * roster 回显派生；清单未覆盖到的 id 在此回退「角色#id」兜底。 */
  instanceNames: Map<number, string>;
  /** 「从此分叉」回调（时间线分叉，Task-44）：携带锚点场上抛，对话框与
   * 分叉执行在面板壳（本组件只管渲染）。 */
  onFork: (scene: SceneDto) => void;
}

export function LedgerScenesSection({ scenes, instanceNames, onFork }: LedgerScenesSectionProps) {
  const styles = useStyles();
  const chrome = useLedgerSectionStyles();
  const { t } = useTranslation();
  // 倒序（最新在上）：idx 是同会话单调叙事顺序（domain Scene.idx 约定）
  const sceneRows = [...(scenes ?? [])].sort((a, b) => b.idx - a.idx);
  return (
    <section className={chrome.section} aria-label={t('chat.ledger.scenes')}>
      <Text className={chrome.sectionTitle}>{t('chat.ledger.scenes')}</Text>
      {sceneRows.length === 0 ? (
        // 段内空态保持一行小字（同 ledgerStates 的形制决策，审计 A1）
        <Text className={chrome.groupTitle}>{t('chat.ledger.scenesEmpty')}</Text>
      ) : (
        sceneRows.map((scene) => {
          const timeLabel = timeLabelOf(scene, t);
          return (
              <div key={scene.id} className={styles.sceneRow}>
                <div className={styles.sceneHead}>
                  <Text className={styles.sceneNo}>
                    {t('chat.ledger.sceneNo', { index: scene.idx })}
                  </Text>
                  {timeLabel !== null && <span className={styles.sceneMeta}>{timeLabel}</span>}
                  {scene.location !== null && scene.location !== '' && (
                    <span className={styles.sceneMeta}>{scene.location}</span>
                  )}
                  {/* 分叉锚点候选（Task-44）：以本场为锚分叉新会话，执行在面板壳。
                      悬停提示走 Fluent Tooltip（C3）；可访问名保留带场号的富
                      aria-label（比气泡内容更具体），气泡文字已含于名内——
                      relationship="inaccessible" 不再叠 aria 语义 */}
                  <Tooltip content={t('chat.ledger.forkHere')} relationship="inaccessible">
                    <Button
                      className={styles.forkBtn}
                      size="small"
                      appearance="transparent"
                      icon={<BranchFork16Regular />}
                      aria-label={`${t('chat.ledger.forkHere')}：${t('chat.ledger.sceneNo', { index: scene.idx })}`}
                      onClick={() => onFork(scene)}
                    />
                  </Tooltip>
                </div>
              {scene.present.length > 0 && (
                // 在场实例：次要小字行（从众 sceneMeta 层级，不抢 summary）；
                // 未知实例 id 回退「角色#id」；名字拼接从众 CalendarSection 的「、」
                <div className={styles.sceneMeta}>
                  {t('chat.ledger.present', {
                    names: scene.present
                      .map(
                        (id) =>
                          instanceNames.get(id) ?? t('chat.ledger.unknownCharacter', { id }),
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
                    <AccordionHeader size="small">{t('chat.ledger.expandRecap')}</AccordionHeader>
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
  );
}
