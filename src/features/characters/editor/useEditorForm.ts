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
 * - 「预览演出」经引擎公开 API 播一次所选风格（createRenderer +
 *   setStyle / beginTurn / enqueue / finish），样例文本取 i18n 预览样例。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterInput, CharacterSummary } from '../../../api/types';
import { ANIM_STYLES, createRenderer, type AnimStyleId, type Renderer } from '../../../engine';
import {
  dotGradientOf,
  gradientOf,
  posterGradientOf,
  DEFAULT_POSTER_GRADIENT,
} from '../posterGradient';

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

/** 脏比对签名：字段拼接（rest 以 JSON 串参与，键序在同源对象间稳定）。 */
function formSignature(
  name: string,
  persona: string,
  renderStyle: string,
  accentColor: string | null,
  override: ModelOverrideFields,
): string {
  return [
    name,
    persona,
    renderStyle,
    accentColor ?? '',
    override.providerId,
    override.model,
    override.baseUrl,
    override.apiKey,
    JSON.stringify(override.rest),
  ].join('\u0000');
}

export interface EditorForm {
  name: string;
  setName: (value: string) => void;
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
  canSave: boolean;
  /** 预览演出渲染容器（引擎惰性创建，卸载即 cancel）。 */
  previewRef: (node: HTMLDivElement | null) => void;
  previewed: boolean;
  playPreview: () => void;
  buildInput: () => CharacterInput;
  /** 外壳渲染主题横幅 / 海报用的派生值（全部随输入实时更新）。 */
  live: {
    nameText: string;
    posterGradient: string;
    idPosterGradient: string;
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
    return {
      name: character?.name ?? '',
      persona: character?.persona ?? '',
      // 新建默认 render_style 与 Rust NewCharacter::default 一致（typewriter）。
      renderStyle: character?.renderStyle ?? 'typewriter',
      // null = 跟随海报派生（accent_color 列语义，迁移 0003）。
      accentColor: character?.accentColor ?? null,
      override,
      signature: formSignature(
        character?.name ?? '',
        character?.persona ?? '',
        character?.renderStyle ?? 'typewriter',
        character?.accentColor ?? null,
        override,
      ),
    };
  }, [character]);

  const [name, setName] = useState(initial.name);
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
  // 是否已播过预览：控制空态提示显隐（重挂/切角色由父组件 key 重置）。
  const [previewed, setPreviewed] = useState(false);

  const dirty = formSignature(name, persona, renderStyle, accentColor, override) !== initial.signature;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

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

  const canSave = name.trim().length > 0;

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
      // 「跟随海报」色板展示的正是放弃覆盖后海报回到的样子。
      idPosterGradient: character ? gradientOf(character.id) : DEFAULT_POSTER_GRADIENT,
      dotGradient: dotGradientOf(accentInput),
      styleLabel: selectedStyle ? selectedStyle.label : renderStyle,
    };
  }, [character, accentColor, renderStyle, name, t]);

  return {
    name,
    setName,
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
      renderStyle,
      accentColor,
      modelConfig: serializeModelOverride(override),
      // TTS 预留缝恒 null（CON-003）。
      voiceConfig: null,
    }),
    live,
  };
}
