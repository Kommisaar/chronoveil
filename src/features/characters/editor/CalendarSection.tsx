/**
 * 角色卡历法区块（FR-014 二期）：编辑器内可折叠 section（开合语言与
 * OverrideSection 同款 useFieldStyles 折叠件），查看 / 编辑双态——
 * - 查看态：当前表单历法（未配置显示「默认数字历」提示；已配置出历法名、
 *   N月×M日、月名 / 日名全列与节日表，CalendarDetail 同时供 AI 起草对话框
 *   的结果预览复用）；
 * - 编辑态：历法名（可空）/ 每月天数 / 月名日名（每行一项 textarea）/ 节日
 *   （每行「N=名称」），四内置预设下拉一键填入（数据源
 *   components/calendarPresets，与开局向导同一事实源）；校验对齐
 *   Rust fiction_time::validate，拦截在 useEditorForm.canSave（保存按钮）。
 */
import { Button, Dropdown, Input, Option, Text, Textarea, Tooltip, mergeClasses } from '@fluentui/react-components';
import { Checkmark20Regular, ChevronRight20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import {
  CALENDAR_PRESETS,
  CALENDAR_PRESET_OPTIONS,
  type CalendarPresetId,
} from '../../../components/calendarPresets';
import type { CalendarConfigDto } from '../../../api/types';
import type { CalendarBuild, CalendarFieldError, CalendarFields } from './calendarForm';
import { fieldsFromCalendar, MAX_DAYS_PER_MONTH } from './calendarForm';
import { useFieldStyles } from './pieces';

/** 校验失败 → i18n key（文案与 calendarForm 的错误定位一一对应）。 */
const ERROR_KEYS: Record<CalendarFieldError, string> = {
  daysPerMonth: 'characters.calendar.errorDaysPerMonth',
  daysPerMonthMax: 'characters.calendar.errorDaysPerMonthMax',
  names: 'characters.calendar.errorNames',
  festivals: 'characters.calendar.errorFestivals',
};

/**
 * 历法明细（查看态与 AI 起草结果预览共用）：历法名 / N月×M日 / 月名日名
 * 全列 / 节日表。config 必须是有效配置（调用方先处理未配置态）。
 */
export function CalendarDetail(props: { config: CalendarConfigDto }) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  const festivals = Object.entries(props.config.festivals ?? {})
    .map(([key, value]) => ({ day: Number(key), value }))
    .sort((a, b) => a.day - b.day);
  return (
    <div className={styles.field}>
      {props.config.name !== null ? (
        <Text size={300}>{t('characters.calendar.viewName', { name: props.config.name })}</Text>
      ) : null}
      <Text size={300}>
        {t('characters.calendar.summaryGrid', {
          months: props.config.months.length,
          days: props.config.daysPerMonth,
        })}
      </Text>
      {props.config.months.length > 0 ? (
        <>
          <Text size={200}>{t('characters.calendar.viewMonths', { count: props.config.months.length })}</Text>
          <Text size={300}>{props.config.months.join('、')}</Text>
        </>
      ) : null}
      {props.config.dayNames.length > 0 ? (
        <>
          <Text size={200}>{t('characters.calendar.viewDayNames', { count: props.config.dayNames.length })}</Text>
          <Text size={300}>{props.config.dayNames.join('、')}</Text>
        </>
      ) : null}
      <Text size={200}>{t('characters.calendar.viewFestivals', { count: festivals.length })}</Text>
      <Text size={300}>
        {festivals.length > 0
          ? festivals
              .map(({ day, value }) => t('characters.calendar.festivalItem', { day, name: value }))
              .join('、')
          : t('characters.calendar.viewNoFestivals')}
      </Text>
    </div>
  );
}

/** 折叠头右侧的一行摘要：未配置提示 / 名称·N月×M日·节日数 / 校验失败原因。 */
function CalendarSummary(props: { build: CalendarBuild }) {
  const { t } = useTranslation();
  const build = props.build;
  if (build.kind === 'empty') return <>{t('characters.calendar.unconfigured')}</>;
  if (build.kind === 'invalid') return <>{t(ERROR_KEYS[build.error])}</>;
  const parts = [
    build.config.name ?? null,
    t('characters.calendar.summaryGrid', {
      months: build.config.months.length,
      days: build.config.daysPerMonth,
    }),
    t('characters.calendar.summaryFestivals', {
      count: Object.keys(build.config.festivals ?? {}).length,
    }),
  ].filter((part): part is string => part !== null);
  return <>{parts.join(' · ')}</>;
}

