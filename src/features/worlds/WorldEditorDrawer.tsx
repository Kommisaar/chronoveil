/**
 * 世界卡编辑器（2026-09-16 抽屉化定稿：右侧 Drawer 替代原居中 Dialog +
 * 世界色画布分栏，与角色编辑器同拍改造——用户拍板「去掉海报/画布、
 * 从侧边弹出」）。世界观为主角：编辑态 12 行 textarea，预览态
 * MarkdownPreviewBox；历法五选一（默认数字历 + 四内置预设）。
 *
 * - 壳形态学自 CharacterEditorDrawer（features 禁互引，worlds 域内自建；
 *   两处以内不提取公共编辑器壳）：Smoke 暗蒙层 + Esc + 焦点圈 + 点背板
 *   关闭全部由 Fluent 抽屉内置（替代原自绘毛玻璃背板与 FLIP 形变）；
 * - 修改即保存（无取消/保存按钮，仅 edit 模式）：表单逻辑在 useWorldForm
 *   （600ms 防抖 + 串行链 + 纠正拍），本文件只是排版壳；edit 模式全部关闭
 *   路径（× / Esc / 背板）经 requestClose 先 flushSave 补存最后一拍再回调
 *   onClose；2026-09-16 创建流程改「先编辑后落库」（用户拍板，与角色编辑器
 *   同构）：create 模式（新建草稿）自动保存全链路静默，动作行为 放弃/保存
 *   ——保存经 onCreate 一次性落库，其余一切关闭路径即放弃；
 * - 退场契约：open=false 表示「退场中」——滑出动效由 Fluent presence 播放
 *   （medium 档 300ms），本组件留在挂载树，DRAWER_OUT_MS 到点回调 onClosed，
 *   父级才真正卸载；因此关闭永远有退场，无论哪条路径发起（含软删：父级先
 *   置 open=false，卸载等 onClosed）。知情项：Fluent v9 抽屉动效不随
 *   prefers-reduced-motion 降级（框架级取舍，公开 API 无关闭动效开关）。
 */
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Input,
  Radio,
  RadioGroup,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CALENDAR_PRESET_OPTIONS,
  type CalendarPresetId,
} from '../../components/calendarPresets';
import { DRAWER_OUT_MS } from '../../components/motion';
import { MarkdownPreviewBox } from '../../components/MarkdownPreviewBox';
import { SegmentedControl } from '../../components/SegmentedControl';
import { SettingsCard, SettingsRow } from '../../components/SettingsCard';
import { THIN_SCROLLBAR } from '../../components/surfaceSpec';
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
  // 两栏编辑卡宽度档（2026-09-16 用户定稿，与角色编辑器同构）：Fluent size
  // 只有离散档（small 320 / medium 592 / large 940），两栏编辑卡要中间档——
  // 覆写 --fui-Drawer--size 变量：抽屉宽度与滑入/滑出位移都读该变量，一处
  // 覆盖两处生效；动效时长按 size=medium 档 300ms 计（DRAWER_OUT_MS 与宽度无关）。
  // 宽度锚随角色编辑器统一 1128（单栏 540 + 栏距 16 + 主体左右边距 32，
  // 两页抽屉同宽避免漂移；旧世界面板 720 = 画布 220 + 表单卡 500——本侧
  // 内容是单选/文本，540 栏足够）；min() 兜底窄视口不溢出（旧对话框同法）。
  drawer: {
    '--fui-Drawer--size': 'min(1128px, calc(100vw - 48px))',
  },
  // 标题带下界线 / 动作行上界线框出表单带（用色走 SettingsDivider 同款
  // stroke2，全仓分隔线单一用色）。水平内缩覆盖 Fluent 默认 XXL(24) 为 16，
  // 与主体沟槽同档（紧凑档，2026-09-16 用户定稿）；竖向保留默认节奏
  header: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalS}`,
  },
  body: {
    // 全抽屉统一 16px 沟槽（行距 = 栏距 = 边距 = header/footer 水平内缩，
    // 与角色编辑器同构，2026-09-16 用户定稿紧凑档）
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
    // 溢出滚动带的细滚动条：规格单一事实源见 surfaceSpec 的 THIN_SCROLLBAR
    ...THIN_SCROLLBAR,
  },
  form: {
    // 两栏编辑卡（2026-09-16 用户定稿，与角色编辑器同构）：基础信息 |
    // 历法 并排，世界观跨两栏收底——世界观是主角（2026-09-15 升档），
    // 预览/编辑态都保留整幅宽度。alignItems start：各卡按内容自然高。
    // 行距/栏距统一 16px（见 body 注）。
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    alignItems: 'start',
    rowGap: tokens.spacingVerticalL,
    columnGap: tokens.spacingHorizontalL,
  },
  cellFull: {
    gridColumn: '1 / -1',
  },
  // 动作行上界线（与 header 下界线成对）。水平内缩与 header 同步覆盖为 16；
  // 竖向保留默认节奏（16 顶 / 24 底）
  footer: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalXXL}`,
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
  // 预览态外层恒定 minHeight：空世界观/短文时预览卡不塌缩，编辑↔预览切换
  // 高度稳定（共享件 MarkdownPreviewBox 本身不改）
  worldbookPreview: {
    minHeight: '200px',
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
  // 左钮钉动作行左端（marginRight:auto 把后续钮推到右端）：create 模式挂保存
  //（保存贴左、放弃落最右端）；edit 模式删除单钮挂 pinRight
  //（marginLeft:auto）钉最右端——两档与角色编辑器同构（2026-09-16 用户拍板）
  pinLeft: {
    marginRight: 'auto',
  },
  pinRight: {
    marginLeft: 'auto',
  },
});

