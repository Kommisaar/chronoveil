// 卡片悬停浮起动效：Hover 时弹性上浮 + 微放大、阴影加深。弹簧曲线与
// 海报墙入场动画（app.css 的 card-enter-pop）同族——过冲再回落，入场与
// 悬停共用同一套「弹簧语言」。悬停位移属装饰性运动，整体收进
// no-preference 门控（2026-09-13 补齐：此前是全仓唯一无 reduce 分支的
// Griffel 动效类）——开启「减弱动态」时卡片悬停不位移不加阴影。
// 共享给可点击卡片；表单容器卡片刻意不加，避免填写时内容随悬停跳动。
// 使用方必须用 mergeClasses(styles.xxx, lift.root) 合并，不能用模板字符串
// 拼接——Griffel 每个返回值都带序列标识，拼接后 mergeClasses 只识别第一
// 个序列，后续整套类会被静默丢弃。
import { makeStyles, tokens } from '@fluentui/react-components';
import { SPRING_CURVE } from './motion';

export const useCardLiftStyles = makeStyles({
  root: {
    transitionProperty: 'transform, box-shadow',
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: SPRING_CURVE,
    '@media (prefers-reduced-motion: no-preference)': {
      ':hover': {
        transform: 'translateY(-6px) scale(1.02)',
        boxShadow: tokens.shadow16,
      },
    },
  },
});
