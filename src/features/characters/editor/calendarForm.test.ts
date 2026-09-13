// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// calendarForm 纯逻辑单测：存储 JSON 解析（snake_case / 坏 JSON 降级 /
// festivals 数字字符串键）、表单字段序列化（节日按天升序、行归一）、
// buildCalendar 客户端校验（对齐 Rust fiction_time::validate：天数 ≥1 且
// 月名/日名至少其一非空；节日行「N=名称」N≥1，且不超年长——对齐
// services/calendar_draft::coerce_festivals 的越年防御）。文案断言不在此层。
// 另含一条 mock 落库往返用例（features → api 合法方向）：以真实消费方
// parseCalendarJson 守 api/mock 落库键形，防 camelCase 直落回归。
import { describe, expect, it } from 'vitest';
import type { CalendarConfigDto } from '../../../api/types';
import {
  buildCalendar,
  EMPTY_CALENDAR_FIELDS,
  fieldsFromCalendar,
  parseCalendarJson,
} from './calendarForm';

/** 旧都历（与 mock/data.ts 示例同构的 snake_case 存储形态；2 月 × 30 天，节日界内）。 */
const FANTASY_JSON =
  '{"name":"旧都历","months":["霜月","白蜡月"],"days_per_month":30,"day_names":["晨露日","萤火日"],"festivals":{"45":"灯节","60":"守夜"}}';

const FANTASY: CalendarConfigDto = {
  name: '旧都历',
  months: ['霜月', '白蜡月'],
  daysPerMonth: 30,
  dayNames: ['晨露日', '萤火日'],
  festivals: { 45: '灯节', 60: '守夜' },
};

describe('parseCalendarJson（存储 JSON → wire DTO）', () => {
  it('null 与坏 JSON / 非对象 JSON 均降级 null（未配置语义）', () => {
    expect(parseCalendarJson(null)).toBeNull();
    expect(parseCalendarJson('not json')).toBeNull();
    expect(parseCalendarJson('[1,2]')).toBeNull();
    expect(parseCalendarJson('"str"')).toBeNull();
  });

  it('snake_case 键解析：months/day_names/festivals（数字字符串键→数字）', () => {
    const config = parseCalendarJson(FANTASY_JSON);
    expect(config).toEqual(FANTASY);
  });

  it('缺字段回落缺省形态（name null / daysPerMonth 0 / festivals null）', () => {
    expect(parseCalendarJson('{"name":"无名"}')).toEqual({
      name: '无名',
      months: [],
      daysPerMonth: 0,
      dayNames: [],
      festivals: null,
    });
    expect(parseCalendarJson('{}')).toEqual({
      name: null,
      months: [],
      daysPerMonth: 0,
      dayNames: [],
      festivals: null,
    });
  });

  it('festivals 非法条目跳过（非数字键 / 0 / 非字符串值），全非法归 null', () => {
    const config = parseCalendarJson(
      '{"days_per_month":30,"months":["月"],"festivals":{"x":"错","0":"零日","45":"灯节"}}',
    );
    expect(config?.festivals).toEqual({ 45: '灯节' });
    const empty = parseCalendarJson('{"days_per_month":30,"months":["月"],"festivals":{"x":"错"}}');
    expect(empty?.festivals).toBeNull();
  });

  it('类型不符的字段集合整体降级：months 非数组 → 空表（展示回落，保存即修复）', () => {
    const config = parseCalendarJson('{"months":"霜月","days_per_month":"30"}');
    expect(config?.months).toEqual([]);
    expect(config?.daysPerMonth).toBe(0);
  });
});

describe('fieldsFromCalendar（wire DTO → 表单字段）', () => {
  it('null → 全空字段', () => {
    expect(fieldsFromCalendar(null)).toEqual(EMPTY_CALENDAR_FIELDS);
  });

  it('月名日名每行一项、节日按第 N 天升序成「N=名称」行', () => {
    const fields = fieldsFromCalendar({
      ...FANTASY,
      festivals: { 360: '守夜', 45: '灯节' },
    });
    expect(fields).toEqual({
      name: '旧都历',
      daysPerMonth: '30',
      months: '霜月\n白蜡月',
      dayNames: '晨露日\n萤火日',
      festivals: '45=灯节\n360=守夜',
    });
  });

  it('无名历法（name null）与无节日（null）→ 对应字段空', () => {
    const fields = fieldsFromCalendar({
      name: null,
      months: ['月'],
      daysPerMonth: 10,
      dayNames: [],
      festivals: null,
    });
    expect(fields.name).toBe('');
    expect(fields.festivals).toBe('');
  });
});

