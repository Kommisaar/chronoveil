// 角色管理视图（UC-004 / FR-006）。大卡布局（2026-09-08 用户要求）：
// 左侧人物图片区（characters.avatar，data_model rev 6；null 时姓名首字
// 色块占位），右侧信息堆栈——名称 + 相对更新时间 / 开场白三行截断 /
// 分隔线 + 出场动画 Badge + 会话数。悬停浮起沿用共享卡片动效
// （useCardLiftStyles，注意 mergeClasses 合并）。当前只读展示；CRUD 与
// 「点击开新会话」在阶段 5 实现。
import {
  Badge,
  Button,
  Card,
  Text,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listCharacters } from '../../api/commands';
import type { CharacterSummary } from '../../api/types';
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { usePageContainerStyles } from '../../components/usePageContainerStyles';
import { formatRelative } from '../../lib/relativeTime';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
    gap: '12px',
  },
  // 大卡：padding 0 让图片区通栏贴边（圆角裁切靠 overflow hidden），
  // 右侧信息栏自带内边距
  card: {
    padding: '0px',
    display: 'grid',
    gridTemplateColumns: '150px minmax(0, 1fr)',
    overflow: 'hidden',
  },
  portrait: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '190px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  portraitImg: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  portraitChar: {
    fontSize: '40px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    minWidth: 0,
  },
  headRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  name: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  updated: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // markdown-lite 原文三行截断（展示层不解析，BR-005）；大卡右侧有宽度，
  // 比小卡的 2 行多给一行
  greeting: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  count: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export function CharactersView() {
  const styles = useStyles();
  const lift = useCardLiftStyles();
  const page = usePageContainerStyles('grid');
  const { t, i18n } = useTranslation();
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);

  useEffect(() => {
    void listCharacters().then(setCharacters);
  }, []);

  return (
    <div className={page}>
      <div className={styles.root}>
        <Title1 as="h1">{t('characters.title')}</Title1>
        <Button appearance="primary" style={{ alignSelf: 'flex-start' }}>
          {t('characters.new')}
        </Button>
        <div className={styles.grid}>
          {characters.map((character) => (
            <Card key={character.id} size="small" className={mergeClasses(styles.card, lift.root)}>
              <div className={styles.portrait}>
                {character.avatar ? (
                  <img
                    className={styles.portraitImg}
                    src={character.avatar}
                    alt={character.name}
                  />
                ) : (
                  <Text className={styles.portraitChar}>{character.name.slice(0, 1)}</Text>
                )}
              </div>
              <div className={styles.info}>
                <div className={styles.headRow}>
                  <Text className={styles.name}>{character.name}</Text>
                  <Text className={styles.updated}>
                    {formatRelative(character.updatedAt, i18n.language)}
                  </Text>
                </div>
                <Text className={styles.greeting}>{character.greeting}</Text>
                <div className={styles.meta}>
                  <Badge appearance="tint">
                    {t('characters.renderStyle')} · {character.renderStyle}
                  </Badge>
                  <Text className={styles.count}>
                    {t('characters.sessionCount', { count: character.sessionCount })}
                  </Text>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
