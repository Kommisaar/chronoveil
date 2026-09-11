/**
 * 角色编辑器表单逻辑（2026-09-09 编辑器重做时自旧对话框抽出）：状态、脏比对、
 * model_config 覆写序列化、预览演出引擎接线与强调色派生，供排版壳
 * （CharacterEditorDialog，左海报 + 右面板）单点复用。
 *
 * - 新建 / 编辑共用：character = null 即新建。父组件以 key 重挂换绑初值；
 *   脏状态经 onDirtyChange 上报父级做切换守卫；
 * - avatar 不做编辑 UI：新建恒 null、编辑原样带回（TASK-008 验收 2）；
 *   voiceConfig 恒 null（CON-003 TTS 留缝不留壳）；
 * - model_config 覆写序列化为 camelCase 键 JSON（Rust resolve_effective_llm 消费），
 *   全空序列化为 null，未知键原样往返保留；
 * - 历法（FR-014 二期）字段/折叠/编辑态与实时校验在本 hook 持有（进脏比对），
 *   解析与校验逻辑在 editor/calendarForm；整卡输入按 wire DTO 契约携带
 *   calendarConfig（持久化接线随 Rust/DTO 任务点亮，见 buildInput 内注释）；
 * - 「预览演出」经引擎公开 API 播一次所选风格（createRenderer +
 *   setStyle / beginTurn / enqueue / finish），样例文本取 i18n 预览样例。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalendarConfigDto, CharacterInput, CharacterSummary } from '../../../api/types';
import { ANIM_STYLES, createRenderer, type AnimStyleId, type Renderer } from '../../../engine';
import {
  accentColorOf,
  dotGradientOf,
  posterGradientOf,
} from '../posterGradient';
import {
  buildCalendar,
  fieldsFromCalendar,
  parseCalendarJson,
  type CalendarBuild,
  type CalendarFields,
} from './calendarForm';

/** model_config JSON 的表单形态（空串 = 该字段跟随全局）。 */
export interface ModelOverrideFields {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 未知键原样保留（Rust 忽略未知键，编辑往返不清除）。 */
  rest: Record<string, unknown>;
}

const OVERRIDE_KEYS = ['providerId', 'model', 'baseUrl', 'apiKey'] as const;

function parseModelOverride(raw: string | null): ModelOverrideFields {
  const empty: ModelOverrideFields = {
    providerId: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    rest: {},
  };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return empty;
    }
    const obj = { ...(parsed as Record<string, unknown>) };
    const fields = { ...empty, rest: obj };
    for (const key of OVERRIDE_KEYS) {
      const value = obj[key];
      delete fields.rest[key];
      if (typeof value === 'string') fields[key] = value;
    }
    return fields;
  } catch {
    // 非法 JSON（Rust 生成时会快速失败）：编辑侧按空覆写展示，保存即修复。
    return empty;
  }
}

function serializeModelOverride(fields: ModelOverrideFields): string | null {
  const obj: Record<string, unknown> = { ...fields.rest };
  const providerId = fields.providerId.trim();
  const model = fields.model.trim();
  const baseUrl = fields.baseUrl.trim();
  const apiKey = fields.apiKey.trim();
  if (providerId) obj.providerId = providerId;
  if (model) obj.model = model;
  if (baseUrl) obj.baseUrl = baseUrl;
  if (apiKey) obj.apiKey = apiKey;
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : null;
}

/** 脏比对签名：字段拼接（rest 与历法各原始字段以文本参与，键序/行序在同源
 *  对象间稳定——历法字段经 fieldsFromCalendar 归一，未编辑时往返一致）。 */
function formSignature(parts: {
  name: string;
  gender: string;
  age: string;
  persona: string;
  renderStyle: string;
  accentColor: string | null;
  override: ModelOverrideFields;
  calendar: CalendarFields;
}): string {
  return [
    parts.name,
    parts.gender,
    parts.age,
    parts.persona,
    parts.renderStyle,
    parts.accentColor ?? '',
    parts.override.providerId,
    parts.override.model,
    parts.override.baseUrl,
    parts.override.apiKey,
    JSON.stringify(parts.override.rest),
    parts.calendar.name,
    parts.calendar.daysPerMonth,
    parts.calendar.months,
    parts.calendar.dayNames,
    parts.calendar.festivals,
  ].join('\u0000');
}

