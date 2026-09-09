// 共享动效常量：卡片「弹簧语言」的过冲曲线。入场、悬停上浮、共享元素
// 形变（编辑器对话框从卡片长出/缩回）共用同一条曲线——过冲再回落；
// 退场刻意不用弹簧（退场要安静）。app.css 的 @keyframes 无法引用 TS
// 常量，其使用处（如 enterPop 的 animationTimingFunction）以注释对齐。
export const SPRING_CURVE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
