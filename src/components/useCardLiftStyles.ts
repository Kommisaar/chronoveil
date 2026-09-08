// 卡片悬停浮起动效（风格移植自 relay-harbor）：Hover 时浮起、阴影加深。
// 共享给可点击卡片；表单容器卡片刻意不加，避免填写时内容随悬停跳动。
// 使用方必须用 mergeClasses(styles.xxx, lift.root) 合并，不能用模板字符串
// 拼接——Griffel 每个返回值都带序列标识，拼接后 mergeClasses 只识别第一
// 个序列，后续整套类会被静默丢弃。
import { makeStyles, tokens } from '@fluentui/react-components';

export const useCardLiftStyles = makeStyles({
  root: {
    transitionProperty: 'transform, box-shadow',
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      transform: 'translateY(-4px)',
      boxShadow: tokens.shadow16,
    },
  },
});