export interface EditorForm {
  name: string;
  setName: (value: string) => void;
  gender: string;
  setGender: (value: string) => void;
  age: string;
  setAge: (value: string) => void;
  persona: string;
  setPersona: (value: string) => void;
  renderStyle: string;
  setRenderStyle: (value: string) => void;
  accentColor: string | null;
  setAccentColor: (value: string | null) => void;
  override: ModelOverrideFields;
  setOverride: (
    update: (current: ModelOverrideFields) => ModelOverrideFields,
  ) => void;
  overrideOpen: boolean;
  setOverrideOpen: (update: (open: boolean) => boolean) => void;
  /** 历法编辑（FR-014 二期）：字段为 textarea 原文，build 为实时校验结果。 */
  calendarFields: CalendarFields;
  setCalendarFields: (
    update: (current: CalendarFields) => CalendarFields,
  ) => void;
  calendarOpen: boolean;
  setCalendarOpen: (update: (open: boolean) => boolean) => void;
  calendarEditing: boolean;
  setCalendarEditing: (update: (editing: boolean) => boolean) => void;
  calendarBuild: CalendarBuild;
  /** AI 草稿 / 预设应用：填入编辑态（不自动保存），展开并进入编辑。 */
  applyCalendar: (config: CalendarConfigDto) => void;
  canSave: boolean;
  /**
   * 整卡输入。历法按契约以 wire DTO 携带：以「CharacterInput + 可选
   * calendarConfig」的交叉类型表达前端契约，由 src/api/commands 归一层并进
   * UpdateCharacterInput（Rust interfaces/ipc.rs，缺键归一为 null = 清除历法，
   * 随整卡 update_character 落库）——字段不进 CharacterInput，此交叉类型即
   * 最终形态，无需后续收敛。
   */
  buildInput: () => CharacterInput & { calendarConfig: CalendarConfigDto | null };
  /** 预览演出渲染容器（引擎惰性创建，卸载即 cancel）。 */
  previewRef: (node: HTMLDivElement | null) => void;
  previewed: boolean;
  playPreview: () => void;
  /** 外壳渲染主题横幅 / 海报用的派生值（全部随输入实时更新）。 */
  live: {
    nameText: string;
    posterGradient: string;
    /** 基础色（未经修饰）：显式强调色，或跟随海报时按 id 派生的亮端纯色 */
    baseColor: string;
    dotGradient: string;
    styleLabel: string;
  };
}

