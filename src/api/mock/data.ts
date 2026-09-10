import type { CharacterSummary, ChatMessage } from '../types';

/** mock 数据：纯浏览器开发用（ADR-010）；结构与 SQLite 三表对应（data_model）。 */

const now = Date.now();
const min = 60_000;

export const characters: CharacterSummary[] = [
  {
    id: 1,
    name: '苏鸢',
    avatar: null,
    gender: '女',
    age: '24',

    persona: '雨夜电话亭的守夜人，说话克制，旧情藏在对白缝隙里。',
    renderStyle: 'type',
    modelConfig: null,
    accentColor: null,
    // 示例角色卡日历（FR-014）：键与 Rust 序列化 CalendarConfig 一致为 snake_case，
    // 供开局向导「跟随角色卡」项显示历法名（dev 演示；Rust 侧 JSON 由存储层产出）。
    calendarConfig:
      '{"name":"旧都历","months":["霜月","白蜡月","融雪月","雨月","长夏月","蝉鸣月","风起月","收获月","雾月","炉火月","冻雨月","岁末月"],"days_per_month":30,"day_names":["晨露日","萤火日","潮汐日","风息日","炉边日","集日","安息日"],"festivals":{"45":"灯节","360":"守夜"}}',
    updatedAt: now - 3 * min,
    sessionCount: 2,
  },
  {
    id: 2,
    name: '林深',
    avatar: null,
    gender: '男',
    age: '31',
    
    persona: '旧书店老板，业余侦探；观察力锋利，语气温和。',
    renderStyle: 'ink',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
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
    
    persona: '末班航船上的灯塔守护者，用灯光的明灭节奏和水手们约定暗号。',
    renderStyle: 'rise',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 3 * 24 * 60 * min,
    sessionCount: 3,
  },
  {
    id: 4,
    name: '阿澈',
    avatar: null,
    gender: '男',
    age: '47',
    
    persona: '巷口修表匠，话少，手稳。',
    renderStyle: 'caret',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 5 * 24 * 60 * min,
    sessionCount: 0,
  },
  {
    id: 5,
    name: 'Sir Reginald Ashworth',
    avatar: null,
    gender: '男',
    age: '62',
    
    persona: 'A retired royal cartographer who keeps drawing maps of places that do not exist yet.',
    renderStyle: 'flip',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 8 * 24 * 60 * min,
    sessionCount: 1,
  },
  {
    id: 6,
    name: '星轨观测站的算术巫师',
    avatar: null,
    gender: '女',
    age: '26',
    
    persona: '住在山顶废弃天文台，把星图当账本记，相信每颗流星都是一笔待结算的债务。',
    renderStyle: 'decode',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 13 * 24 * 60 * min,
    sessionCount: 7,
  },
  {
    id: 7,
    name: '白鸦',
    avatar: null,
    gender: '女',
    age: '27',
    
    persona: '城市传说收集者，只录不评，磁带机从不离身。',
    renderStyle: 'neon',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 21 * 24 * 60 * min,
    sessionCount: 2,
  },
  {
    id: 8,
    name: 'Constellationwhisperer',
    avatar: null,
    gender: null,
    age: null,
    
    persona: 'A wandering stargazer whose unbroken single-word name is here on purpose to test word wrapping on narrow cards.',
    renderStyle: 'blur',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 30 * 24 * 60 * min,
    sessionCount: 0,
  },
  {
    id: 9,
    name: '老周',
    avatar: null,
    gender: '男',
    age: '52',
    
    persona: '夜班出租车司机，后视镜里看遍这座城市。',
    renderStyle: 'type',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 45 * 24 * 60 * min,
    sessionCount: 12,
  },
  {
    id: 10,
    name: '缄默之塔的第十三位图书管理员',
    avatar: null,
    gender: '女',
    age: null,
    
    persona: '管理一座不许说话的塔，用字条和访客交流；塔里第十三层没有书，只有回声。',
    renderStyle: 'dust',
    modelConfig: null,
    accentColor: null,
    calendarConfig: null,
    updatedAt: now - 60 * 24 * 60 * min,
    sessionCount: 1,
  },
];

export const sessions = [
  { id: 1, characterId: 1, title: '雨夜来电', updatedAt: now - 3 * min },
  { id: 2, characterId: 1, title: '旧书店的约定', updatedAt: now - 26 * min },
  { id: 3, characterId: 2, title: '深巷追凶', updatedAt: now - 2 * 24 * 60 * min },
];

export const messagesBySession: Record<number, ChatMessage[]> = {
  1: [
    {
      id: 1,
      sessionId: 1,
      characterId: 1,
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
      characterId: 1,
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
      characterId: 1,
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
      characterId: 1,
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
      characterId: 2,
      role: 'assistant',
      content: '巷子口的灯坏了三天，没人修。案卷上不会记这个，但死者会。',
      reasoning: '侦探角色的冷开场：用环境细节暗示案情，语气克制。',
      thinkMs: 3200,
      createdAt: now - 2 * 24 * 60 * min,
      interrupted: false,
    },
  ],
};
