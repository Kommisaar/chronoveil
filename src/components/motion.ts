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

/** 下拉推钮（DropdownPushButton，qfluentwidgets DropDownPushButton/RoundMenu
    复刻件）开合档：小浮层要跟手，独立于 400ms 弹簧入场档（那是面板/卡片级
    语言）。进/退同档——退场是纯淡化无位移，曲线可感度趋零。 */
export const DROPDOWN_POP_MS = 150;

/** 编辑器共享元素 FLIP 退场缩回（与 EDITOR_FADE_MS 同值但语义不同：
    形变档与淡化档各自独立，日后可单独调）。 */
export const MORPH_OUT_MS = 200;

/** 编辑器 surface / 背板退场与 surface 进场的纯淡化档。 */
export const EDITOR_FADE_MS = 200;

/** 编辑器毛玻璃背板淡入：先于面板形变铺氛围，比面板淡化更慢。 */
export const EDITOR_BACKDROP_IN_MS = 280;

/** 聊天思考两态收尾过渡档（M4，用户拍板 200ms）：思考呈现流式期（引擎
    think 胶囊，ADR-011）→ 落库终态（React Accordion）切换时刻的交叉淡化。
    现状收尾是列表重挂载（历史行挂载与流式行卸载同轮提交，两形态无共存
    帧），交叉淡化只有终态侧落点——当前单侧消费（Accordion 淡入，keyframes
    见 app.css 的 reasoning-fade-in）；若日后流式行能保活淡出则升级双侧。 */
export const CROSSFADE_MS = 200;

/** 编辑器 body 内容交叉淡化：晚于形变淡入（延迟
    EDITOR_BODY_IN_DELAY_MS）遮住缩放挤压，退场先撤。 */
export const EDITOR_BODY_IN_MS = 160;
export const EDITOR_BODY_IN_DELAY_MS = 90;
export const EDITOR_BODY_OUT_MS = 70;

/** 共享选中指示条位移动画（含中途纵向拉长形变，行程长，用 durationSlower
    同值的更慢档）。 */
export const INDICATOR_MOVE_MS = 400;

// —— 清单浮现错峰 ——

/** 清单浮现统一错峰档：会话侧栏条目（sidebar-enter）与海报墙批内揭示
    （useRevealOnScroll）共用——两处是同一种「清单浮现」语言，原
    16ms/60ms 并存（3.75 倍差）系漂移非设计（2026-09-13 收敛）。取
    中庸 24ms：侧栏小行错峰可辨，海报墙一批（约 10 张大卡）在
    0~216ms 内全部起播——首卡 pop（POP_IN_MS=400ms）过半时尾卡起播，
    同一波内完成，无 60ms 档 0~540ms 的拖尾，也不似 16ms 档近乎同步。 */
export const ENTER_STAGGER_MS = 24;

/** 错峰封顶：过长清单只对首屏节奏负责，封顶后的条目同刻浮现。 */
export const ENTER_STAGGER_CAP_MS = 360;

/** 称号轮换停留时长（2026-09-16 典藏卡称号行「一次只显示一个，然后轮换」）：
    多称号单显的驻留间隔。中途曾因「太快」放缓到 8s，2026-09-16 用户拍板
    改回 4s 定稿。 */
export const TITLES_ROTATE_MS = 4000;

/** 称号两段式换题时长（2026-09-16 典藏卡称号行「渐变轮换，渐入渐出」→
    「先完全淡出，再淡入」）：旧题加速淡出、新题延迟同时长后减速淡入，
    单段时长即本 token。首版复用 EDITOR_FADE_MS=200 交叉淡化（2026-09-16
    用户反馈太快），放缓到 800ms 并由同时交叉改为先后两段。 */
export const TITLES_CROSSFADE_MS = 800;
