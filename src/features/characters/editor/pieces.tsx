/**
 * 编辑器共享 UI 件（2026-09-09 编辑器重做时抽出）：字段级组件与样式——
 * 强调色板、预览框、模型覆写折叠段，由 CharacterEditorDialog 排版壳复用。
 */
import { Button, Dropdown, Option, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronRight20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { ProviderDto } from '../../../api/types';
import { ANIM_STYLES } from '../../../engine';
import { POSTER_GRADIENTS } from '../posterGradient';
import type { ModelOverrideFields } from './useEditorForm';

/** 三壳共用的字段级样式（makeStyles 可跨组件调用）。 */
export const useFieldStyles = makeStyles({
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
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
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    '::after': {
      content: '""',
      flexGrow: 1,
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },
  swatchRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXXS,
  },
  swatch: {
    width: '32px',
    height: '32px',
    padding: '0px',
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStrokeAlpha2}`,
    cursor: 'pointer',
    ':hover': { boxShadow: `0 0 0 2px ${tokens.colorNeutralStroke2}` },
  },
  swatchSelected: {
    boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}, 0 0 0 4px ${tokens.colorBrandForeground1}`,
    ':hover': {
      boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}, 0 0 0 4px ${tokens.colorBrandForeground1}`,
    },
  },
  previewWrap: {
    position: 'relative',
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
  // 空态提示：ref 容器的兄弟节点——引擎直接操作容器内 DOM，React 子节点
  // 放同一容器会在 reconcile 时打架。
  previewHint: {
    position: 'absolute',
    inset: '0px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  collapseBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: '0px',
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    textAlign: 'left',
    ':hover': { color: tokens.colorBrandForeground1 },
  },
  chevron: {
    transitionProperty: 'transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
  },
  chevronOpen: {
    transform: 'rotate(90deg)',
  },
  collapseBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL,
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

/** 强调色板：首枚「跟随海报」，后六枚为调色板亮端预设。 */
export function AccentSwatches(props: {
  accentColor: string | null;
  idPosterGradient: string;
  onChange: (value: string | null) => void;
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.swatchRow}>
      <button
        type="button"
        className={mergeClasses(
          styles.swatch,
          props.accentColor === null && styles.swatchSelected,
        )}
        style={{ backgroundImage: props.idPosterGradient }}
        aria-label={t('characters.accentFollow')}
        aria-pressed={props.accentColor === null}
        title={t('characters.accentFollow')}
        onClick={() => props.onChange(null)}
      />
      {POSTER_GRADIENTS.map(([from, to]) => (
        <button
          key={to}
          type="button"
          className={mergeClasses(
            styles.swatch,
            props.accentColor === to && styles.swatchSelected,
          )}
          style={{ backgroundImage: `linear-gradient(150deg, ${from} 0%, ${to} 100%)` }}
          aria-label={to}
          aria-pressed={props.accentColor === to}
          title={to}
          onClick={() => props.onChange(to)}
        />
      ))}
    </div>
  );
}

/** 预览演出渲染容器 + 空态提示。 */
export function PreviewBox(props: {
  previewRef: (node: HTMLDivElement | null) => void;
  previewed: boolean;
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.previewWrap}>
      <div ref={props.previewRef} className={styles.preview} />
      {!props.previewed ? (
        <Text className={styles.previewHint}>{t('characters.previewEmpty')}</Text>
      ) : null}
    </div>
  );
}

/** 出场动画字段：风格下拉 + 播一次预览 + 渲染框。 */
export function PerformanceField(props: {
  renderStyle: string;
  onStyleChange: (value: string) => void;
  onPlay: () => void;
  previewRef: (node: HTMLDivElement | null) => void;
  previewed: boolean;
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  const selectedStyle = ANIM_STYLES.find((s) => s.id === props.renderStyle);
  return (
    <>
      <div className={styles.row}>
        <Dropdown
          className={styles.grow}
          value={selectedStyle ? selectedStyle.label : props.renderStyle}
          selectedOptions={selectedStyle ? [selectedStyle.id] : []}
          onOptionSelect={(_, d) => props.onStyleChange(d.optionValue ?? '')}
          aria-label={t('characters.renderStyle')}
        >
          {ANIM_STYLES.map((s) => (
            <Option key={s.id} value={s.id} text={s.label}>
              {s.label} · {s.id}
            </Option>
          ))}
        </Dropdown>
        <Button onClick={props.onPlay}>{t('characters.preview')}</Button>
      </div>
      <PreviewBox previewRef={props.previewRef} previewed={props.previewed} />
    </>
  );
}

/** 模型覆写折叠段（双层级 2026-09-09）：服务 + 该服务的模型下拉，留空跟随全局。
 *  旧数据里的 baseUrl/apiKey 覆写键不再提供输入框（连接信息归属服务级），但
 *  parse/serialize 对未知/遗留键原样保留，编辑往返不丢失。 */
export function OverrideSection(props: {
  open: boolean;
  onToggle: () => void;
  override: ModelOverrideFields;
  onOverrideChange: (
    update: (current: ModelOverrideFields) => ModelOverrideFields,
  ) => void;
  providers: ProviderDto[];
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  const selectedProvider = props.providers.find((p) => p.id === props.override.providerId);
  const models = selectedProvider?.models ?? [];
  // 存量覆写里的模型名不在所选服务列表（服务改配/换服务）→ 追加为额外选项，
  // 避免下拉显示成"跟随全局"却实际覆写着旧值。
  const staleModel =
    props.override.model !== '' && !models.includes(props.override.model)
      ? props.override.model
      : null;
  return (
    <div className={styles.field}>
      <button
        type="button"
        className={styles.collapseBtn}
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <ChevronRight20Regular
          className={mergeClasses(styles.chevron, props.open && styles.chevronOpen)}
        />
        <Text size={300} weight="semibold">
          {t('characters.modelOverride')}
        </Text>
        <Text size={200}>{t('characters.overrideHint')}</Text>
      </button>
      {props.open ? (
        <div className={styles.collapseBody}>
          <label className={styles.field}>
            <Text size={200}>{t('characters.provider')}</Text>
            <Dropdown
              value={selectedProvider ? selectedProvider.name : t('characters.followGlobal')}
              selectedOptions={[props.override.providerId]}
              onOptionSelect={(_, d) =>
                props.onOverrideChange((o) => ({ ...o, providerId: d.optionValue ?? '' }))
              }
              aria-label={t('characters.provider')}
            >
              <Option value="" text={t('characters.followGlobal')}>
                {t('characters.followGlobal')}
              </Option>
              {props.providers.map((p) => (
                <Option key={p.id} value={p.id} text={p.name}>
                  {p.name} · {p.id}
                </Option>
              ))}
            </Dropdown>
          </label>
          <label className={styles.field}>
            <Text size={200}>{t('characters.model')}</Text>
            <Dropdown
              value={props.override.model === '' ? t('characters.followGlobal') : props.override.model}
              selectedOptions={[props.override.model]}
              onOptionSelect={(_, d) =>
                props.onOverrideChange((o) => ({ ...o, model: d.optionValue ?? '' }))
              }
              aria-label={t('characters.model')}
            >
              <Option value="" text={t('characters.followGlobal')}>
                {t('characters.followGlobal')}
              </Option>
              {staleModel ? (
                <Option value={staleModel} text={staleModel}>
                  {staleModel}
                </Option>
              ) : null}
              {models.map((m) => (
                <Option key={m} value={m} text={m}>
                  {m}
                </Option>
              ))}
            </Dropdown>
          </label>
        </div>
      ) : null}
    </div>
  );
}
