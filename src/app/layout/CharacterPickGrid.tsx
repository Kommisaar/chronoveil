/**
 * 新建会话对话框两步共用的选人迷你海报卡网格（从 NewSessionDialog 抽出的
 * 纯展示件，行为零变化）：复用角色页海报卡视觉（posterGradientOf 海报渐变 +
 * 首字/头像 + 名字条，与 CharactersView 同一事实源），适配为对话框内的可选
 * 中迷你卡（aria-pressed 表达选中态）。加载中不出网格，空库出一行提示；
 * 「你的扮演位」记号只标在 userBadgeId 指向的卡上（阵容步）。
 */
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { CharacterSummary } from '../../api/types';
import { posterGradientOf } from '../../features/characters/posterGradient';

const useStyles = makeStyles({
  hint: {
    marginTop: tokens.spacingVerticalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // 选人卡网格（两步共用）：三列迷你海报卡，限高滚动（卡库可多于首屏）
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalS,
    maxHeight: '320px',
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXXS,
  },
  // 迷你海报卡：复用角色页海报视觉（渐变底 + 首字/头像 + 名字条），适配选中态
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-end',
    aspectRatio: '3 / 4',
    padding: '0px',
    // 选中圈：常态透明 2px 描边（griffel 禁 border 简写，走 shorthands 展开
    // longhand——同 ChatView composerCard 的 focus 描边先例），选中换品牌色
    ...shorthands.border('2px', 'solid', 'transparent'),
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    cursor: 'pointer',
    fontFamily: 'inherit',
    ':hover': { filter: 'brightness(1.12)' },
  },
  cardSelected: {
    // 选中圈：品牌色描边（渐变底上始终可辨）
    ...shorthands.borderColor(tokens.colorBrandStroke1),
  },
  posterImg: {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  letter: {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  // 底部压暗条（角色页 scrim 同语义）：保证名字在海报上可读
  scrim: {
    position: 'absolute',
    right: '0',
    bottom: '0',
    left: '0',
    height: '40%',
    backgroundImage:
      'linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0) 100%)',
  },
  name: {
    position: 'relative',
    width: '100%',
    padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXXS}`,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase200,
    textAlign: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 选中角标（右上角对勾）：aria-pressed 之外的可视冗余
  check: {
    position: 'absolute',
    top: '4px',
    right: '6px',
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  // 扮演位记号（阵容步的已选扮演卡，左上角小徽标）
  roleBadge: {
    position: 'absolute',
    top: '4px',
    left: '4px',
    padding: '1px 5px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: 'rgba(0,0,0,0.55)',
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase100,
  },
});

export interface CharacterPickGridProps {
  /** 现役角色清单（侧栏拉取后传入）；null = 加载中，不出网格。 */
  characters: CharacterSummary[] | null;
  /** 当前选中卡 id 集合：单选步至多一元素，阵容步为点选序集合。 */
  selectedIds: number[];
  /** 点选回调：单选步由调用方收窄为单值语义，阵容步为切换语义。 */
  onToggle: (characterId: number) => void;
  /** 阵容步的扮演位记号卡 id；单选步传 null。 */
  userBadgeId: number | null;
  /** 提交进行中禁点（与对话框动作钮同源）。 */
  disabled: boolean;
}

/** 选人迷你海报卡网格（FR-014 两步选人共用）。 */
export function CharacterPickGrid(props: CharacterPickGridProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const { characters, selectedIds, onToggle, userBadgeId, disabled } = props;

  if (characters === null) return null;
  if (characters.length === 0) {
    return <div className={styles.hint}>{t('sessions.noCharacters')}</div>;
  }
  return (
    <div className={styles.cardGrid}>
      {characters.map((character) => {
        const selected = selectedIds.includes(character.id);
        return (
          <button
            key={character.id}
            type="button"
            className={mergeClasses(styles.card, selected && styles.cardSelected)}
            style={{ backgroundImage: posterGradientOf(character) }}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onToggle(character.id)}
          >
            {character.avatar ? (
              <img className={styles.posterImg} src={character.avatar} alt="" />
            ) : (
              <span className={styles.letter} aria-hidden="true">
                {character.name.slice(0, 1)}
              </span>
            )}
            <span className={styles.scrim} aria-hidden="true" />
            {userBadgeId === character.id && (
              <span className={styles.roleBadge}>{t('sessions.wizard.yourRole')}</span>
            )}
            <span className={styles.name}>{character.name}</span>
            {selected && (
              <span className={styles.check} aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