describe('buildCalendar（表单字段 → 校验判定，对齐 fiction_time::validate）', () => {
  it('全空 = 未配置（empty），任意字段非空才进入校验', () => {
    expect(buildCalendar(EMPTY_CALENDAR_FIELDS)).toEqual({ kind: 'empty' });
  });

  it('每月天数：空 / 0 / 负 / 小数 / 非数字均拦为 daysPerMonth 错误', () => {
    for (const days of ['', '0', '-3', '30.5', 'abc', '  ']) {
      const build = buildCalendar({ ...EMPTY_CALENDAR_FIELDS, daysPerMonth: days, months: '一月' });
      expect(build).toEqual({ kind: 'invalid', error: 'daysPerMonth' });
    }
  });

  it('每月天数上界含端点：999 放行、1000 拦为 daysPerMonthMax（对齐 coerce_days_per_month）', () => {
    // 界值 999 合法通过（Rust 侧 `(1..=999).contains` 含端点）。
    const atMax = buildCalendar({ ...EMPTY_CALENDAR_FIELDS, daysPerMonth: '999', months: '一月' });
    expect(atMax).toEqual({
      kind: 'valid',
      config: {
        name: null,
        months: ['一月'],
        daysPerMonth: 999,
        dayNames: [],
        festivals: null,
      },
    });
    // 超上界独立定位为 daysPerMonthMax（文案说明合理范围 1–999）。
    expect(
      buildCalendar({ ...EMPTY_CALENDAR_FIELDS, daysPerMonth: '1000', months: '一月' }),
    ).toEqual({ kind: 'invalid', error: 'daysPerMonthMax' });
    // 明显越界同样拦截，防「10000 天/月」这类失真输入。
    expect(
      buildCalendar({ ...EMPTY_CALENDAR_FIELDS, daysPerMonth: '10000', months: '一月' }),
    ).toEqual({ kind: 'invalid', error: 'daysPerMonthMax' });
  });

  it('月名 / 日名至少其一非空（对齐 Rust validate），皆空拦为 names 错误', () => {
    expect(
      buildCalendar({ ...EMPTY_CALENDAR_FIELDS, daysPerMonth: '30' }),
    ).toEqual({ kind: 'invalid', error: 'names' });
    const onlyDayNames = buildCalendar({
      ...EMPTY_CALENDAR_FIELDS,
      daysPerMonth: '30',
      dayNames: '晨露日',
    });
    expect(onlyDayNames.kind).toBe('valid');
  });

  it('节日行：非法形态 / N=0 / 空名称均拦为 festivals 错误', () => {
    for (const festivals of ['灯节', '45', '0=元旦', '-1=元旦', '45= ', '45=']) {
      const build = buildCalendar({
        ...EMPTY_CALENDAR_FIELDS,
        daysPerMonth: '30',
        months: '一月',
        festivals,
      });
      expect(build).toEqual({ kind: 'invalid', error: 'festivals' });
    }
  });

  it('越年节日：N 超出年长（月数 × 每月天数）拦为 festivals，恰好等于年长合法', () => {
    // 2 月 × 30 天 = 年长 60：第 60 天在界内，第 61 天落不进任何月份（越年）。
    const inBounds = buildCalendar({
      ...EMPTY_CALENDAR_FIELDS,
      daysPerMonth: '30',
      months: '霜月\n白蜡月',
      festivals: '60=守夜',
    });
    expect(inBounds.kind).toBe('valid');
    const outOfBounds = buildCalendar({
      ...EMPTY_CALENDAR_FIELDS,
      daysPerMonth: '30',
      months: '霜月\n白蜡月',
      festivals: '61=守夜',
    });
    expect(outOfBounds).toEqual({ kind: 'invalid', error: 'festivals' });
    // 边界再核对：月数变化收紧年长时同样生效（1 月 × 30 天，45 越年）。
    const tighter = buildCalendar({
      ...EMPTY_CALENDAR_FIELDS,
      daysPerMonth: '30',
      months: '霜月',
      festivals: '45=灯节',
    });
    expect(tighter).toEqual({ kind: 'invalid', error: 'festivals' });
  });

  it('months 为空（只配日名）时不设年长上界，只查 N ≥ 1（对齐 coerce_festivals）', () => {
    const build = buildCalendar({
      ...EMPTY_CALENDAR_FIELDS,
      daysPerMonth: '30',
      dayNames: '晨露日',
      festivals: '360=守夜',
    });
    expect(build.kind === 'valid' && build.config.festivals).toEqual({ 360: '守夜' });
  });

  it('有效配置：name trim、空行丢弃、节日「45=灯节」解析、无节日序列化为 null', () => {
    const build = buildCalendar({
      name: '  旧都历 ',
      daysPerMonth: '30',
      months: '霜月\n\n   \n白蜡月',
      dayNames: '',
      festivals: '45=灯节\n60=守夜',
    });
    expect(build).toEqual({
      kind: 'valid',
      config: {
        name: '旧都历',
        months: ['霜月', '白蜡月'],
        daysPerMonth: 30,
        dayNames: [],
        festivals: { 45: '灯节', 60: '守夜' },
      },
    });
    const noFestivals = buildCalendar({
      ...EMPTY_CALENDAR_FIELDS,
      daysPerMonth: '30',
      months: '一月',
      festivals: '\n',
    });
    expect(noFestivals.kind === 'valid' && noFestivals.config.festivals).toBeNull();
  });

  it('只填历法名（其余全空）也进入校验并拦为 daysPerMonth（配全才有效）', () => {
    expect(buildCalendar({ ...EMPTY_CALENDAR_FIELDS, name: '无名历' })).toEqual({
      kind: 'invalid',
      error: 'daysPerMonth',
    });
  });

  it('等号两侧空白容忍；同一天重复行后者覆盖', () => {
    const build = buildCalendar({
      ...EMPTY_CALENDAR_FIELDS,
      daysPerMonth: '30',
      months: '一月\n二月',
      festivals: '45 = 灯节\n45=双灯节',
    });
    expect(build.kind === 'valid' && build.config.festivals).toEqual({ 45: '双灯节' });
  });
});

