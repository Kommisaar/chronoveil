/**
 * 世界卡编辑器表单逻辑：状态 + 修改即保存（镜像 characters/editor/
 * useEditorForm 的自动保存机制，字段面收窄为名称 / 世界观 / 历法三字段；
 * 两处以内不提取公共钩子——两边的载荷构造与预填语义各自内聚）。
 *
 * - 只服务编辑既有卡（新建由父级「先建卡再进编辑器」）：父组件以 key 重挂
 *   换绑初值；world 是打开时的快照，保存后父级 refresh 不回灌表单；
 * - 修改即保存：任一字段改动经 600ms 防抖后串行上送（上一拍完成才发下一
 *   拍，防乱序覆盖）；载荷与上次已保存值相同则跳过；名称为空（canSave=
 *   false）暂不发送；关闭前由排版壳调 flushSave 补存最后一拍；「过期载荷
 *   不得落库」对防抖窗口（还原取消防抖拍）与串行链在途窗口（落库后的
 *   纠正拍补齐）都成立——语义与 useEditorForm 逐条同构，机制注释见彼处；
 * - 历法持有整份 CalendarConfigDto（而非预设键）：改选五选一时写入对应
 *   预设 DTO / null，未改选则原样带回卡上现值——matchPreset 匹配不上四
 *   预设的外来历法（今日无生产路径）不会被选中态意外抹成 null。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarConfigDto, WorldInput, WorldSummary } from '../../api/types';
import { CALENDAR_PRESETS, type CalendarPresetId } from '../../components/calendarPresets';

/** 历法五选项键：default = 不设预设（wire 传 null，落库走内置默认历）。 */
export type PresetKey = 'default' | CalendarPresetId;

/** 自动保存防抖（毫秒）：与角色编辑器同档（连续输入期间持续顺延，停手后一拍落库）。 */
const AUTOSAVE_DEBOUNCE_MS = 600;

/** festivals 逐键比对（wire 形态可空：null 只与 null 相等；键转数字后索引）。 */
function sameFestivals(
  a: Partial<{ [key: number]: string }> | null,
  b: Partial<{ [key: number]: string }> | null,
): boolean {
  if (a === null || b === null) return a === null && b === null;
  const keys = Object.keys(a).map(Number);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** 卡上历法 → 五选项键（仅用于单选钮回显）：null = default；四预设按
 *  months / daysPerMonth / dayNames / festivals 逐项结构比对（不依赖 JSON
 *  键序，festivals 键集 + 值比对）；都不匹配回 'default' 显示。 */
export function matchPreset(calendar: CalendarConfigDto | null): PresetKey {
  if (calendar === null) return 'default';
  const entries = Object.entries(CALENDAR_PRESETS) as Array<[CalendarPresetId, CalendarConfigDto]>;
  const hit = entries.find(([, preset]) => {
    const months = preset.months.length === calendar.months.length
      && preset.months.every((m, i) => m === calendar.months[i]);
    const dayNames = preset.dayNames.length === calendar.dayNames.length
      && preset.dayNames.every((d, i) => d === calendar.dayNames[i]);
    return (
      months
      && dayNames
      && preset.daysPerMonth === calendar.daysPerMonth
      && sameFestivals(preset.festivals, calendar.festivals)
    );
  });
  return hit === undefined ? 'default' : hit[0];
}

export interface WorldForm {
  name: string;
  setName: (value: string) => void;
  worldbook: string;
  setWorldbook: (value: string) => void;
  /** 当前选中预设键（派生自历法值）。 */
  preset: PresetKey;
  /** 改选五选一：default 落 null，预设落整份 wire DTO（存储 JSON 由 Rust 序列化）。 */
  setPreset: (key: PresetKey) => void;
  /** 名称必填门槛：为空时自动保存挂起（编辑器出必填提示）。 */
  canSave: boolean;
  /** 关闭前补存：取消在途防抖，把未落库的最后一拍立即上送。 */
  flushSave: () => void;
}

export function useWorldForm(props: {
  world: WorldSummary;
  /** 修改即保存的上送出口（父级落库 + refresh + 错误就地展示）。 */
  onAutosave: (input: WorldInput) => Promise<void>;
}): WorldForm {
  const { world, onAutosave } = props;

  // 目标卡由父组件 key 重挂保证不变，初值只取一次。
  const initial = useMemo(
    () => ({ name: world.name, worldbook: world.worldbook, calendar: world.calendar }),
    [world],
  );

  const [name, setName] = useState(initial.name);
  const [worldbook, setWorldbook] = useState(initial.worldbook);
  const [calendar, setCalendar] = useState<CalendarConfigDto | null>(initial.calendar);

  const canSave = name.trim().length > 0;

  // 当前表单 → 整卡负载（create / update 共用同一 wire 形态）。
  const buildInput = (): WorldInput => ({ name: name.trim(), worldbook, calendar });

  // ---- 修改即保存（自动保存；机制语义与 useEditorForm 逐条同构）----
  // 已保存基线：打开时快照的载荷（key 重挂即换绑）。
  const initialInputJson = useMemo(() => JSON.stringify(buildInput()), []);
  const lastSavedRef = useRef(initialInputJson);
  const timerRef = useRef<number | null>(null);
  // 卸载标记：纠正拍在卸载后改为直入串行链。
  const mountedRef = useRef(true);
  // 串行链：上一拍上送完成才发下一拍（IPC 无序完成时防旧载荷覆盖新载荷）。
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // latest-ref 模式：串行链与卸载补存执行时取最新闭包；卸载后 ref 冻结在
  // 原卡绑定的回调上——A 卡在途载荷不会误写 B 卡。
  const onAutosaveRef = useRef(onAutosave);
  const buildInputRef = useRef(buildInput);
  const canSaveRef = useRef(canSave);
  onAutosaveRef.current = onAutosave;
  buildInputRef.current = buildInput;
  canSaveRef.current = canSave;

  /** 纠正拍（在途窗口守护）：比对当前表单与已保存基线，不一致则补一拍。
   *  还原路径只能取消防抖拍，串行链在途窗口的差异由此补齐。已卸载时不能
   *  等防抖（无渲染驱动），直入串行链补齐最终意图。 */
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

  /** 上送一拍：入链串行执行；成功后推进已保存基线并按需排纠正拍。失败已在
   *  父级就地红字展示，链吞掉 rejection 不断链（下一拍改动自然重试）。 */
  const persist = (input: WorldInput, json: string): void => {
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

  // 修改即保存：无依赖数组 = 每次渲染重新比对（表单字段集即全部状态；此
  // 处置需要最新闭包）。
  useEffect(() => {
    const json = JSON.stringify(buildInputRef.current());
    if (json === lastSavedRef.current) {
      // 改回已保存值（防抖窗口内还原）：取消在途拍；串行链在途的还原差异
      // 由落库后的纠正拍补齐。
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

  // 卸载补存（切换目标卡 / 关闭卸载）：在途防抖立即上送，避免丢最后一拍。
  useEffect(
    () => {
      // StrictMode 双挂载会先跑一轮 cleanup：挂载体恢复标记。
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

  return {
    name,
    setName,
    worldbook,
    setWorldbook,
    preset: matchPreset(calendar),
    setPreset: (key) => setCalendar(key === 'default' ? null : CALENDAR_PRESETS[key]),
    canSave,
    flushSave,
  };
}
