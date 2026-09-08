/**
 * 角色卡编辑器对话框（TASK-008 / UI-002 / FR-006；Fluent 表单组件，ADR-011）。
 *
 * - 非模态（modal={false}）：背后的卡片网格仍可点选，「未保存切换选中项」的
 *   丢弃确认（父组件就地实现的 Fluent Dialog）才真正可达；
 * - 新建 / 编辑共用：character = null 即新建。父组件以 key=目标 id 重挂本组件
 *   换绑表单初值；脏状态经 onDirtyChange 上报父级做切换守卫；
 * - avatar 不做编辑 UI：新建恒传 null、编辑原样带回现值（TASK-008 验收 2）；
 *   voiceConfig 恒 null——TTS 留缝不留壳（CON-003），无 UI；
 * - model_config 覆写：providerId 下拉（getConfig 的 providers，可空=跟随全局）
 *   + model / baseUrl / apiKey 文本（可空=跟随），序列化为 camelCase 键 JSON
 *   （Rust `resolve_effective_llm` 消费）；全空序列化为 null；解析得到的未知键
 *   原样往返保留（Rust 侧忽略未知键，编辑不应悄悄清掉它们）；
 * - 「预览演出」经引擎公开 API 播一次所选风格出场动画（createRenderer +
 *   setStyle / beginTurn / enqueue / finish），样例文本取当前开场白草稿。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Input,
  Option,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterInput, CharacterSummary, ProviderDto } from '../../api/types';
import { ANIM_STYLES, createRenderer, type AnimStyleId, type Renderer } from '../../engine';

const useStyles = makeStyles({
  surface: {
    maxWidth: '640px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  grow: {
    flexGrow: 1,
    minWidth: 0,
  },
  preview: {
    minHeight: '72px',
    maxHeight: '160px',
    overflowY: 'auto',
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    wordBreak: 'break-word',
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

/** model_config JSON 的表单形态（空串 = 该字段跟随全局）。 */
interface ModelOverrideFields {
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
  greeting: string,
  renderStyle: string,
  override: ModelOverrideFields,
): string {
  return [
    name,
    persona,
    greeting,
    renderStyle,
    override.providerId,
    override.model,
    override.baseUrl,
    override.apiKey,
    JSON.stringify(override.rest),
  ].join('\u0000');
}

export interface CharacterEditorDialogProps {
  /** null = 新建；否则编辑该角色（全量字段预填，含 persona / modelConfig）。 */
  character: CharacterSummary | null;
  /** providerId 下拉数据源（getConfig().providers）。 */
  providers: ProviderDto[];
  saving: boolean;
  /** 保存 / 删除失败的行内错误文案（父组件设置）。 */
  errorText: string | null;
  /** 脏状态上报（父级据此拦截切换选中项 / 关闭）。 */
  onDirtyChange: (dirty: boolean) => void;
  onSave: (input: CharacterInput) => void;
  onClose: () => void;
  /** 删除按钮（仅编辑态）：父组件弹就地确认对话框，本组件不直接删。 */
  onDelete: (character: CharacterSummary) => void;
}