export interface WorldEditorDrawerProps {
  /** 编辑模式（2026-09-16 创建流程改「先编辑后落库」，与角色编辑器同构）：
   *  edit = 编辑既有卡（修改即保存 + 删除动作行）；create = 新建草稿
   *  （world 为父级构造的空草稿——自动保存全链路静默，动作行为 放弃/保存，
   *  保存经 onCreate 一次性落库，其余一切关闭路径即放弃）。 */
  mode: 'create' | 'edit';
  /** 编辑目标（全量字段预填：WorldSummary 即编辑数据源，无单条查询）；
   *  create 模式传空草稿（父级 newDraftWorld）。 */
  world: WorldSummary;
  /** 可见性：false 时本组件留挂载树播抽屉退场，到点回调 onClosed。 */
  open: boolean;
  /** 抽屉退场播完（DRAWER_OUT_MS）后回调；父级据此真正卸载本组件。 */
  onClosed: () => void;
  /** 保存失败的行内错误文案（父组件设置）。 */
  errorText: string | null;
  /** 修改即保存的上送出口（父级落库 + refresh + 错误就地展示；仅 edit 模式）。 */
  onAutosave: (input: WorldInput) => Promise<void>;
  /** 创建出口（仅 create 模式「保存」）：父级落库 + refresh；失败就地红字
   *  并上抛——本组件保持打开（契约同 onAutosave），成功后自行请求关闭。 */
  onCreate: (input: WorldInput) => Promise<void>;
  /** 关闭请求（× / Esc / 背板）：edit 模式先 flushSave 补存最后一拍；
   *  create 模式即放弃（草稿不落库）。 */
  onClose: () => void;
  /** 删除按钮（仅 edit 模式）：父组件弹就地确认对话框，本组件不直接删。 */
  onDelete: (world: WorldSummary) => void;
}

