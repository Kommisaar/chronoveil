/**
 * 内置四预设历法常量（FR-014）：
 * 单一事实源——下沉理由：预设原先是 app 层 NewSessionDialog 的模块内
 * 常量，feature 依赖 app 被 ADR-010 单向依赖守卫（no-app-from-lower）禁止，
 * 按「跨域复用下沉 components」的既有出路移到本层。历史消费方：开局向导
 * 与角色卡历法编辑（后者已随 0012 裁撤）；现行唯一生产消费方为
 * features/worlds 的 WorldEditorDialog——0017 历法收编进世界卡，向导历法段
 * 随之裁撤。
 *
 * 与 Rust `domain/fiction_time::presets` 一一对应；前端只构造 wire DTO
 * （camelCase），落库存储 JSON 由 Rust 序列化 domain 结构得 snake_case，
 * 消费方永不手写存储 JSON。festivals 键 = 年内第几天（1 起），四预设统一
 * 12 月 × 30 日 = 360 日一年。
 */
import type { CalendarConfigDto } from '../api/types';

/** 四内置预设的稳定 id（wire 无关，仅前端选择态用）。 */
export type CalendarPresetId = 'modern' | 'seven' | 'ganzhi' | 'fantasy';

/** 四内置预设的 wire DTO（原样自开局向导常量平移，未改一字段）。 */
export const CALENDAR_PRESETS: Record<CalendarPresetId, CalendarConfigDto> = {
  modern: {
    name: '现代公历',
    months: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
    daysPerMonth: 30,
    dayNames: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    festivals: { 1: '元旦', 271: '国庆节' },
  },
  seven: {
    name: '七曜和历',
    months: ['睦月', '如月', '弥生', '卯月', '皋月', '水无月', '文月', '叶月', '长月', '神无月', '霜月', '师走'],
    daysPerMonth: 30,
    dayNames: ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日', '日曜日'],
    festivals: { 315: '七五三', 360: '大晦日' },
  },
  ganzhi: {
    name: '干支历',
    months: ['正月', '杏月', '桃月', '槐月', '榴月', '荷月', '巧月', '桂月', '菊月', '阳月', '葭月', '腊月'],
    daysPerMonth: 30,
    dayNames: ['子日', '丑日', '寅日', '卯日', '辰日', '巳日', '午日', '未日', '申日', '酉日', '戌日', '亥日'],
    festivals: { 15: '上元', 360: '除夕' },
  },
  fantasy: {
    name: '旧都历',
    months: ['霜月', '白蜡月', '融雪月', '雨月', '长夏月', '蝉鸣月', '风起月', '收获月', '雾月', '炉火月', '冻雨月', '岁末月'],
    daysPerMonth: 30,
    dayNames: ['晨露日', '萤火日', '潮汐日', '风息日', '炉边日', '集日', '安息日'],
    festivals: { 45: '灯节', 360: '守夜' },
  },
};

/** 预设展示序与显示名 i18n key（世界编辑器 worlds.* 域，历法名单一事实源）。 */
export const CALENDAR_PRESET_OPTIONS: ReadonlyArray<{
  id: CalendarPresetId;
  labelKey: string;
}> = [
  { id: 'modern', labelKey: 'worlds.presetModern' },
  { id: 'seven', labelKey: 'worlds.presetSeven' },
  { id: 'ganzhi', labelKey: 'worlds.presetGanzhi' },
  { id: 'fantasy', labelKey: 'worlds.presetFantasy' },
];
