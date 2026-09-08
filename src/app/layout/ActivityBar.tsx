// 第一层活动栏（风格照抄 relay-harbor）：汉堡切换双态——收起（48px 纯
// 图标 + tooltip，默认）/ 展开（图标 + 文字标签，200px）；「对话」「角色」
// 在顶部，「设置」钉在底部（footer 惯例）。选中态为共享指示条（左缘
// 3×16 品牌色竖条 + 选中底色，图标不染品牌色）；指示条为单个共享元素：
// 切换目标时纵向拉长再缩短、位移到新条目（WAAPI 关键帧）。
// 视图切换走 Zustand（无路由），条目用 button + aria-current="page" 表达。
import { Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Chat24Regular,
  LineHorizontal3Regular,
  People24Regular,
  Settings24Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { moveIndicator } from '../../components/indicatorMotion';
import { useUiStore } from '../../stores/ui';
import type { View } from '../../stores/ui';

const useStyles = makeStyles({
  rail: {
    // 共享指示条的定位参照（absolute 包含块）
    position: 'relative',
    width: '48px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: tokens.spacingVerticalXS,
    // 水平内边距 6px（无对应 token）= 收起态条目左缘 (48-36)/2：条目两态
    // 统一左锚定。若保留居中对齐，宽度动画期间图标会被居中算法带着滑动。
    padding: `${tokens.spacingVerticalS} 6px`,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    overflowX: 'hidden',
    // 展开/收起宽度动画：两态统一减速曲线（Fluent motion 惯例的入场曲线，
    // 快速启程、末端轻缓落定）
    transitionProperty: 'width',
    transitionDuration: tokens.durationGentle,
    transitionTimingFunction: tokens.curveDecelerateMid,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  railExpanded: {
    width: '200px',
  },
  item: {
    width: '36px',
    height: '36px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    textDecoration: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    // 图标统一 20px：部分图标 svg 带显式 width/height="24" 属性，仅设
    // font-size 对其无效，必须用 CSS width/height 覆盖，否则收起（居中）
    // 与展开（左对齐）两态偏移不一致导致图标跳动。flexShrink:0 —— 动画
    // 末尾内容区变窄时 svg 作为 flex 子项会被挤压缩小，空间不足由标签裁剪
    '> svg': { fontSize: '20px', width: '20px', height: '20px', flexShrink: 0 },
  },
  // 原生 button 无 Fluent 外观重置：默认边框/底色/光标需手动抹平
  buttonReset: {
    border: 'none',
    padding: '0px',
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  itemExpanded: {
    width: '100%',
    justifyContent: 'flex-start',
    gap: tokens.spacingHorizontalM,
    // 左内边距 = 收起态图标偏移 (36-20)/2 = 8px：指示条→图标间隙两态恒定 5px
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalM,
  },
  // 选中仅以指示条+底色表达：字体（字重/颜色）与未选中项保持一致
  active: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Selected },
  },
  // 共享选中指示条：单个元素在条目间位移（位移动画见 useLayoutEffect），
  // 纵向位置由 JS 写入 transform；默认隐藏，定位后显示
  indicator: {
    position: 'absolute',
    // 与条目左缘对齐（rail 水平内边距 6px，无对应 token）
    left: '6px',
    top: '0px',
    width: '3px',
    height: '16px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
    pointerEvents: 'none',
    visibility: 'hidden',
  },
  label: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  spacer: { flex: 1 },
});

/** 收起态外包 tooltip；展开态标签已可见 */
function railTip(expanded: boolean, label: string, node: ReactElement): ReactNode {
  if (expanded) return node;
  return (
    <Tooltip content={label} relationship="label" positioning="after">
      {node}
    </Tooltip>
  );
}

const TOP_ITEMS: { view: View; Icon: ComponentType; labelKey: string }[] = [
  { view: 'chat', Icon: Chat24Regular, labelKey: 'nav.chat' },
  { view: 'characters', Icon: People24Regular, labelKey: 'nav.characters' },
];

export function ActivityBar() {
  const styles = useStyles();
  const { t } = useTranslation();
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const railExpanded = useUiStore((s) => s.railExpanded);
  const toggleRailExpanded = useUiStore((s) => s.toggleRailExpanded);
  // 条目内容（文字标签等）的展开态与面板宽度分开关：
  // 展开时立即生效（内容随宽度揭出）；收起时保持展开样式随面板
  // 一并被裁剪，待宽度过渡结束（transitionend，300ms 兜底）再切换，
  // 否则动画未完内容就先消失。
  const [contentExpanded, setContentExpanded] = useState(railExpanded);
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  // 指示条定位与位移动画：目标条目变化时从当前视觉位置滑向新位置，
  // 中途 scaleY 拉长再收短。初次定位与系统「减弱动态效果」时直接就位。
  // transform/visibility 由 JS 写入（指示条是共享元素，不随条目重渲染）。
  useLayoutEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const active = nav.querySelector<HTMLElement>('button[aria-current="page"]');
    if (!active) {
      indicator.style.visibility = 'hidden';
      return;
    }
    // 条目内偏移 10px = (36-16)/2；offsetTop 以 rail（position:relative）为包含块
    indicator.style.visibility = 'visible';
    moveIndicator(indicator, { x: 0, y: active.offsetTop + 10 });
  }, [view, railExpanded, contentExpanded]);

  useEffect(() => {
    if (railExpanded) {
      setContentExpanded(true);
      return;
    }
    const nav = navRef.current;
    if (!nav) return;
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        setContentExpanded(false);
      }
    };
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target === nav && e.propertyName === 'width') settle();
    };
    nav.addEventListener('transitionend', onTransitionEnd);
    const fallback = window.setTimeout(settle, 300);
    return () => {
      nav.removeEventListener('transitionend', onTransitionEnd);
      window.clearTimeout(fallback);
    };
  }, [railExpanded]);

  const railLabel = t(railExpanded ? 'nav.collapsePane' : 'nav.expandPane');

  return (
    <nav ref={navRef} className={mergeClasses(styles.rail, railExpanded && styles.railExpanded)} aria-label="ChronoVeil">
      <div ref={indicatorRef} className={styles.indicator} aria-hidden="true" />
      {/* 汉堡两态均纯图标：不随展开加文字，仅收起态外包 tooltip；
          aria-label 始终保留（无可见文本） */}
      {railTip(
        contentExpanded,
        railLabel,
        <button
          type="button"
          className={mergeClasses(styles.item, styles.buttonReset)}
          onClick={toggleRailExpanded}
          aria-label={railLabel}
          aria-expanded={railExpanded}
        >
          <LineHorizontal3Regular />
        </button>,
      )}

      {TOP_ITEMS.map(({ view: target, Icon, labelKey }) => {
        const label = t(labelKey);
        const active = view === target;
        return (
          <Fragment key={target}>
            {railTip(
              contentExpanded,
              label,
              <button
                type="button"
                className={mergeClasses(
                  styles.item,
                  styles.buttonReset,
                  contentExpanded && styles.itemExpanded,
                  active && styles.active,
                )}
                onClick={() => setView(target)}
                aria-current={active ? 'page' : undefined}
              >
                <Icon />
                {contentExpanded ? <span className={styles.label}>{label}</span> : null}
              </button>,
            )}
          </Fragment>
        );
      })}

      <div className={styles.spacer} />
      {railTip(
        contentExpanded,
        t('nav.settings'),
        <button
          type="button"
          className={mergeClasses(
            styles.item,
            styles.buttonReset,
            contentExpanded && styles.itemExpanded,
            view === 'settings' && styles.active,
          )}
          onClick={() => setView('settings')}
          aria-current={view === 'settings' ? 'page' : undefined}
        >
          <Settings24Regular />
          {contentExpanded ? <span className={styles.label}>{t('nav.settings')}</span> : null}
        </button>,
      )}
    </nav>
  );
}