export function WorldEditorDrawer(props: WorldEditorDrawerProps) {
  const {
    mode,
    world,
    open,
    onClosed,
    errorText,
    onAutosave,
    onCreate,
    onClose,
    onDelete,
  } = props;
  const styles = useStyles();
  const { t } = useTranslation();
  const form = useWorldForm({ world, onAutosave, autosave: mode === 'edit' });
  // 世界观预览 / 编辑是纯视图切换：不参与数据（落库走修改即保存）。
  const [worldbookEditing, setWorldbookEditing] = useState(false);
  // 创建在途标记（create 模式）：保存点击后禁用动作行防双击；失败复位保持打开。
  const [saving, setSaving] = useState(false);
  // open 的 latest-ref：退场定时器到点时复核现值（见下方 effect 注释）。
  const openRef = useRef(open);
  openRef.current = open;

  // 退场契约（见文件头）：open=false 起定时器，等 Fluent 抽屉滑出播完再让
  // 父级卸载；onClosed 随父级渲染换身份，依赖随行（提前卸载 = 计时器清理，
  // 无悬挂回调）。
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      // 退场窗口内的重开竞态豁免：React 的 passive effect 清理（本定时器的
      // 取消）异步落盘，open 翻 true 的提交与清理之间有一个宏任务缝——到点时
      // 以 ref 现值复核，父级已重开（换绑新目标）则放弃本次 onClosed。
      if (!openRef.current) onClosed();
    }, DRAWER_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onClosed]);

  // 全部关闭路径共用：edit 先补存最后一拍（无在途防抖即 no-op）；create 即
  // 放弃（草稿不落库，与动作行「放弃」同语义）。
  const requestClose = (): void => {
    if (mode === 'edit') form.flushSave();
    onClose();
  };

  /** 保存（create 模式动作）：整卡载荷一次性创建；成功即请求关闭（卡片经
   *  父级 refresh 进列表），失败保持打开（错误由父级就地红字，契约同
   *  onAutosave 上抛）。 */
  const handleSave = (): void => {
    if (!form.canSave || saving) return;
    setSaving(true);
    onCreate(form.buildInput())
      .then(() => onClose())
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  return (
    <Drawer
      className={styles.drawer}
      open={open}
      position="end"
      size="medium"
      modalType="modal"
      onOpenChange={(_, data) => {
        // ×（动作插槽）/ Esc / 背板：先补存最后一拍，再走父级关闭。
        if (!data.open) requestClose();
      }}
    >
      <DrawerHeader className={styles.header}>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label={t('worlds.close')}
              onClick={requestClose}
            />
          }
        >
          {t(mode === 'create' ? 'worlds.new' : 'worlds.editTitle')}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>
        <div className={styles.form}>
          {/* 基础信息卡：名称必填，空名时自动保存挂起并出提示。两栏布局左列。 */}
          <div>
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
          </div>
          {/* 历法卡：五选单选（默认数字历 + 四内置预设，常量单一事实源
              在 components/calendarPresets）+ 选中项静态样例行（不与
              fiction_time::date_label 双写实时换算）。两栏布局右列。 */}
          <div>
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
          </div>
          {/* 世界观卡（主角，2026-09-15 用户定稿升档）跨两栏收底：预览|编辑
              切换，编辑态 12 行、预览态 minHeight 200——世界观是世界的灵魂，
              给足篇幅（两栏卡定稿后仍保留整幅宽度）。切换是纯视图语义，
              落库始终走修改即保存。 */}
          <div className={styles.cellFull}>
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
                    rows={12}
                    onChange={(_, d) => form.setWorldbook(d.value)}
                    aria-label={t('worlds.worldbook')}
                    placeholder={t('worlds.worldbookPlaceholder')}
                  />
                ) : (
                  <div className={styles.worldbookPreview}>
                    <MarkdownPreviewBox
                      text={form.worldbook}
                      hint={t('worlds.worldbookPlaceholder')}
                    />
                  </div>
                )}
              </div>
            </SettingsCard>
          </div>
          {errorText ? (
            <Text role="alert" size={200}>
              {errorText}
            </Text>
          ) : null}
        </div>
      </DrawerBody>
      <DrawerFooter className={styles.footer}>
        {mode === 'create' ? (
          <>
            {/* 保存贴左端（pinLeft 锚把放弃推到最右端，2026-09-16 用户
                拍板）；放弃即丢弃草稿不落库，与背板/× 同语义 */}
            <Button
              className={styles.pinLeft}
              appearance="primary"
              disabled={!form.canSave || saving}
              onClick={handleSave}
            >
              {t('worlds.save')}
            </Button>
            <Button disabled={saving} onClick={requestClose}>
              {t('worlds.discard')}
            </Button>
          </>
        ) : (
          <Button className={styles.pinRight} onClick={() => onDelete(world)}>
            {t('worlds.delete')}
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
