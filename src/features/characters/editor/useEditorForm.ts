/**
 * 角色编辑器表单逻辑（2026-09-09 编辑器重做时自旧对话框抽出）：状态、修改即
 * 保存（自动保存）、model_config 覆写序列化、预览动画引擎接线与强调色派生，
 * 供排版壳（CharacterEditorDialog，左海报 + 右面板）单点复用。
 *
 * - 只服务编辑既有卡（新建由父级「先建卡再进编辑器」）：父组件以 key 重挂
 *   换绑初值；character 是打开时的快照，保存后父级 refresh 不回灌表单
 *   （避免覆盖输入中的值）；
 * - 修改即保存（2026-09-13 用户定稿，取消/保存按钮移除）：任一字段改动经
 *   600ms 防抖后串行上送（上一拍完成才发下一拍，防乱序覆盖）；载荷与上次
 *   已保存值相同则跳过；名称为空（canSave=false）暂不发送，恢复有效名后
 *   随下一拍落库（清空期间在途的旧有效载荷照发，避免丢用户输入）；关闭前
 *   由排版壳调 flushSave 补存最后一拍；「过期载荷不得落库」覆盖两个窗口：
 *   防抖窗口由还原取消防抖拍保证，串行链在途窗口由落库后的纠正拍补齐
 *   （scheduleCorrectiveBeat——在途期间改回原值/改新的差异不会停在旧拍）；
 * - avatar 不做编辑 UI：编辑原样带回（TASK-008 验收 2）；voiceConfig 恒
 *   null（CON-003 TTS 留缝不留壳）；
 * - model_config 覆写序列化为 camelCase 键 JSON（Rust resolve_effective_llm 消费），
 *   全空序列化为 null，未知键原样往返保留；
 * - 历法不属角色卡（2026-09-13 产品裁剪）：会话历法在开局向导按会话配置，
 *   编辑器表单不含历法字段；
 * - 「预览动画」经引擎公开 API 播一次所选风格（createRenderer +
 *   setStyle / beginTurn / enqueue / finish），样例文本取 i18n 预览样例。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterInput, CharacterSummary } from '../../../api/types';
import {
  ANIM_STYLES,
  createRenderer,
  DUR_DEFAULT_MS,
  RHYTHM_DEFAULT_MS,
  type AnimStyleId,
  type Renderer,
} from '../../../engine';
import {
  accentColorOf,
  dotGradientOf,
  posterGradientOf,
} from '../posterGradient';

/** 自动保存防抖（毫秒）：连续输入期间持续顺延，停手后一拍落库。 */
const AUTOSAVE_DEBOUNCE_MS = 600;

/** 演出参数的「跟随全局」基准（2026-09-13）：卡上留空时预览所用值。父级
 *  （CharactersView）从全局配置派生传入；缺省回落引擎/模板默认值。 */
export interface AnimDefaults {
  durationMs: number;
  msPerChar: number;
  punctPause: boolean;
}

