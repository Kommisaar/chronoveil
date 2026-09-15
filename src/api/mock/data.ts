import type { CharacterSummary, ChatMessage, SessionSummary, WorldSummary } from '../types';

/** mock 数据：纯浏览器开发用（ADR-010）；结构与 SQLite 各表对应（data_model）。
 *  会话按多角色阵容制形态（character_instances 表 + messages.instance_id 存储，
 *  wire 回显 instances / 消息 characterId）：实例 id 全局自增（1–6），is_user
 *  恰好一处（D2），name / renderStyle 为建会话时快照（D1）。 */

const now = Date.now();
const min = 60_000;

export const characters: CharacterSummary[] = [
  {
    id: 1,
    name: '苏鸢',
    avatar: null,
    gender: '女',
    age: '24',
    titles: [],

    persona: '雨夜电话亭的守夜人，说话克制，旧情藏在对白缝隙里。',
    renderStyle: 'type',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 3 * min,
    sessionCount: 2,
  },
  {
    id: 2,
    name: '林深',
    avatar: null,
    gender: '男',
    age: '31',
    // 称号 + 带 markdown 的 persona：专供卡面升级（Task-02）断言——称号行
    // 「守夜人 · 旧书店主」与摘录行（excerptOf 剥 ** 加粗标记）
    titles: ['守夜人', '旧书店主'],

    persona: '**旧书店老板**，雨天总在擦一盏灯。',
    renderStyle: 'ink',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 2 * 24 * 60 * min,
    sessionCount: 1,
  },
  // —— 以下为排版验收批次：长短名字（超长中文 / 带空格英文 / 不断行
  // 长词），专供检查卡片名字换行表现 ——
  {
    id: 3,
    name: '夜航西飞的守灯人',
    avatar: null,
    gender: '男',
    age: '58',
    titles: [],
    
    persona: '末班航船上的灯塔守护者，用灯光的明灭节奏和水手们约定暗号。',
    renderStyle: 'rise',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 3 * 24 * 60 * min,
    sessionCount: 3,
  },
  {
    id: 4,
    name: '阿澈',
    avatar: null,
    gender: '男',
    age: '47',
    titles: [],
    
    persona: '巷口修表匠，话少，手稳。',
    renderStyle: 'caret',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 5 * 24 * 60 * min,
    sessionCount: 0,
  },
  {
    id: 5,
    name: 'Sir Reginald Ashworth',
    avatar: null,
    gender: '男',
    age: '62',
    titles: [],
    
    persona: 'A retired royal cartographer who keeps drawing maps of places that do not exist yet.',
    renderStyle: 'flip',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 8 * 24 * 60 * min,
    sessionCount: 1,
  },
  {
    id: 6,
    name: '星轨观测站的算术巫师',
    avatar: null,
    gender: '女',
    age: '26',
    titles: [],
    
    persona: '住在山顶废弃天文台，把星图当账本记，相信每颗流星都是一笔待结算的债务。',
    renderStyle: 'decode',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 13 * 24 * 60 * min,
    sessionCount: 7,
  },
  {
    id: 7,
    name: '白鸦',
    avatar: null,
    gender: '女',
    age: '27',
    titles: [],
    
    persona: '城市传说收集者，只录不评，磁带机从不离身。',
    renderStyle: 'neon',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 21 * 24 * 60 * min,
    sessionCount: 2,
  },
  {
    id: 8,
    name: 'Constellationwhisperer',
    avatar: null,
    gender: null,
    age: null,
    titles: [],
    
    persona: 'A wandering stargazer whose unbroken single-word name is here on purpose to test word wrapping on narrow cards.',
    renderStyle: 'blur',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 30 * 24 * 60 * min,
    sessionCount: 0,
  },
  {
    id: 9,
    name: '老周',
    avatar: null,
    gender: '男',
    age: '52',
    titles: [],
    
    persona: '夜班出租车司机，后视镜里看遍这座城市。',
    renderStyle: 'type',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 45 * 24 * 60 * min,
    sessionCount: 12,
  },
  {
    id: 10,
    name: '缄默之塔的第十三位图书管理员',
    avatar: null,
    gender: '女',
    age: null,
    titles: [],
    
    persona: '管理一座不许说话的塔，用字条和访客交流；塔里第十三层没有书，只有回声。',
    renderStyle: 'dust',
    modelProviderId: null,
    modelName: null,
    modelTemperature: null,
    accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
    updatedAt: now - 60 * 24 * 60 * min,
    sessionCount: 1,
  },
];