describe('往返（存储 JSON ↔ 表单字段 ↔ 校验产物）', () => {
  it('parse → fields → build 与原 wire DTO 深度一致', () => {
    const fields = fieldsFromCalendar(parseCalendarJson(FANTASY_JSON));
    const build = buildCalendar(fields);
    expect(build.kind === 'valid' && build.config).toEqual(FANTASY);
  });
});

describe('mock 落库往返（防键形回归：api/mock 落库形态 × parseCalendarJson 消费键）', () => {
  it('updateCharacter 保存历法后，parseCalendarJson 读回月天数 / 日名 / 节日完整', async () => {
    // api 层禁引 features（depcruise api-no-upper），故在此以 features → api 的
    // 合法方向引 mock backend：编辑器「保存 → 重开」链路里 parseCalendarJson 是
    // 存储字符串的唯一解消费者，camelCase 直落会在此降级（daysPerMonth → 0）。
    const { createCharacter, listCharacters, updateCharacter } = await import(
      '../../../api/mock/backend'
    );
    const created = await createCharacter({
      name: '历法往返员',
      avatar: null,
      persona: '验证 mock 落库键形的临时卡',
      gender: null,
      age: null,
      renderStyle: 'type',
      modelConfig: null,
      accentColor: null,
      voiceConfig: null,
    });
    await updateCharacter(created.id, {
      name: created.name,
      avatar: null,
      persona: created.persona,
      gender: null,
      age: null,
      renderStyle: 'type',
      modelConfig: null,
      accentColor: null,
      voiceConfig: null,
      calendarConfig: {
        name: '星槎历',
        months: ['潮生月', '风信月'],
        daysPerMonth: 12,
        dayNames: ['潮日', '汐日', '星日'],
        festivals: { 2: '归潮祭' },
      },
    });
    const stored = (await listCharacters()).find((c) => c.id === created.id);
    expect(parseCalendarJson(stored?.calendarConfig ?? null)).toEqual({
      name: '星槎历',
      months: ['潮生月', '风信月'],
      daysPerMonth: 12,
      dayNames: ['潮日', '汐日', '星日'],
      festivals: { 2: '归潮祭' },
    });
  });
});
