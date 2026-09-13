/**
 * 新建会话对话框两步共用的选人迷你海报卡网格（从 NewSessionDialog 抽出的
 * 纯展示件，行为零变化）：复用角色页海报卡视觉（posterGradientOf 海报渐变 +
 * 首字/头像 + 名字条，与 CharactersView 同一事实源），适配为对话框内的可选
 * 中迷你卡（aria-pressed 表达选中态）。加载中出 StateBlock loading 占位
 * （A1 收编，此前不出网格直接留白），空库出一行提示；
 * 「你的扮演位」记号只标在 userBadgeId 指向的卡上（阵容步）。
 *
 * 对比度：OnBrand 白字的四个承载元素（名字条/首字徽标/对勾角标/扮演位徽标）
 * 全部挂 PICK_SCRIM_ALPHA 实底，配对证据与最坏合成推导见常量注释与
 * contrastGuard.test.ts 的海报 OnBrand 清单（2026-09-13 自 UNPAIRABLE 修复）。
 */
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { CharacterSummary } from '../../api/types';
import { StateBlock } from '../../components/StateBlock';
import { posterGradientOf } from '../../features/characters/posterGradient';

/**
 * 海报文字压暗下限（对比度守卫配对依据，与 src/components/contrastGuard.test.ts
 * 的 POSTER_SCRIM_FLOOR 互指）：卡上 OnBrand 白字的承载元素（名字条/首字徽标/
 * 对勾角标/扮演位徽标）全部挂本档不透明度的黑色实底，用户强调色原色直出
 * （posterGradientOf 不做程序化压暗，可为纯白）时最坏合成 =
 * 纯白 accent × (1 − 0.62) 黑实底 → 灰 255×0.38=96.9 → 相对亮度 ≈0.119 →
 * 白字对比 ≈6.2:1 ≥ AA 4.5:1（选 0.62 而非恰好过线的 0.55≈4.76:1 留余量，
 * 与原 scrim 底端 0.65 同档观感）。实底再叠 scrim 时总压暗
 * = 1 − (1−0.62)(1−s) ≥ 0.62，下限不受下层影响。
 */
const PICK_SCRIM_ALPHA = 0.62;

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
    // 行内档圆角 = borderRadiusMedium（Fluent v9 实测 4px；三档圆角规范
    // 最内档，同 ProviderCard；页面级卡片表面 = 16px 见
    // CharacterEditorDialog surface，规范常量 SURFACE_RADIUS_PAGE_CARD
    // 在 src/components/surfaceSpec.ts）
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
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // 首字徽标（圆形实底）：无头像时的占位语言从「裸大字浮在渐变上」改为
    // 「压暗圆盘上的字母」，配合 PICK_SCRIM_ALPHA 保证 OnBrand 可读
    width: '48px',
    height: '48px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: `rgba(0, 0, 0, ${PICK_SCRIM_ALPHA})`,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  // 底部压暗渐变（角色页 scrim 同语义）：只负责海报下缘的视觉过渡，
  // 名字可读性由名字条实底（PICK_SCRIM_ALPHA 下限）保证
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
    // 名字条实底（PICK_SCRIM_ALPHA）：OnBrand 白字 × 任意 accent/头像 ≥AA
    backgroundColor: `rgba(0, 0, 0, ${PICK_SCRIM_ALPHA})`,
    padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXXS}`,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase200,
    textAlign: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 选中角标（右上角对勾）：aria-pressed 之外的可视冗余；角标实底同
  // roleBadge 形态（原裸字浮在渐变上部，scrim 覆盖不到，无对比度下限）
  check: {
    position: 'absolute',
    top: '4px',
    right: '6px',
    padding: '1px 5px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: `rgba(0, 0, 0, ${PICK_SCRIM_ALPHA})`,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  // 扮演位记号（阵容步的已选扮演卡，左上角小徽标）：实底 0.55 → 共享下限
  // 0.62（原值最坏 4.76:1 恰过线余量过薄，见 contrastGuard UNPAIRABLE 台账）
  roleBadge: {
    position: 'absolute',
    top: '4px',
    left: '4px',
    padding: '1px 5px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: `rgba(0, 0, 0, ${PICK_SCRIM_ALPHA})`,
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

  if (characters === null) {
    // A1 三态收编：加载中出 StateBlock loading 占位（此前返回 null，对话框
    // 该区域整块空白）；对话框内无固定高度容器，占位按内容收紧
    return <StateBlock state="loading" label={t('sessions.wizard.loadingCharacters')} />;
  }
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