// 种子世界（2026-09-15 世界卡定稿）：两张——「空白舞台」（默认历 / 空世界观，
// 兜底选卡）与「雾灯航线」（七曜和历 + 世界观示范）。七曜历字面与
// src/components/calendarPresets.ts 的 seven 预设一致（api 层不可反向 import
// components，按「跨文件常量互指」纪律注释对齐）。
export const SEED_WORLDS: WorldSummary[] = [
  {
    id: 1,
    name: '空白舞台',
    worldbook: '',
    calendar: null,
    updatedAt: now - 3 * 24 * 60 * min,
  },
  {
    id: 2,
    name: '雾灯航线',
    worldbook: '永夜的海上城市，雾从海面漫上甲板。灯船按七曜轮值巡线，灯光的明灭节奏是水手间通行的暗语。',
    calendar: {
      name: '七曜和历',
      months: ['睦月', '如月', '弥生', '卯月', '皋月', '水无月', '文月', '叶月', '长月', '神无月', '霜月', '师走'],
      daysPerMonth: 30,
      dayNames: ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日', '日曜日'],
      festivals: { 315: '七五三', 360: '大晦日' },
    },
    updatedAt: now - 5 * 24 * 60 * min,
  },
];

// 种子阵容：D2 允许自己跟自己对话（自演自），会话 1/2 即此形态；会话 3 演示
// 跨卡对话（用户扮演苏鸢、LLM 扮演林深）。实例 id 全局唯一：1–2 / 3–4 / 5–6。
// name / renderStyle 为建会话时快照（D1：值拷贝自卡，改卡不回写；种子即卡现值）。
export const sessions: SessionSummary[] = [
  {
    id: 1,
    title: '雨夜来电',
    updatedAt: now - 3 * min,
    instances: [
      { id: 1, name: '苏鸢', isUser: true, characterId: 1, renderStyle: 'type' },
      { id: 2, name: '苏鸢', isUser: false, characterId: 1, renderStyle: 'type' },
    ],
    forkedFromSessionId: null,
    forkAnchorSceneIdx: null,
  },
  {
    id: 2,
    title: '旧书店的约定',
    updatedAt: now - 26 * min,
    instances: [
      { id: 3, name: '苏鸢', isUser: true, characterId: 1, renderStyle: 'type' },
      { id: 4, name: '苏鸢', isUser: false, characterId: 1, renderStyle: 'type' },
    ],
    forkedFromSessionId: null,
    forkAnchorSceneIdx: null,
  },
  {
    id: 3,
    title: '深巷追凶',
    updatedAt: now - 2 * 24 * 60 * min,
    instances: [
      { id: 5, name: '苏鸢', isUser: true, characterId: 1, renderStyle: 'type' },
      { id: 6, name: '林深', isUser: false, characterId: 2, renderStyle: 'ink' },
    ],
    forkedFromSessionId: null,
    forkAnchorSceneIdx: null,
  },
];

// characterId 语义（wire 定案，对齐 ipc.rs to_chat_message）：assistant 条 =
// 发声的 LLM 位实例真值（2/4/6），user 条恒 null（调用方按 role 渲染）。
export const messagesBySession: Record<number, ChatMessage[]> = {
  1: [
    {
      id: 1,
      sessionId: 1,
      characterId: 2,
      role: 'assistant',
      content: '**雨点敲着窗棂**，我数到第七声的时候，电话响了。\n\n是你吗？这个时间打来的人，不多。',
      reasoning: '开场白：营造雨夜氛围，留下悬念钩子，等待用户回应以确定故事走向。',
      thinkMs: 2400,
      createdAt: now - 10 * min,
      interrupted: false,
    },
    {
      id: 2,
      sessionId: 1,
      characterId: null,
      role: 'user',
      content: '是我。你还留着这个号码，我有点意外。',
      reasoning: null,
      thinkMs: null,
      createdAt: now - 8 * min,
      interrupted: false,
    },
    {
      id: 3,
      sessionId: 1,
      characterId: 2,
      role: 'assistant',
      content: '有些东西我不丢，号码是其中之一。\n\n*指尖在桌沿轻轻敲了两下*——说吧，这次是什么事。',
      reasoning: '维持角色的克制与旧情愫的张力；不主动推进剧情，把话语权交回用户。',
      thinkMs: 1800,
      createdAt: now - 5 * min,
      interrupted: false,
    },
    {
      id: 4,
      sessionId: 1,
      characterId: 2,
      role: 'assistant',
      content: '其实我今晚本来想……',
      reasoning: null,
      thinkMs: null,
      createdAt: now - 3 * min,
      interrupted: true,
    },
  ],
  2: [
    {
      id: 5,
      sessionId: 2,
      characterId: 4,
      role: 'assistant',
      content: '店里的旧钟停在四点二十，你来的时候，灰尘刚好落定。',
      reasoning: null,
      thinkMs: null,
      createdAt: now - 30 * min,
      interrupted: false,
    },
  ],
  3: [
    {
      id: 6,
      sessionId: 3,
      characterId: 6,
      role: 'assistant',
      content: '巷子口的灯坏了三天，没人修。案卷上不会记这个，但死者会。',
      reasoning: '侦探角色的冷开场：用环境细节暗示案情，语气克制。',
      thinkMs: 3200,
      createdAt: now - 2 * 24 * 60 * min,
      interrupted: false,
    },
  ],
};
