/**
 * 强调色取色器（Office 风格，2026-09-09 定稿；从 pieces.tsx 按字段域抽出，
 * 行为零变化）：色块 + 下拉箭头的触发钮，弹层含「跟随海报 / 主题颜色 /
 * 标准颜色 / 更多颜色（原生取色器）」。刻意无开合动画（用户定稿）：点击即现、
 * 点外部即关，选色后面板保持打开。色块恒显「基础色」纯色（显式强调色，或
 * 跟随海报时按 id 派生的亮端）——海报的暗变是 scrim 叠层，不进颜色元数据。
 * 存储值仍为 #rrggbb 单色。字段级样式沿用 pieces 的 useFieldStyles（三壳共用
 * 单一事实源）。
 */
import { Text, Tooltip, mergeClasses } from '@fluentui/react-components';
import { ChevronDown20Regular, Color20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStyles } from './pieces';

// —— 强调色取色器调色板：主题色 10 列 × 6 档明暗 + 标准色 10 色。
// 基色取高饱和活力色（覆盖整个色环），每列程序化混白/混黑生成浅深档；
// 标准色沿用经典 Office 标准色行。
const THEME_BASES = [
  '#ef4444', // 红
  '#f97316', // 橙
  '#f59e0b', // 琥珀
  '#eab308', // 黄
  '#84cc16', // 草绿
  '#10b981', // 翠绿
  '#06b6d4', // 青
  '#3b82f6', // 蓝
  '#8b5cf6', // 紫
  '#ec4899', // 品红
];
const STANDARD_COLORS = [
  '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050',
  '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0',
];

const parseRgb = (hex: string): readonly [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function mixHex(base: string, target: string, ratio: number): string {
  const [br, bg, bb] = parseRgb(base);
  const [tr, tg, tb] = parseRgb(target);
  const ch = (c: number, t: number) => hex2(Math.round(c + (t - c) * ratio));
  return `#${ch(br, tr)}${ch(bg, tg)}${ch(bb, tb)}`;
}

function themeColumn(base: string): string[] {
  // 由浅到深单调下行（Office 同构）：三档浅色 → 基色居中 → 两档深色。
  // 之前是「基色 → 变浅 → 又变深」，列内明暗跳变（用户反馈）。
  return [
    mixHex(base, '#ffffff', 0.9),
    mixHex(base, '#ffffff', 0.75),
    mixHex(base, '#ffffff', 0.55),
    base,
    mixHex(base, '#000000', 0.3),
    mixHex(base, '#000000', 0.55),
  ];
}

/** 行主序摊平成 10 列网格（同一行 = 同一档明暗，同一列 = 同一色相）。 */
const THEME_COLUMNS: string[][] = THEME_BASES.map(themeColumn);
const THEME_GRID: string[] = [];
for (let row = 0; row < 6; row += 1) {
  for (const column of THEME_COLUMNS) {
    const color = column[row];
    if (color) THEME_GRID.push(color);
  }
}

/** 单格色块：网格与标准色行共用；选中环经 box-shadow 短过渡反馈。 */
function PaletteSwatch(props: {
  color: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const styles = useFieldStyles();
  return (
    <Tooltip content={props.color} relationship="label">
      <button
        type="button"
        className={mergeClasses(
          styles.paletteSwatch,
          props.selected && styles.paletteSwatchSelected,
        )}
        style={{ backgroundColor: props.color }}
        aria-label={props.color}
        aria-pressed={props.selected}
        onClick={props.onSelect}
      />
    </Tooltip>
  );
}

export interface AccentColorPickerProps {
  accentColor: string | null;
  /** 基础色（未经修饰）：跟随海报态的显示色。 */
  baseColor: string;
  onChange: (value: string | null) => void;
}

/** 强调色取色器：CharacterEditorDialog 等编辑器壳的字段落位件。 */
export function AccentColorPicker(props: AccentColorPickerProps) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);

  // 点外部即关（pointerdown 捕获按下瞬间，先于 click 语义）。
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  const select = (value: string | null): void => {
    // 选取后面板保持打开（用户定稿：方便连续试色）；关闭走点外部/再点色块
    props.onChange(value);
  };

  const current = props.accentColor;
  return (
    <div className={styles.chipWrapper} ref={wrapRef}>
      <Tooltip content={t('characters.accentColor')} relationship="label">
        <button
          type="button"
          className={styles.chipTrigger}
          aria-label={t('characters.accentColor')}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span
            className={styles.chipColor}
            style={{ backgroundColor: current ?? props.baseColor }}
          />
          <ChevronDown20Regular />
        </button>
      </Tooltip>
      {open ? (
        // 弹出动画：palette-pop-in 落在 app.css（Griffel 不透出 keyframes），
        // 缩放淡入 150ms 减速曲线，锚点在色块左上（transform-origin 同位）
        <div
          className={`${styles.palettePanel} palette-pop-in`}
          role="group"
          aria-label={t('characters.accentColor')}
        >
          <button
            type="button"
            className={mergeClasses(
              styles.paletteListItem,
              current === null && styles.paletteSwatchSelected,
            )}
            onClick={() => select(null)}
          >
            <span className={styles.paletteListSwatch} style={{ backgroundColor: props.baseColor }} />
            <Text size={300}>{t('characters.accentFollow')}</Text>
          </button>
          <Text className={styles.paletteTitle}>{t('characters.themeColors')}</Text>
          <div className={styles.paletteGrid}>
            {THEME_GRID.map((color) => (
              <PaletteSwatch
                key={color}
                color={color}
                selected={current === color}
                onSelect={() => select(color)}
              />
            ))}
          </div>
          <Text className={styles.paletteTitle}>{t('characters.standardColors')}</Text>
          <div className={styles.paletteGrid}>
            {STANDARD_COLORS.map((color) => (
              <PaletteSwatch
                key={color}
                color={color}
                selected={current === color}
                onSelect={() => select(color)}
              />
            ))}
          </div>
          <button
            type="button"
            className={styles.paletteListItem}
            onClick={() => colorInputRef.current?.click()}
          >
            <Color20Regular />
            <Text size={300}>{t('characters.moreColors')}</Text>
          </button>
          <input
            ref={colorInputRef}
            type="color"
            value={current ?? '#6b46b8'}
            onChange={(e) => select(e.target.value.toLowerCase())}
            className={styles.colorInputHidden}
            tabIndex={-1}
            aria-hidden
          />
        </div>
      ) : null}
    </div>
  );
}
