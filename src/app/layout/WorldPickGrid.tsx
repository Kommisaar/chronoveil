/**
 * 新建会话向导第一步的选世界区（0017 会话必有世界，自 NewSessionDialog 抽出
 * ——选人网格 CharacterPickGrid 的同款拆法）：三列平面信息卡（名称 + 历法
 * 摘要行）单选网格 + 内联建卡行（填名回车或点钮即建：worldbook 空、默认
 * 数字历，后续在世界页编辑；空库时这是唯一出路，也服务顺手快建）。
 *
 * 内联建卡的草稿名 / 在途标记 / 失败文案是本区局部态；建成经 onCreateWorld
 * 出口由父级落库并更新清单，返回值（新世界）就地置为选中。世界卡无海报
 * 视觉，左缘品牌色竖条与世界页卡片同一识别语汇；选中态换品牌色描边（与
 * 选人卡同语言）。
 */
import { Button, Input, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldSummary } from '../../api/types';

const useStyles = makeStyles({
  hint: {
    marginTop: tokens.spacingVerticalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // 世界卡网格：三列平面信息卡，限高滚动对齐选人网格（卡库可多于首屏）
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalS,
    maxHeight: '240px',
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXXS,
  },
  worldCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '2px',
    padding: '10px 12px',
    borderLeft: `4px solid ${tokens.colorBrandBackground}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    // 原生 button 字色是 UA 默认（黑）不随主题继承，显式走 token（同
    // WorldsView 卡片的注释）
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  worldCardSelected: {
    borderRightColor: tokens.colorBrandStroke1,
    borderTopColor: tokens.colorBrandStroke1,
    borderBottomColor: tokens.colorBrandStroke1,
  },
  worldCalendar: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 内联建卡行：输入框 + 「新建世界」钮
  inlineNewRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  inlineNewInput: {
    flexGrow: 1,
  },
});

export interface WorldPickGridProps {
  /** 现役世界清单；null = 加载中（出一行提示，不出网格）。 */
  worlds: WorldSummary[] | null;
  /** 当前选中世界 id；null = 未选。 */
  worldId: number | null;
  /** 改选回调（再点已选卡取消选中）。 */
  onWorldChange: (id: number | null) => void;
  /** 提交进行中禁点（与对话框动作钮同源）。 */
  creating: boolean;
  /** 内联建世界出口：父级落库并更新清单，返回新世界（本组件选中它）。 */
  onCreateWorld: (name: string) => Promise<WorldSummary>;
}

/** 选世界区（网格单选 + 内联建卡）。 */
export function WorldPickGrid(props: WorldPickGridProps) {
  const { worlds, worldId, onWorldChange, creating, onCreateWorld } = props;
  const styles = useStyles();
  const { t } = useTranslation();
  // 内联建世界：草稿名 + 在途标记 + 失败文案（成功路径由父级更新清单）
  const [newWorldName, setNewWorldName] = useState('');
  const [creatingWorld, setCreatingWorld] = useState(false);
  const [createWorldError, setCreateWorldError] = useState<string | null>(null);

  /** 内联建世界：成功后选中新建卡（父级清单更新经 worlds prop 回流）。 */
  const submitNewWorld = async (): Promise<void> => {
    const name = newWorldName.trim();
    if (creatingWorld || creating || name === '') return;
    setCreatingWorld(true);
    setCreateWorldError(null);
    try {
      const created = await onCreateWorld(name);
      onWorldChange(created.id);
      setNewWorldName('');
    } catch (e) {
      setCreateWorldError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingWorld(false);
    }
  };

  return (
    <>
      {worlds === null ? (
        <div className={styles.hint}>{t('sessions.wizard.loadingWorlds')}</div>
      ) : worlds.length === 0 ? (
        <div className={styles.hint}>{t('sessions.wizard.noWorlds')}</div>
      ) : (
        <div className={styles.cardGrid}>
          {worlds.map((world) => {
            const selected = world.id === worldId;
            return (
              <button
                key={world.id}
                type="button"
                className={mergeClasses(styles.worldCard, selected && styles.worldCardSelected)}
                aria-pressed={selected}
                disabled={creating}
                onClick={() => onWorldChange(selected ? null : world.id)}
              >
                <Text size={300} weight="semibold">
                  {world.name}
                </Text>
                <span className={styles.worldCalendar}>
                  {world.calendar === null ? t('worlds.calendarNone') : world.calendar.name}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {/* 内联建卡：填名回车或点钮即建（空列表时的出路，也服务顺手快建） */}
      <div className={styles.inlineNewRow}>
        <Input
          className={styles.inlineNewInput}
          value={newWorldName}
          onChange={(_, data) => setNewWorldName(data.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitNewWorld();
          }}
          aria-label={t('sessions.wizard.newWorldInline')}
          placeholder={t('sessions.wizard.newWorldNamePlaceholder')}
          disabled={creatingWorld}
        />
        <Button
          disabled={creatingWorld || newWorldName.trim() === ''}
          onClick={() => void submitNewWorld()}
        >
          {t('sessions.wizard.newWorldInline')}
        </Button>
      </div>
      {createWorldError !== null ? (
        <Text role="alert" size={200}>
          {createWorldError}
        </Text>
      ) : null}
    </>
  );
}