/** 历法折叠区块：状态全部由 useEditorForm 持有（进脏比对与整卡保存），本件纯展示。 */
export function CalendarSection(props: {
  open: boolean;
  onToggle: () => void;
  editing: boolean;
  onEditingChange: (update: (editing: boolean) => boolean) => void;
  fields: CalendarFields;
  build: CalendarBuild;
  onFieldsChange: (update: (current: CalendarFields) => CalendarFields) => void;
  /** 「AI 起草」入口：父级打开起草对话框。 */
  onDraftClick: () => void;
}) {
  const styles = useFieldStyles();
  const { t } = useTranslation();
  // 校验未过不放回查看态：查看态语义是「展示已配置历法」，invalid 退出会把
  // 编辑反馈泄漏成「未配置」假象；行内 alert 已给出原因，禁用完成钮把修正
  // 留在原位（清空全部字段回未配置、或套预设，均可恢复可点，无困死路径）。
  const doneBlocked = props.editing && props.build.kind === 'invalid';

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
          {t('characters.calendar.title')}
        </Text>
        <Text size={200}>
          <CalendarSummary build={props.build} />
        </Text>
      </button>
      {props.open ? (
        <div className={styles.collapseBody}>
          {props.editing ? (
            <>
              <label className={styles.field}>
                <Text size={200}>{t('characters.calendar.preset')}</Text>
                {/* 预设是「填入」动作而非持久选中态：应用后回到占位提示 */}
                <Dropdown
                  value={t('characters.calendar.presetPlaceholder')}
                  selectedOptions={[]}
                  onOptionSelect={(_, data) => {
                    const id = data.optionValue as CalendarPresetId | undefined;
                    if (id !== undefined && id in CALENDAR_PRESETS) {
                      props.onFieldsChange(() => fieldsFromCalendar(CALENDAR_PRESETS[id]));
                    }
                  }}
                  aria-label={t('characters.calendar.preset')}
                >
                  {CALENDAR_PRESET_OPTIONS.map((preset) => (
                    <Option key={preset.id} value={preset.id} text={t(preset.labelKey)}>
                      {t(preset.labelKey)}
                    </Option>
                  ))}
                </Dropdown>
              </label>
              <div className={styles.row}>
                <label className={styles.field}>
                  <Text size={200}>{t('characters.calendar.nameField')}</Text>
                  <Input
                    value={props.fields.name}
                    onChange={(_, d) => props.onFieldsChange((c) => ({ ...c, name: d.value }))}
                    aria-label={t('characters.calendar.nameField')}
                  />
                </label>
                <label className={styles.field}>
                  <Text size={200}>{t('characters.calendar.daysPerMonthField')}</Text>
                  <Input
                    type="number"
                    min={1}
                    max={MAX_DAYS_PER_MONTH}
                    value={props.fields.daysPerMonth}
                    onChange={(_, d) => props.onFieldsChange((c) => ({ ...c, daysPerMonth: d.value }))}
                    aria-label={t('characters.calendar.daysPerMonthField')}
                  />
                </label>
              </div>
              <label className={styles.field}>
                <Text size={200}>{t('characters.calendar.monthsField')}</Text>
                <Textarea
                  rows={4}
                  value={props.fields.months}
                  onChange={(_, d) => props.onFieldsChange((c) => ({ ...c, months: d.value }))}
                  aria-label={t('characters.calendar.monthsField')}
                />
              </label>
              <label className={styles.field}>
                <Text size={200}>{t('characters.calendar.dayNamesField')}</Text>
                <Textarea
                  rows={3}
                  value={props.fields.dayNames}
                  onChange={(_, d) => props.onFieldsChange((c) => ({ ...c, dayNames: d.value }))}
                  aria-label={t('characters.calendar.dayNamesField')}
                />
              </label>
              <label className={styles.field}>
                <Text size={200}>{t('characters.calendar.festivalsField')}</Text>
                <Textarea
                  rows={3}
                  value={props.fields.festivals}
                  onChange={(_, d) => props.onFieldsChange((c) => ({ ...c, festivals: d.value }))}
                  aria-label={t('characters.calendar.festivalsField')}
                />
              </label>
              {props.build.kind === 'invalid' ? (
                <Text role="alert" size={200} className={styles.error}>
                  {t(ERROR_KEYS[props.build.error])}
                </Text>
              ) : null}
            </>
          ) : props.build.kind === 'valid' ? (
            <CalendarDetail config={props.build.config} />
          ) : (
            <Text size={300}>{t('characters.calendar.unconfigured')}</Text>
          )}
          <div className={styles.row}>
            {/* 禁用原因提示：原生 title 对禁用钮不保证显示，Tooltip 可达；
                仅在拦截时挂提示（relationship="label" 注入 aria，会被按钮
                已有 aria-label 优先保留——原 title 行为等价迁移） */}
            {doneBlocked ? (
              <Tooltip content={t('characters.calendar.doneBlocked')} relationship="label">
                <Button
                  appearance="subtle"
                  size="small"
                  icon={props.editing ? <Checkmark20Regular /> : <Edit20Regular />}
                  disabled={doneBlocked}
                  aria-label={props.editing ? t('characters.calendar.done') : t('characters.calendar.edit')}
                  onClick={() => props.onEditingChange((editing) => !editing)}
                >
                  {props.editing ? t('characters.calendar.done') : t('characters.calendar.edit')}
                </Button>
              </Tooltip>
            ) : (
              <Button
                appearance="subtle"
                size="small"
                icon={props.editing ? <Checkmark20Regular /> : <Edit20Regular />}
                disabled={doneBlocked}
                aria-label={props.editing ? t('characters.calendar.done') : t('characters.calendar.edit')}
                onClick={() => props.onEditingChange((editing) => !editing)}
              >
                {props.editing ? t('characters.calendar.done') : t('characters.calendar.edit')}
              </Button>
            )}
            <Button appearance="subtle" size="small" onClick={props.onDraftClick}>
              {t('characters.calendar.draft')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