export function CharacterEditorDialog(props: CharacterEditorDialogProps) {
  const { character, providers, saving, errorText, onDirtyChange, onSave, onClose, onDelete } =
    props;
  const styles = useStyles();
  const { t } = useTranslation();

  // 目标角色由父组件 key 重挂保证不变，初值只取一次（exactOptionalPropertyTypes
  // 下按需赋值，不传 undefined）。
  const initial = useMemo(() => {
    const override = parseModelOverride(character?.modelConfig ?? null);
    return {
      name: character?.name ?? '',
      persona: character?.persona ?? '',
      greeting: character?.greeting ?? '',
      // 新建默认 render_style 与 Rust NewCharacter::default 一致（typewriter）。
      renderStyle: character?.renderStyle ?? 'typewriter',
      override,
      signature: formSignature(
        character?.name ?? '',
        character?.persona ?? '',
        character?.greeting ?? '',
        character?.renderStyle ?? 'typewriter',
        override,
      ),
    };
  }, [character]);

  const [name, setName] = useState(initial.name);
  const [persona, setPersona] = useState(initial.persona);
  const [greeting, setGreeting] = useState(initial.greeting);
  const [renderStyle, setRenderStyle] = useState(initial.renderStyle);
  const [override, setOverride] = useState<ModelOverrideFields>(initial.override);

  const dirty =
    formSignature(name, persona, greeting, renderStyle, override) !== initial.signature;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // 「预览演出」：引擎实例按容器惰性创建，卸载即停一切计时（cancel）。
  const previewRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  useEffect(
    () => () => {
      rendererRef.current?.cancel();
      rendererRef.current = null;
    },
    [],
  );

  const canSave = name.trim().length > 0;

  const handleSave = (): void => {
    onSave({
      name: name.trim(),
      // avatar 不做编辑 UI：新建 null、编辑原样带回现值。
      avatar: character?.avatar ?? null,
      persona,
      greeting,
      renderStyle,
      modelConfig: serializeModelOverride(override),
      // TTS 预留缝恒 null（CON-003）。
      voiceConfig: null,
    });
  };

  const playPreview = (): void => {
    const container = previewRef.current;
    if (!container) return;
    rendererRef.current ??= createRenderer(container);
    // 遗留数据可能带 18 表之外的风格串：先自校验回落 fade（引擎 setStyle 不校验）。
    const found = ANIM_STYLES.find((s) => s.id === renderStyle);
    const style: AnimStyleId = found ? found.id : 'fade';
    // 一次完整出场：新回合清屏 → 入队（开场白草稿优先）→ 排空定格。
    rendererRef.current.setStyle(style);
    rendererRef.current.beginTurn();
    rendererRef.current.enqueue(greeting.trim() || t('characters.previewSample'));
    rendererRef.current.finish();
  };

  const selectedStyle = ANIM_STYLES.find((s) => s.id === renderStyle);
  const selectedProvider = providers.find((p) => p.id === override.providerId);

  return (
    <Dialog open modalType="non-modal">
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>
            {character ? t('characters.editTitle') : t('characters.createTitle')}
          </DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              <label className={styles.field}>
                <Text size={300} weight="semibold">
                  {t('characters.name')}
                </Text>
                <Input
                  value={name}
                  onChange={(_, d) => setName(d.value)}
                  aria-label={t('characters.name')}
                />
                {!canSave ? <Text size={200}>{t('characters.nameRequired')}</Text> : null}
              </label>
              <label className={styles.field}>
                <Text size={300} weight="semibold">
                  {t('characters.persona')}
                </Text>
                <Textarea
                  value={persona}
                  rows={3}
                  onChange={(_, d) => setPersona(d.value)}
                  aria-label={t('characters.persona')}
                  placeholder={t('characters.personaPlaceholder')}
                />
              </label>
              <label className={styles.field}>
                <Text size={300} weight="semibold">
                  {t('characters.greeting')}
                </Text>
                <Textarea
                  value={greeting}
                  rows={3}
                  onChange={(_, d) => setGreeting(d.value)}
                  aria-label={t('characters.greeting')}
                  placeholder={t('characters.greetingPlaceholder')}
                />
              </label>
              <div className={styles.field}>
                <Text size={300} weight="semibold">
                  {t('characters.renderStyle')}
                </Text>
                <div className={styles.row}>
                  <Dropdown
                    className={styles.grow}
                    value={selectedStyle ? selectedStyle.label : renderStyle}
                    selectedOptions={selectedStyle ? [selectedStyle.id] : []}
                    onOptionSelect={(_, d) => setRenderStyle(d.optionValue ?? '')}
                    aria-label={t('characters.renderStyle')}
                  >
                    {ANIM_STYLES.map((s) => (
                      <Option key={s.id} value={s.id} text={s.label}>
                        {s.label} · {s.id}
                      </Option>
                    ))}
                  </Dropdown>
                  <Button onClick={playPreview}>{t('characters.preview')}</Button>
                </div>
                <div ref={previewRef} className={styles.preview} />
              </div>
              <div className={styles.section}>
                <Text size={300} weight="semibold">
                  {t('characters.modelOverride')}
                </Text>
                <label className={styles.field}>
                  <Text size={200}>{t('characters.provider')}</Text>
                  <Dropdown
                    value={
                      selectedProvider ? selectedProvider.name : t('characters.followGlobal')
                    }
                    selectedOptions={[override.providerId]}
                    onOptionSelect={(_, d) =>
                      setOverride((o) => ({ ...o, providerId: d.optionValue ?? '' }))
                    }
                    aria-label={t('characters.provider')}
                  >
                    <Option value="" text={t('characters.followGlobal')}>
                      {t('characters.followGlobal')}
                    </Option>
                    {providers.map((p) => (
                      <Option key={p.id} value={p.id} text={p.name}>
                        {p.name} · {p.id}
                      </Option>
                    ))}
                  </Dropdown>
                </label>
                <label className={styles.field}>
                  <Text size={200}>{t('characters.model')}</Text>
                  <Input
                    value={override.model}
                    onChange={(_, d) => setOverride((o) => ({ ...o, model: d.value }))}
                    aria-label={t('characters.model')}
                    placeholder={t('characters.followGlobal')}
                  />
                </label>
                <label className={styles.field}>
                  <Text size={200}>{t('characters.baseUrl')}</Text>
                  <Input
                    value={override.baseUrl}
                    onChange={(_, d) => setOverride((o) => ({ ...o, baseUrl: d.value }))}
                    aria-label={t('characters.baseUrl')}
                    placeholder={t('characters.followGlobal')}
                  />
                </label>
                <label className={styles.field}>
                  <Text size={200}>{t('characters.apiKey')}</Text>
                  <Input
                    type="password"
                    value={override.apiKey}
                    onChange={(_, d) => setOverride((o) => ({ ...o, apiKey: d.value }))}
                    aria-label={t('characters.apiKey')}
                    placeholder={t('characters.followGlobal')}
                  />
                </label>
              </div>
              {errorText ? (
                <Text role="alert" size={200} className={styles.error}>
                  {errorText}
                </Text>
              ) : null}
            </div>
          </DialogContent>
          <DialogActions>
            {character ? (
              <Button
                style={{ marginRight: 'auto' }}
                disabled={saving}
                onClick={() => onDelete(character)}
              >
                {t('characters.delete')}
              </Button>
            ) : null}
            <Button disabled={saving} onClick={onClose}>
              {t('characters.cancel')}
            </Button>
            <Button
              appearance="primary"
              disabled={!canSave || saving}
              onClick={handleSave}
            >
              {saving ? t('characters.saving') : t('characters.save')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
