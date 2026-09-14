/**
 * 幕后活动条（Task-07）：把记忆探索的 activity 事件轨迹透出为「避免干等」的轻量 UI。
 *
 * 三态行为：
 * - 折叠态（默认）：一行细字「正在回忆…」缓慢脉动（克制动效，风格参照
 *   indicatorMotion 的减速曲线量级）；dossierReady 后短暂换「翻到了。」；
 *   researchSkipped（快车道零工具调用）整条不渲染，零打扰；
 * - 展开态（点击折叠行切换）：技术步骤列表——每条 phase 本地化标签 + detail
 *   原文（toolCall / toolResult 的技术摘要；dossierReady 的 detail 即卷宗预览）；
 * - 让位：首个 token / reasoning 后（hub 的 activityYielded）折叠条收起为
 *   「已回忆」小标记，仍可点开回看——终态前保留一次展开入口；done / error
 *   后 hub 清空轨迹，本组件随空轨迹归零消失。让位时若面板已展开则保持展开，
 *   不打断正在阅读步骤的用户。
 *
 * 纯浏览器 mock 无事件流（subscribeStream no-op）：轨迹恒空，本组件永不出现。
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActivityStep } from './streamHub';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '2px',
  },
  // 折叠行与让位小标记共用：无边框透明按钮（整行可点展开回看），细字次级色。
  // 审计 C2 曾列为本钩子候选，实测不迁：hit 是文字钮（无固定尺寸、无图标、
  // 无悬停反馈，靠可见文案本身可点），useGhostIconButtonStyles 的档位语义
  // （固定 28/36px 容器 + svg 规格 + 悬停反馈）与其形态全部冲突，硬套需逐条
  // 覆写尺寸/居中/悬停/前景，样板不减反增且语义错位
  hit: {
    alignSelf: 'flex-start',
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    color: tokens.colorNeutralForeground3,
  },
  // 脉动只挂在「正在回忆…」上（进行中才有呼吸感；「翻到了。」是完成态，静止）
  pulse: {
    display: 'inline-block',
    animationName: {
      '0%': { opacity: 0.45 },
      '100%': { opacity: 1 },
    },
    animationDuration: '1.4s',
    animationIterationCount: 'infinite',
    animationDirection: 'alternate',
    animationTimingFunction: 'ease-in-out',
    '@media (prefers-reduced-motion: reduce)': {
      animation: 'none',
    },
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    color: tokens.colorNeutralForeground3,
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: tokens.spacingHorizontalS,
  },
  step: {
    display: 'flex',
    flexDirection: 'column',
  },
  stepLabel: {
    color: tokens.colorNeutralForeground2,
  },
  // detail 是后端技术摘要原文：保留其中的换行与断词（同正文排版纪律）
  stepDetail: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
});

interface ActivityNoticeProps {
  /** 幕后活动轨迹（hub 终态清空后为空数组 → 不渲染） */
  activity: readonly ActivityStep[];
  /** 正文已开始的让位标记（首个 token / reasoning 后折叠条换成小标记） */
  yielded: boolean;
}

export function ActivityNotice({ activity, yielded }: ActivityNoticeProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (activity.length === 0) return null;
  const last = activity[activity.length - 1];
  if (last === undefined) return null; // noUncheckedIndexedAccess 收窄（length 已保证非空）
  // 快车道：研究员判定无需检索直接放行，不渲染任何内容（零打扰）
  if (last.phase === 'researchSkipped') return null;
  return (
    <div className={styles.root}>
      <button type="button" className={styles.hit} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {yielded ? (
          t('chat.activity.recalled')
        ) : (
          <span className={styles.pulse}>
            {last.phase === 'dossierReady' ? t('chat.activity.found') : t('chat.activity.recalling')}
          </span>
        )}
      </button>
      {open && (
        <div className={styles.panel}>
          {activity.map((step, index) => (
            <div key={index} className={styles.step}>
              <span className={styles.stepLabel}>{t(`chat.activity.phase.${step.phase}`)}</span>
              {step.detail !== null && <span className={styles.stepDetail}>{step.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