export function useEditorForm(props: {
  character: CharacterSummary | null;
  onDirtyChange: (dirty: boolean) => void;
}): EditorForm {
  const { character, onDirtyChange } = props;
  const { t } = useTranslation();

  // 目标角色由父组件 key 重挂保证不变，初值只取一次。
  const initial = useMemo(() => {
    const override = parseModelOverride(character?.modelConfig ?? null);
    // 存储日历 JSON → 表单字段（坏 JSON 降级为未配置，保存即修复）。
    const calendar = fieldsFromCalendar(
      parseCalendarJson(character?.calendarConfig ?? null),
    );
    return {
      name: character?.name ?? '',
      gender: character?.gender ?? '',
      age: character?.age ?? '',
      persona: character?.persona ?? '',
      // 新建默认 render_style 与 Rust NewCharacter::default 一致（'type' 打字机，
      // 迁移 0006 起存量遗留串已在库侧订正）。
      renderStyle: character?.renderStyle ?? 'type',
      // null = 跟随海报派生（accent_color 列语义，迁移 0003）。
      accentColor: character?.accentColor ?? null,
      override,
      calendar,
      signature: formSignature({
        name: character?.name ?? '',
        gender: character?.gender ?? '',
        age: character?.age ?? '',
        persona: character?.persona ?? '',
        renderStyle: character?.renderStyle ?? 'type',
        accentColor: character?.accentColor ?? null,
        override,
        calendar,
      }),
    };
  }, [character]);

  const [name, setName] = useState(initial.name);
  const [gender, setGender] = useState(initial.gender);
  const [age, setAge] = useState(initial.age);
  const [persona, setPersona] = useState(initial.persona);
  const [renderStyle, setRenderStyle] = useState(initial.renderStyle);
  const [accentColor, setAccentColor] = useState<string | null>(initial.accentColor);
  const [override, setOverrideState] = useState<ModelOverrideFields>(initial.override);
  // 模型覆写折叠态：已有覆写值（含未知键）的角色自动展开，否则默认收起。
  const [overrideOpen, setOverrideOpenState] = useState(() => {
    const o = initial.override;
    return (
      o.providerId !== '' ||
      o.model !== '' ||
      o.baseUrl !== '' ||
      o.apiKey !== '' ||
      Object.keys(o.rest).length > 0
    );
  });
  // 历法折叠态：已配置历法的角色自动展开；编辑态（表单形态）默认关。
  const [calendarFields, setCalendarFieldsState] = useState<CalendarFields>(
    initial.calendar,
  );
  const [calendarOpen, setCalendarOpenState] = useState(
    () =>
      initial.calendar.name !== '' ||
      initial.calendar.daysPerMonth !== '' ||
      initial.calendar.months !== '' ||
      initial.calendar.dayNames !== '' ||
      initial.calendar.festivals !== '',
  );
  const [calendarEditing, setCalendarEditingState] = useState(false);
  // 是否已播过预览：控制空态提示显隐（重挂/切角色由父组件 key 重置）。
  const [previewed, setPreviewed] = useState(false);

  const dirty =
    formSignature({
      name,
      gender,
      age,
      persona,
      renderStyle,
      accentColor,
      override,
      calendar: calendarFields,
    }) !== initial.signature;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // 历法实时校验（对齐 Rust fiction_time::validate）：失败时拦截保存。
  const calendarBuild = useMemo(() => buildCalendar(calendarFields), [calendarFields]);

  // 「预览演出」：引擎实例按容器惰性创建，卸载即停一切计时（cancel）。
  const previewNodeRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  useEffect(
    () => () => {
      rendererRef.current?.cancel();
      rendererRef.current = null;
    },
    [],
  );

  const canSave = name.trim().length > 0 && calendarBuild.kind !== 'invalid';

  /** AI 草稿 / 预设一键填入：展开区块并进编辑态，用户看得见填了什么。 */
  const applyCalendar = (config: CalendarConfigDto): void => {
    setCalendarFieldsState(fieldsFromCalendar(config));
    setCalendarOpenState(true);
    setCalendarEditingState(true);
  };

  const playPreview = (): void => {
    const container = previewNodeRef.current;
    if (!container) return;
    rendererRef.current ??= createRenderer(container);
    // 遗留数据可能带 18 表之外的风格串：先自校验回落 fade（引擎 setStyle 不校验）。
    const found = ANIM_STYLES.find((s) => s.id === renderStyle);
    const style: AnimStyleId = found ? found.id : 'fade';
    rendererRef.current.setStyle(style);
    rendererRef.current.beginTurn();
    rendererRef.current.enqueue(t('characters.previewSample'));
    rendererRef.current.finish();
    setPreviewed(true);
  };

  const live = useMemo(() => {
    const id = character?.id ?? 0;
    const accentInput = { id, accentColor };
    const selectedStyle = ANIM_STYLES.find((s) => s.id === renderStyle);
    return {
      nameText: name.trim() || t('characters.new'),
      // 强调色即角色主色：设了整卡覆盖（与海报墙同规则），未设按 id 取模。
      posterGradient: posterGradientOf(accentInput),
      // 基础色（未经修饰）：海报的暗变是 scrim 叠层，不参与颜色元数据——
      // 取色器色块显示的是它（显式强调色，或跟随海报时按 id 派生的亮端）。
      baseColor: accentColorOf(accentInput),
      dotGradient: dotGradientOf(accentInput),
      styleLabel: selectedStyle ? selectedStyle.label : renderStyle,
    };
  }, [character, accentColor, renderStyle, name, t]);

  return {
    name,
    setName,
    gender,
    setGender,
    age,
    setAge,
  persona,
  setPersona,
  renderStyle,
  setRenderStyle,
    accentColor,
    setAccentColor,
    override,
    setOverride: (update) => setOverrideState(update),
    overrideOpen,
    setOverrideOpen: (update) => setOverrideOpenState(update),
    calendarFields,
    setCalendarFields: (update) => setCalendarFieldsState(update),
    calendarOpen,
    setCalendarOpen: (update) => setCalendarOpenState(update),
    calendarEditing,
    setCalendarEditing: (update) => setCalendarEditingState(update),
    calendarBuild,
    applyCalendar,
    canSave,
    previewRef: (node) => {
      previewNodeRef.current = node;
    },
    previewed,
    playPreview,
    buildInput: () => ({
      name: name.trim(),
      // avatar 不做编辑 UI：新建 null、编辑原样带回现值。
      avatar: character?.avatar ?? null,
      persona,
      // 空串归一为 null（列语义：NULL = 未设置）。
      gender: gender.trim() || null,
      age: age.trim() || null,
      renderStyle,
      accentColor,
      modelConfig: serializeModelOverride(override),
      // TTS 预留缝恒 null（CON-003）。
      voiceConfig: null,
      // 历法随整卡提交（FR-014 二期）：wire DTO 形态与 SessionOpeningInput.calendar
      // 同构，未配置/校验失败归 null。CharacterInput 此刻尚无该字段（Rust/DTO
      // 接线任务未落地，serde 会忽略未知键），结构化多余属性先行按契约携带，
      // 接线落地后即点亮持久化，无需再改本文件。
      calendarConfig: calendarBuild.kind === 'valid' ? calendarBuild.config : null,
    }),
    live,
  };
}
