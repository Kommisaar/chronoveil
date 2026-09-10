# ChronoVeil 渲染引擎 vs demo 对齐审计报告（Task-09 产出）

> 2026-09-10 夜间自主迭代，只读审计。基准：`docs/streaming-animations.html`（711 行，
> 下称 demo，行号均指此文件）vs `src/engine/`。接线层：`src/features/chat/StreamingMessage.tsx`、
> `ChatView.tsx`。审计时点 master = 659ea47（Task-01/02/03 已合并）。

## 一、逐机制对齐表（摘要）

核心机制全部逐参数一致，无一处数值漂移：tick 16ms、信用公式/上限 3/空转清零/dt 钳制
100ms、追速 k=max(.25,1/(1+积压/45))、interval 下限 10ms、微停记账、节奏范围 10–160
默认 45、句末/逗号微停字符集（逐字符相同）、段落深呼吸、空行分段、场景线正则（逐字
相同）、hr/para 单元序、段落封存、粒度合并、发射循环、收尾时机、光标随行（引擎改
`.stream-cursor` 类，合理）、decode 乱码（glyph 池/42ms/7+rand×6 跳/定格全同）、随机
落点公式、双 rAF reveal（引擎加无 rAF 退化，加固）、dots 加载点（demo 首包前人为延迟
1150ms 引擎无——合理，真实网络下不需要）、思考通道全参数（THINK_PHASE 同名同值、
12 条贴士逐条相同、CSS 逐条相同；引擎把匿名 setTimeout 登记并 disarm，更严格）、
18 风格 CSS 仪式逐风格 diff 全同（flip 的 perspective 移到容器，等价）、
`*动作*`/`**加粗**` 配色同 demo。

合理的流式化演进偏离：场景线流式候选（ADR-008 延迟判定 vs demo 全文预解析）、
`**a*b**` 病态输入语义、未闭合标记字面吐出。

## 二、2026-09-10 列表扩展核对

demo 确认**无任何列表语法对应物**，确系单向演进且全链路有测试
（parser/take-unit/static/index 四处）。engine.css 悬挂缩进自洽
（`padding-left:1.2em; text-indent:-1.2em`，紧凑行距覆盖正确；长序号 >1.2em 轻微错位
为已自认的 lite 取舍）。

边缘语义漂移（低，待确认）：行首 `- - -` 在 demo 是普通文本，引擎因列表候选先行会把
首个 `- ` 定型为列表项产出「• - - -」（`parser.ts:164,229-247`）。修复可选：候选定型
前预读整行。

## 三、demo 有而引擎无（判断）

| demo 功能 | 判断 |
|---|---|
| 网络抖动模型 netDelay/burst | 不适用（真实 IPC 事件流） |
| 直出模式 | 不适用（引擎 `replayInstant` 已覆盖真实需求） |
| stats 面板（字数/缓冲/倍速/用时） | 可选搬运（引擎已暴露 pending/charsEmitted/onFinish）；无产品需求则搁置 |
| 播放中切风格/节奏/--dur 即时生效 | 可选搬运（引擎 API 齐全，缺接线 → 见问题 8） |
| type 风格自动切粒度 1 | 不适用（引擎粒度与风格解耦更干净） |
| dots 首包前 1150ms 人为延迟 | 不适用 |

## 四、引擎有而 demo 无（演进记录，测试覆盖充分）

流式 markdown-lite 解析（parser.test 23 用例）、扁平列表（四处覆盖）、
renderStaticMarkdown（static.test 8 用例；**聊天历史行未接线** → 问题 1）、
流式思考三件套、replayInstant、cancel 语义、CreditClock、ANIM_STYLES 元数据、
onFinish 字数回报。无直测缺口：光标开关/粒度热调/dots 生命周期/microPauseMs 对
{item}/过气回合 appendThink（→ 问题 6，Task-06 已部分认领）。

## 五、18 风格三方核对

18/18 齐全：id、顺序（fade→caret→type→rise→blur→dots→neon→decode→flip→drop→scan→
ink→glitch→write→dust→pulse→condense→spot）、关键帧、倍率、boxed 标记（9 个）全部
对齐，无缺失/多出/命名漂移。`type` id 权威性确认：引擎与 demo 均为 `type`，漂移方是
Rust 侧默认值 `typewriter`（Task-10 立项）。

## 六、值得行动的项（按优先级）

**bug / 疑似回归类**

1. **（高）落库后的历史消息不走引擎渲染**：`ChatView.tsx:358-361` 直接插
   `{message.content}` 纯文本（带 pre-wrap），流式期的动作斜体/加粗/场景线/列表在收尾
   后全部变回字面星号。引擎已备 `static.ts` renderStaticMarkdown（目前仅角色编辑器
   人设预览使用）。待确认是否 MVP 有意如此；若非，接线 static 渲染即可。
2. **（中）引擎配色为 demo 暗色硬编码，不随应用主题**：`engine.css:142-152` 的
   `hr.scene::after` 背景 `#141822` 落在 Fluent 主题背景上会带错色矩形；light 主题下
   `.action` #93a5c8、decode #e8b06a 对比度不达标。建议至少 ::after 改透明/继承或
   CSS 变量，其余色值做主题适配评估。
3. **（中）流式容器缺 `white-space: pre-wrap`**：`StreamingMessage.tsx:38-43` body
   样式无 pre-wrap，解析器刻意保留的块内单换行（且微停规则认 `\n`）在流式中折叠成
   空格；demo `.bubble`（L59）与历史行（`ChatView.tsx:89`）都有。一行修复。
4. **（低，待确认）done 落在思考阶段时胶囊被瞬时拆除**：`StreamingMessage.tsx:139-146`
   先 `finishThinking()` 再 `finish()`；`index.ts:225-226` 队列已空即 `finishTurn()` →
   `stopAll()` 把思考胶囊 cancel 掉，收拢动画不播放。已被
   `StreamingMessage.test.tsx:175` 钉住，可能有意；但与 `index.ts:231` 注释「思考中由
   tick 在排空后收尾」矛盾——思考中根本没有 tick。二选一：改 finish() 让思考通道走完
   收拢再收尾，或修正注释并在测试名写明取舍。
5. **（低）`- - -` 行首被解释为列表项**（见二）。

**覆盖缺口类**

6. dots 生命周期、setCursorEnabled、setGranularity、finish() 兜底开演、
   microPauseMs({item})=0、过气回合 appendThink 不喂——无直测；Task-06 已认领兜底
   开演，落地时建议把 dots 与 item 微停一并补上。

**可选搬运 / 改进类**

7. **takeUnit 拆断拉丁词**（`take-unit.ts:18-23`）：demo splitChunks 保证非 CJK 连续段
   整块出场（L384），引擎按定长合并会在词中间断开，boxed/decode 风格下英文观感差一
   档。可加「不拆断 `[A-Za-z0-9]` 连续段」规则。
8. **中途调参不生效**：tuning（风格/节奏/dur）仅挂载时生效（`StreamingMessage.tsx:88-101`），
   引擎 setStyle/setRhythm/setDuration 齐全，接一个 useEffect 即可。待确认产品是否需要。
9. stats 调试视图（引擎数据已备）。

**总结**：核心机制与 demo 逐参数一致；语义差异全部集中在「流式化必然演进」与「接线
层缺口」（静态渲染未接、pre-wrap、主题色、中途调参）；列表扩展为带完整测试的单向演进。