/** 模板默认值（docs/streaming-animations.html 控件默认；引擎常量同源）。 */
const TEMPLATE_DEFAULTS: AnimDefaults = {
  durationMs: DUR_DEFAULT_MS,
  msPerChar: RHYTHM_DEFAULT_MS,
  punctPause: true,
};

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
  /** 演出参数覆写（2026-09-13）：null = 跟随全局。 */
  animDurationMs: number | null;
  setAnimDurationMs: (value: number | null) => void;
  animRhythmMs: number | null;
  setAnimRhythmMs: (value: number | null) => void;
  animPunctPause: boolean | null;
  setAnimPunctPause: (value: boolean | null) => void;
  accentColor: string | null;
  setAccentColor: (value: string | null) => void;
  override: ModelOverrideFields;
  setOverride: (
    update: (current: ModelOverrideFields) => ModelOverrideFields,
  ) => void;
  overrideOpen: boolean;
  setOverrideOpen: (update: (open: boolean) => boolean) => void;
  /** 名称必填门槛：为空时自动保存挂起（IdentityField 出必填提示）。 */
  canSave: boolean;
  /** 关闭前补存：取消在途防抖，把未落库的最后一拍立即上送。 */
  flushSave: () => void;
  /** 预览动画渲染容器（引擎惰性创建，卸载即 cancel）。 */
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
  character: CharacterSummary;
  /** 修改即保存的上送出口（父级落库 + refresh + 错误就地展示）。 */
  onAutosave: (input: CharacterInput) => Promise<void>;
  /** 演出参数「跟随全局」基准（全局配置派生）；缺省回落模板默认。 */
  animDefaults?: AnimDefaults | undefined;
}): EditorForm {
  const { character, onAutosave } = props;
  const animDefaults = props.animDefaults ?? TEMPLATE_DEFAULTS;
  const { t } = useTranslation();

  // 目标角色由父组件 key 重挂保证不变，初值只取一次。
  const initial = useMemo(() => {
    const override = parseModelOverride(character?.modelConfig ?? null);
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
      // 演出参数覆写（迁移 0013）：null = 跟随全局。
      animDurationMs: character?.animDurationMs ?? null,
      animRhythmMs: character?.animRhythmMs ?? null,
      animPunctPause: character?.animPunctPause ?? null,
      override,
    };
  }, [character]);

  const [name, setName] = useState(initial.name);
  const [gender, setGender] = useState(initial.gender);
  const [age, setAge] = useState(initial.age);
  const [persona, setPersona] = useState(initial.persona);
  const [renderStyle, setRenderStyle] = useState(initial.renderStyle);
  const [animDurationMs, setAnimDurationMs] = useState<number | null>(initial.animDurationMs);
  const [animRhythmMs, setAnimRhythmMs] = useState<number | null>(initial.animRhythmMs);
  const [animPunctPause, setAnimPunctPause] = useState<boolean | null>(initial.animPunctPause);
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
  // 是否已播过预览：控制空态提示显隐（重挂/切角色由父组件 key 重置）。
  const [previewed, setPreviewed] = useState(false);

  const canSave = name.trim().length > 0;

  // 当前表单 → 整卡负载（create / update 共用同一 wire 形态）。
  const buildInput = (): CharacterInput => ({
    name: name.trim(),
    // avatar 不做编辑 UI：编辑原样带回现值。
    avatar: character?.avatar ?? null,
    persona,
    // 空串归一为 null（列语义：NULL = 未设置）。
    gender: gender.trim() || null,
    age: age.trim() || null,
    renderStyle,
    accentColor,
    animDurationMs,
    animRhythmMs,
    animPunctPause,
    modelConfig: serializeModelOverride(override),
    // TTS 预留缝恒 null（CON-003）。
    voiceConfig: null,
  });

  // ---- 修改即保存（自动保存）----
  // 已保存基线：打开时快照的载荷（key 重挂即换绑）。
  const initialInputJson = useMemo(() => JSON.stringify(buildInput()), []);
  const lastSavedRef = useRef(initialInputJson);
  const timerRef = useRef<number | null>(null);
  // 卸载标记：纠正拍在卸载后改为直入串行链（scheduleCorrectiveBeat）。
  const mountedRef = useRef(true);
  // 串行链：上一拍上送完成才发下一拍（IPC 无序完成时防旧载荷覆盖新载荷）。
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // latest-ref 模式（渲染期赋值，幂等只读）：串行链与卸载补存执行时必须取
  // 最新闭包；卸载后 ref 冻结在原卡绑定的回调上——A 卡在途载荷不会误写 B 卡。
  const onAutosaveRef = useRef(onAutosave);
  const buildInputRef = useRef(buildInput);
  const canSaveRef = useRef(canSave);
  onAutosaveRef.current = onAutosave;
  buildInputRef.current = buildInput;
  canSaveRef.current = canSave;

  /** 纠正拍（在途窗口守护）：比对当前表单与已保存基线，不一致则补一拍。
   *  还原路径只能取消防抖拍（json 已等于旧基线），串行链在途窗口的差异
   *  由此补齐，保证「过期载荷不得落库」在还原+挂机 / 还原+关闭 / 还原+
   *  卸载三条路径全部成立。已卸载时不能等防抖（无渲染驱动、窗口随时可关），
   *  直入串行链补齐最终意图（ref 冻结在原卡，不误写他卡）。 */
  const scheduleCorrectiveBeat = (): void => {
    if (timerRef.current !== null) return; // 已有待发拍：自然携带最新表单值
    const input = buildInputRef.current();
    const json = JSON.stringify(input);
    if (json === lastSavedRef.current || !canSaveRef.current) return;
    if (!mountedRef.current) {
      persist(input, json);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const latest = buildInputRef.current();
      persist(latest, JSON.stringify(latest));
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  /** 上送一拍：入链串行执行；成功后推进已保存基线并按需排纠正拍。失败已
   *  在父级就地红字展示，链吞掉 rejection 不断链（下一拍改动自然重试——
   *  失败拍不排纠正拍，避免失败后无限自动重试）。 */
  const persist = (input: CharacterInput, json: string): void => {
    // 调用时 + 执行时双重比较：纠正拍与手动拍并发排布时可能排出载荷已被
    // 更晚一拍覆盖的重复上送，执行时比较兑现「与已保存值相同则跳过」。
    if (json === lastSavedRef.current) return;
    chainRef.current = chainRef.current
      .then(async () => {
        if (json === lastSavedRef.current) return;
        await onAutosaveRef.current(input);
        lastSavedRef.current = json;
        scheduleCorrectiveBeat();
      })
      .catch(() => undefined);
  };

  // 修改即保存：无依赖数组 = 每次渲染重新比对（刻意为之，注释见文件头——
  // 表单字段集即全部状态，穷举依赖与逐字段等价且更脆；此处置需要最新闭包）。
  useEffect(() => {
    const json = JSON.stringify(buildInputRef.current());
    if (json === lastSavedRef.current) {
      // 改回已保存值（防抖窗口内还原）：取消在途拍。若已有拍停在串行链
      // 在途，还原差异由落库后的纠正拍补齐（scheduleCorrectiveBeat）——
      // 「过期载荷不得落库」对两个窗口都成立。
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (!canSaveRef.current) return; // 名称必填：无效态挂起，恢复后随下一拍落库
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const input = buildInputRef.current();
      persist(input, JSON.stringify(input));
    }, AUTOSAVE_DEBOUNCE_MS);
  });

  // 卸载补存（切换目标卡 / 关闭退场卸载）：在途防抖立即上送，避免丢最后一拍。
  useEffect(
    () => {
      // StrictMode 双挂载会先跑一轮 cleanup：挂载体恢复标记（useRef 初值只在
      // 首次挂载生效，不能依赖它跨双挂载保持 true）。
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
          const input = buildInputRef.current();
          const json = JSON.stringify(input);
          if (canSaveRef.current && json !== lastSavedRef.current) {
            persist(input, json);
          }
        }
      };
    },
    // 空依赖刻意为之：persist 仅经稳定 ref 读写，卸载补存语义见上
    [],
  );

  /** 关闭前补存：取消在途防抖，未落库的最后一拍立即上送。串行链在途窗口
   *  （timerRef 为 null 但基线尚未推进）由 persist 落库后的纠正拍守护。 */
  const flushSave = (): void => {
    if (timerRef.current === null) return; // 无在途防抖 = 在途窗口由纠正拍兜底
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const input = buildInputRef.current();
    const json = JSON.stringify(input);
    if (!canSaveRef.current || json === lastSavedRef.current) return;
    persist(input, json);
  };

  // 「预览动画」：引擎实例按容器惰性创建，卸载即停一切计时（cancel）。
  const previewNodeRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  useEffect(
    () => () => {
      rendererRef.current?.cancel();
      rendererRef.current = null;
    },
    [],
  );

  const playPreview = (): void => {
    const container = previewNodeRef.current;
    if (!container) return;
    // 预览即所见即所得（2026-09-13）：演出参数取卡覆写，「跟随全局」取全局
    // 基准——每次点播前下发（实例可能已存在，setter 下一拍生效）。
    const effDuration = animDurationMs ?? animDefaults.durationMs;
    const effRhythm = animRhythmMs ?? animDefaults.msPerChar;
    const effPunct = animPunctPause ?? animDefaults.punctPause;
    rendererRef.current ??= createRenderer(container);
    // 遗留数据可能带 18 表之外的风格串：先自校验回落 fade（引擎 setStyle 不校验）。
    const found = ANIM_STYLES.find((s) => s.id === renderStyle);
    const style: AnimStyleId = found ? found.id : 'fade';
    rendererRef.current.setStyle(style);
    rendererRef.current.setDuration(effDuration);
    rendererRef.current.setRhythm(effRhythm, effPunct);
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
  animDurationMs,
  setAnimDurationMs,
  animRhythmMs,
  setAnimRhythmMs,
  animPunctPause,
  setAnimPunctPause,
    accentColor,
    setAccentColor,
    override,
    setOverride: (update) => setOverrideState(update),
    overrideOpen,
    setOverrideOpen: (update) => setOverrideOpenState(update),
    canSave,
    flushSave,
    previewRef: (node) => {
      previewNodeRef.current = node;
    },
    previewed,
    playPreview,
    live,
  };
}
