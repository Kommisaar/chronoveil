/**
 * 世界卡编辑器（0017 世界卡特性，排版形态对齐仓库既有惯例）：
 * 标准 Fluent 模态 Dialog（同 NewSessionDialog / ConfirmDialog 的简单档，
 * 不做角色编辑器的海报 + FLIP 形变——世界卡无海报 / 强调色 / 演出参数，
 * 简单档够用）+ 右侧三张分组设置卡（SettingsCard 结构件）：
 * ① 基础信息：名称（必填，空名时自动保存挂起并出提示）；
 * ② 世界观：markdown-lite 正文，独立「预览|编辑」视图切换（同人设块 /
 *    全局系统提示词块的既有形态：预览态 MarkdownPreviewBox 渲染，编辑态
 *    Textarea；切换是纯视图语义，落库始终走修改即保存）；
 * ③ 历法：五选单选（默认数字历 + 四内置预设，常量单一事实源在
 *    components/calendarPresets）+ 选中项静态样例行（不与
 *    fiction_time::date_label 双写实时换算）。
 *
 * 修改即保存（无取消/保存按钮）：表单逻辑在 useWorldForm（600ms 防抖 +
 * 串行链 + 纠正拍），本文件只是排版壳；全部关闭路径（× / Esc / 背板）经
 * requestClose 先 flushSave 补存最后一拍再回调 onClose。新建由父级「先落库
 * 再进编辑」——本组件只服务编辑既有卡。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Radio,
  RadioGroup,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CALENDAR_PRESET_OPTIONS,
  type CalendarPresetId,
} from '../../components/calendarPresets';
import { MarkdownPreviewBox } from '../../components/MarkdownPreviewBox';
import { SegmentedControl } from '../../components/SegmentedControl';
import { SettingsCard, SettingsRow } from '../../components/SettingsCard';
import type { WorldInput, WorldSummary } from '../../api/types';
import type { PresetKey } from './useWorldForm';
import { useWorldForm } from './useWorldForm';

/** 选中预设的静态样例行（预设常量自带说明文本，i18n key）。 */
const SAMPLE_KEYS: Record<CalendarPresetId, string> = {
  modern: 'worlds.sampleModern',
  seven: 'worlds.sampleSeven',
  ganzhi: 'worlds.sampleGanzhi',
  fantasy: 'worlds.sampleFantasy',
};

const useStyles = makeStyles({
  // 世界编辑器无海报列，单列窄面板（同款坑位备忘：Fluent DialogSurface 自带
  // max-width 600px，这里就是要窄，不覆写）
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    minWidth: '480px',
    maxWidth: '100%',
  },
  nameInput: {
    width: '200px',
    minWidth: '0px',
  },
  worldbookMode: {
    width: '112px',
    minWidth: '0px',
  },
  worldbookBody: {
    display: 'block',
    padding: '0px 20px 12px',
  },
  worldbookTextarea: {
    width: '100%',
  },
  calendarBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: '12px 20px',
  },
  sample: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'pre-wrap',
  },
  hint: {
    display: 'block',
    padding: '0px 20px 12px',
    marginTop: '-4px',
  },
  deleteAction: {
    marginRight: 'auto',
  },
});

export interface WorldEditorDialogProps {
  /** 编辑目标（全量字段预填：WorldSummary 即编辑数据源，无单条查询）。 */
  world: WorldSummary;
  /** 保存失败的行内错误文案（父组件设置）。 */
  errorText: string | null;
  /** 修改即保存的上送出口（父级落库 + refresh + 错误就地展示）。 */
  onAutosave: (input: WorldInput) => Promise<void>;
  /** 关闭请求（× / Esc / 背板）：本组件先 flushSave 补存最后一拍。 */
  onClose: () => void;
  /** 删除按钮：父组件弹就地确认对话框，本组件不直接删。 */
  onDelete: (world: WorldSummary) => void;
}

export function WorldEditorDialog(props: WorldEditorDialogProps) {
  const { world, errorText, onAutosave, onClose, onDelete } = props;
  const styles = useStyles();
  const { t } = useTranslation();
  const form = useWorldForm({ world, onAutosave });

  // 世界观预览 / 编辑是纯视图切换：不参与数据（落库走修改即保存）。
  const [worldbookEditing, setWorldbookEditing] = useState(false);

  // 全部关闭路径共用：先补存最后一拍（无在途防抖即 no-op），再请求关闭。
  const requestClose = (): void => {
    form.flushSave();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(_, data) => {
        // × / Esc / 背板关闭：先补存最后一拍，再走父级关闭。
        if (!data.open) requestClose();
      }}
    >
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>{t('worlds.editTitle')}</DialogTitle>
          <DialogContent className={styles.content}>
            <SettingsCard title={t('worlds.sectionBasic')}>
              <SettingsRow
                title={t('worlds.nameLabel')}
                control={
                  <Input
                    className={styles.nameInput}
                    value={form.name}
                    onChange={(_, d) => form.setName(d.value)}
                    aria-label={t('worlds.name')}
                  />
                }
              />
              {!form.canSave ? (
                <Text size={200} className={styles.hint}>
                  {t('worlds.nameRequired')}
                </Text>
              ) : null}
            </SettingsCard>
            <SettingsCard title={t('worlds.worldbook')}>
              <SettingsRow
                title={t('worlds.worldbook')}
                control={
                  <SegmentedControl
                    className={styles.worldbookMode}
                    ariaLabel={t('worlds.worldbookViewLabel')}
                    value={worldbookEditing ? 'edit' : 'preview'}
                    onChange={(v) => setWorldbookEditing(v === 'edit')}
                    options={[
                      { value: 'preview', label: t('worlds.modePreview') },
                      { value: 'edit', label: t('worlds.modeEdit') },
                    ]}
                  />
                }
              />
              <div className={styles.worldbookBody}>
                {worldbookEditing ? (
                  <Textarea
                    className={styles.worldbookTextarea}
                    value={form.worldbook}
                    rows={8}
                    onChange={(_, d) => form.setWorldbook(d.value)}
                    aria-label={t('worlds.worldbook')}
                    placeholder={t('worlds.worldbookPlaceholder')}
                  />
                ) : (
                  <MarkdownPreviewBox
                    text={form.worldbook}
                    hint={t('worlds.worldbookPlaceholder')}
                  />
                )}
              </div>
            </SettingsCard>
            <SettingsCard title={t('worlds.calendar')}>
              <div className={styles.calendarBody}>
                <RadioGroup
                  value={form.preset}
                  onChange={(_, data) => form.setPreset(data.value as PresetKey)}
                  aria-label={t('worlds.calendar')}
                >
                  <Radio value="default" label={t('worlds.presetDefault')} />
                  {CALENDAR_PRESET_OPTIONS.map(({ id, labelKey }) => (
                    <Radio key={id} value={id} label={t(labelKey)} />
                  ))}
                </RadioGroup>
                <Text size={200} className={styles.sample}>
                  {form.preset === 'default'
                    ? t('worlds.sampleDefault')
                    : t(SAMPLE_KEYS[form.preset])}
                </Text>
              </div>
            </SettingsCard>
            {errorText ? (
              <Text role="alert" size={200}>
                {errorText}
              </Text>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button className={styles.deleteAction} onClick={() => onDelete(world)}>
              {t('worlds.delete')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
