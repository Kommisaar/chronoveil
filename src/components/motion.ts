// 动效 token 单一事实源（曲线 + 时长档）：TS 消费点一律 import 此处常量，
// 禁止在别处手写字面量（motion.test.ts 有全仓扫描守卫）。CSS 引不到 TS——
// app.css :root 的 --cv-* 变量与本文件对应常量互指同步（parity 由
// motion.test.ts 断言，注释只是人读的线索，测试才是硬约束）。
// 曲线常量镜像 @fluentui/tokens 的同名全局 token（WAAPI 需要具体数值，
// 不能用 var(--…) 引用，故取字面量；升级 Fluent 需对照同步）。

// —— 曲线 ——

/** 弹簧语言：过冲再回落。卡片入场/悬停上浮、色板弹层、编辑器共享元素
    FLIP 进场共用；退场刻意不用弹簧（退场要安静）。 */
export const SPRING_CURVE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/** 统一减速曲线（镜像 curveDecelerateMid）：位移类动画的进场缓动。 */
export const DECELERATE_CURVE = 'cubic-bezier(0, 0, 0, 1)';

/** 统一加速曲线（镜像 curveAccelerateMid）：退场缓动（安静离场）。 */
export const ACCELERATE_CURVE = 'cubic-bezier(1, 0, 1, 1)';

// —— 时长档（ms）——

/** 弹簧入场档：卡片入场（card-enter-pop）、强调色取色器弹层
    （palette-pop-in）、编辑器共享元素 FLIP 进场共用一档——三处同为
    「弹簧 pop 入场」语义，原 480/400/400 并存系漂移无设计理由，归并
    （2026-09-13 动效 token 收敛，取多数派 400：入场宜快，FLIP 开大面板
    与小弹层都不值得多等 80ms）。 */
export const POP_IN_MS = 400;

/** 编辑器共享元素 FLIP 退场缩回（与 EDITOR_FADE_MS 同值但语义不同：
    形变档与淡化档各自独立，日后可单独调）。 */
export const MORPH_OUT_MS = 200;

/** 编辑器 surface / 背板退场与 surface 进场的纯淡化档。 */
export const EDITOR_FADE_MS = 200;

/** 编辑器毛玻璃背板淡入：先于面板形变铺氛围，比面板淡化更慢。 */
export const EDITOR_BACKDROP_IN_MS = 280;

/** 编辑器 body 内容交叉淡化：晚于形变淡入（延迟
    EDITOR_BODY_IN_DELAY_MS）遮住缩放挤压，退场先撤。 */
export const EDITOR_BODY_IN_MS = 160;
export const EDITOR_BODY_IN_DELAY_MS = 90;
export const EDITOR_BODY_OUT_MS = 70;

/** 共享选中指示条位移动画（含中途纵向拉长形变，行程长，用 durationSlower
    同值的更慢档）。 */
export const INDICATOR_MOVE_MS = 400;
