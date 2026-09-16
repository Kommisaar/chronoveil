/**
 * 角色卡编辑器（2026-09-16 抽屉化定稿：右侧 Drawer 替代原居中 Dialog +
 * 海报分栏）。用户拍板「去掉海报、从侧边弹出」：原 280px 海报栏与 FLIP
 * 共享元素形变随居中对话框一并裁撤，编辑面 = 标题带 + 三张分组设置卡 +
 * 动作行，滑入滑出交给 Fluent 抽屉动效（Smoke 暗蒙层 + Esc + 焦点圈 +
 * 点背板关闭全部内置，替代原自绘毛玻璃背板）。
 *
 * - 强调色即角色主色：表单内色板可改（accent_color 列语义 NULL = 跟随
 *   id 派生），色块亮端取值链在 editor/IdentityField → useEditorForm.live；
 * - 表单逻辑（状态 / 修改即保存 / 模型覆写 / 预览引擎）全部在
 *   editor/useEditorForm，字段级组件在 editor/pieces 与 editor/IdentityField
 *   ——本文件只是排版壳；三张分组设置卡：基础信息（身份行 + 强调色 +
 *   人设）、输出动画（预览 + 动画样式 + 演出参数）、模型配置（模型/温度
 *   覆写）；改动经表单钩子防抖自动落库，本组件在全部关闭路径（背板 /
 *   × / Esc）先 flushSave 补存最后一拍再请求关闭；
 * - 创建流程「先编辑后落库」（2026-09-16 用户拍板）：create 模式（新建
 *   草稿）自动保存全链路静默，动作行为 放弃/保存——保存才创建进列表，
 *   其余一切关闭路径即放弃（详见 props 注释）；历法不属角色卡（2026-09-13
 *   产品裁剪），会话历法在开局向导按会话配置；
 * - 退场契约：open=false 表示「退场中」——滑出动效由 Fluent presence 播放
 *   （medium 档 300ms），本组件留在挂载树，DRAWER_OUT_MS 到点回调 onClosed，
 *   父级才真正卸载；关闭永远有退场，无论哪条路径发起。知情项：Fluent v9
 *   抽屉动效不随 prefers-reduced-motion 降级（框架级取舍，公开 API 无
 *   关闭动效开关），reduced-motion 下仍有滑入滑出。
 * - 自动保存后无「未保存修改」，关闭不再有丢弃确认。
 */
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_RENDER_STYLE,
  DUR_DEFAULT_MS,
  RHYTHM_DEFAULT_MS,
} from '../../engine';
import { THIN_SCROLLBAR } from '../../components/surfaceSpec';
import { SettingsCard, SettingsDivider } from '../../components/SettingsCard';
import { DRAWER_OUT_MS } from '../../components/motion';
import type { CharacterInput, CharacterSummary, ProviderDto } from '../../api/types';
// 全局采样温度缺省值：与 infra/config.rs DEFAULT_TEMPERATURE 同值（0.7）。
// features 之间禁互引（settings/preferences.ts 有同值常量），按互指纪律落本地。
const DEFAULT_TEMPERATURE = 0.7;
// 采样参数三全局缺省（2026-09-16）：与 infra/config.rs 的 DEFAULT_TOP_P（1.0）、
// DEFAULT_FREQUENCY_PENALTY / DEFAULT_PRESENCE_PENALTY（0）同值，互指同上。
const DEFAULT_TOP_P = 1.0;
const DEFAULT_FREQUENCY_PENALTY = 0.0;
const DEFAULT_PRESENCE_PENALTY = 0.0;
import { IdentityField } from './editor/IdentityField';
import { AnimParamRows } from './editor/AnimParamRows';
import type { AnimDefaults } from './editor/useEditorForm';
import { OverrideSection } from './editor/OverrideSection';
import { PerformanceField, useFieldStyles } from './editor/pieces';
import { useEditorForm } from './editor/useEditorForm';

const useStyles = makeStyles({
  // 两栏编辑卡宽度档（2026-09-16 用户定稿）：Fluent size 只有离散档
  //（small 320 / medium 592 / large 940），两栏编辑卡要中间档——覆写
  // --fui-Drawer--size 变量：抽屉宽度与滑入/滑出位移都读该变量，一处覆盖
  // 两处生效；动效时长按 size=medium 档 300ms 计（DRAWER_OUT_MS 与宽度无关）。
  // 宽度锚（2026-09-16 用户定稿收窄）：单栏卡 540，抽屉 = 2×540 + 栏距 16
  // + 主体左右边距 32 = 1128；min() 兜底窄视口不溢出（旧对话框同法，
  // 桌面壳 minWidth 960 时收缩为 vw-48）。
  drawer: {
    '--fui-Drawer--size': 'min(1128px, calc(100vw - 48px))',
  },
  // 标题带下界线框出表单带（用色走 SettingsDivider 同款 stroke2，全仓分隔线
  // 单一用色）。水平内缩覆盖 Fluent 默认 XXL(24) 为 16，与主体沟槽同档
  //（紧凑档，2026-09-16 用户定稿）；竖向保留默认节奏（24 顶 / 8 底）
  header: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalS}`,
  },
  body: {
    // 全抽屉统一 16px 沟槽（行距 = 栏距 = 边距 = header/footer 水平内缩，
    // 2026-09-16 用户定稿紧凑档）
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
    // 溢出滚动带的细滚动条：规格单一事实源见 surfaceSpec 的 THIN_SCROLLBAR
    //（消费点互指清单在该处；默认粗滚动条在抽屉右缘太重）
    ...THIN_SCROLLBAR,
  },
  form: {
    // 两栏编辑卡（2026-09-16 用户定稿）：基础信息 | 输出动画 | 模型配置
    // 依次落格（模型配置在左栏基础信息下方，不占全宽）。alignItems start：
    // 各卡按内容自然高，短卡不被拉出卡内空白。行距/栏距统一 16px（见 body 注）。
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    alignItems: 'start',
    rowGap: tokens.spacingVerticalL,
    columnGap: tokens.spacingHorizontalL,
  },
  col: {
    // 列栈（见 body 处「左列」注）：列内卡片纵排，间距 = 全抽屉沟槽；
    // minWidth 0 防长内容把列撑破栅格
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    minWidth: 0,
  },
  // 动作行上界线（与 header 下界线成对）。水平内缩与 header 同步覆盖为 16；
  // 竖向保留默认节奏（16 顶 / 24 底）
  footer: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalXXL}`,
  },
  // 动作行左钮钉左端（marginRight:auto 把后续钮推到右端）：edit 模式导出贴
  // 左、删除落最右端；create 模式保存贴左、放弃落最右端（2026-09-16 用户
  // 拍板）——同一锚类复用
  pinLeft: {
    marginRight: 'auto',
  },
  // 覆写下拉区的配置加载失败文案（Task-14）：水平内距对齐 OverrideSection
  // 的 cardBody（'0px 20px 12px'，见 editor/pieces useFieldStyles.cardBody）
  providersError: {
    padding: '0px 20px 12px',
    color: tokens.colorPaletteRedForeground1,
  },
});

export interface CharacterEditorDrawerProps {
  /** 编辑模式（2026-09-16 创建流程改「先编辑后落库」）：edit = 编辑既有卡
   *  （修改即保存 + 删除/导出动作行）；create = 新建草稿（character 为父级
   *  构造的空草稿，id 0——自动保存全链路静默，动作行为 放弃/保存，保存经
   *  onCreate 一次性落库，其余一切关闭路径即放弃）。 */
  mode: 'create' | 'edit';
  /** 编辑目标（全量字段预填，含 persona / 模型覆写三扁平字段）；create 模式
   *  传空草稿（父级 newDraftCharacter）。 */
  character: CharacterSummary;
  /** 可见性：false 时本组件留挂载树播抽屉退场，到点回调 onClosed。 */
  open: boolean;
  /** 抽屉退场播完（DRAWER_OUT_MS）后回调；父级据此真正卸载本组件。 */
  onClosed: () => void;
  /** providers 下拉数据源（getConfig 的 providers）。 */
  providers: ProviderDto[];
  /** 全局配置加载失败的降级文案（Task-14，父组件设置；null = 未失败）：
      就地落在「模型配置」卡（覆写下拉区域），与「未配置 provider」的
      空列表可区分——空列表不设此 prop。 */
  providersError?: string | null;
  /** 演出参数「跟随全局」基准（全局配置派生）；缺省回落模板默认。 */
  animDefaults?: AnimDefaults | undefined;
  /** 保存失败的行内错误文案（父组件设置）。 */
  errorText: string | null;
  /** 修改即保存的上送出口（父级落库 + refresh + 错误就地展示；仅 edit 模式）。 */
  onAutosave: (input: CharacterInput) => Promise<void>;
  /** 创建出口（仅 create 模式「保存」）：父级落库 + refresh；失败就地红字
   *  并上抛——本组件保持打开（契约同 onAutosave），成功后自行请求关闭。 */
  onCreate: (input: CharacterInput) => Promise<void>;
  /** 关闭请求（背板 / × / Esc）：edit 模式先 flushSave 补存最后一拍；
   *  create 模式即放弃（草稿不落库）。 */
  onClose: () => void;
  /** 删除按钮（仅 edit 模式）：父组件弹就地确认对话框，本组件不直接删。 */
  onDelete: (character: CharacterSummary) => void;
  /** 导出按钮（动作行删除旁，2026-09-16 自卡内角标菜单移此；仅 edit 模式）：
   *  父组件走导出对话框，成功/取消静默，真错误由父级就地红字；本组件不直接导出。 */
  onExport: (character: CharacterSummary) => void;
}

export function CharacterEditorDrawer(props: CharacterEditorDrawerProps) {
  const {
    mode,
    character,
    open,
    onClosed,
    providers,
    providersError,
    animDefaults,
    errorText,
    onAutosave,
    onCreate,
    onClose,
    onDelete,
    onExport,
  } = props;
  const styles = useStyles();
  const field = useFieldStyles();
  const { t } = useTranslation();
  const form = useEditorForm({
    character,
    onAutosave,
    autosave: mode === 'edit',
    animDefaults,
  });
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
              aria-label={t('characters.close')}
              onClick={requestClose}
            />
          }
        >
          {t(mode === 'create' ? 'characters.new' : 'characters.editTitle')}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>
        <div className={styles.form}>
          {/* 左列（col 栈）：基础信息 + 模型配置。不用 grid 行排布的原因：
              右列输出动画卡更高，grid 第二行从它底边起算，左列两卡之间会被
              拉出 >24px 的视觉缝（2026-09-16 用户指出间隙不齐）——独立列栈
              让列内间距恒等于全抽屉沟槽 24px。 */}
          <div className={styles.col}>
            <IdentityField
              name={form.name}
              gender={form.gender}
              age={form.age}
              onNameChange={form.setName}
              onGenderChange={form.setGender}
              onAgeChange={form.setAge}
              titles={form.titles}
              onTitlesChange={form.setTitles}
              persona={form.persona}
              onPersonaChange={form.setPersona}
              accentColor={form.accentColor}
              baseColor={form.live.baseColor}
              onAccentColorChange={form.setAccentColor}
              canSave={form.canSave}
            />
            {/* 模型配置卡落左栏（2026-09-16 用户定稿：底部卡不占全宽）：
                单栏 540，模型/温度行的控件簇（级联钮 160 + 分段 136 +
                间距）单行放得下。 */}
            <SettingsCard title={t('characters.sectionOther')}>
              <OverrideSection
                modelProviderId={form.modelProviderId}
                modelName={form.modelName}
                modelTemperature={form.modelTemperature}
                modelTopP={form.modelTopP}
                onTopPChange={form.setModelTopP}
                modelFrequencyPenalty={form.modelFrequencyPenalty}
                onFrequencyPenaltyChange={form.setModelFrequencyPenalty}
                modelPresencePenalty={form.modelPresencePenalty}
                onPresencePenaltyChange={form.setModelPresencePenalty}
                onModelOverrideChange={(providerId, modelName) => {
                  form.setModelProviderId(providerId);
                  form.setModelName(modelName);
                }}
                onTemperatureChange={form.setModelTemperature}
                providers={providers}
                globalTemperature={animDefaults?.temperature ?? DEFAULT_TEMPERATURE}
                globalTopP={animDefaults?.topP ?? DEFAULT_TOP_P}
                globalFrequencyPenalty={animDefaults?.frequencyPenalty ?? DEFAULT_FREQUENCY_PENALTY}
                globalPresencePenalty={animDefaults?.presencePenalty ?? DEFAULT_PRESENCE_PENALTY}
                globalProviderId={animDefaults?.defaultProviderId ?? ''}
                globalModelId={animDefaults?.defaultModelId ?? ''}
              />
              {/* 全局配置加载失败的降级信号（Task-14）：信号落点即受影响
                  的覆写下拉所在卡；不用 errorText 通道（那是保存/删除失败
                  的语义，混入会互相覆盖）。 */}
              {providersError ? (
                <Text role="alert" size={200} className={styles.providersError}>
                  {providersError}
                </Text>
              ) : null}
            </SettingsCard>
          </div>
          {/* 右列：输出动画卡（2026-09-13 用户定稿独立成卡）：行 1 预览、
              行 2 动画样式（风格下拉 + 预览动画）、行 3–5 演出参数（卡可
              覆写，留空跟随全局）。 */}
          <div className={styles.col}>
            <SettingsCard title={t('characters.sectionAnim')}>
              <PerformanceField
                renderStyle={form.renderStyle}
                onStyleChange={form.setRenderStyle}
                globalStyle={animDefaults?.renderStyle ?? DEFAULT_RENDER_STYLE}
                onPlay={form.playPreview}
                previewRef={form.previewRef}
                previewed={form.previewed}
              />
              <SettingsDivider />
              <AnimParamRows
                durationMs={form.animDurationMs}
                rhythmMs={form.animRhythmMs}
                punctPause={form.animPunctPause}
                defaults={
                  animDefaults ?? {
                    durationMs: DUR_DEFAULT_MS,
                    msPerChar: RHYTHM_DEFAULT_MS,
                    punctPause: true,
                    renderStyle: DEFAULT_RENDER_STYLE,
                    temperature: DEFAULT_TEMPERATURE,
                    topP: DEFAULT_TOP_P,
                    frequencyPenalty: DEFAULT_FREQUENCY_PENALTY,
                    presencePenalty: DEFAULT_PRESENCE_PENALTY,
                    defaultProviderId: '',
                    defaultModelId: '',
                  }
                }
                onDurationChange={form.setAnimDurationMs}
                onRhythmChange={form.setAnimRhythmMs}
                onPunctChange={form.setAnimPunctPause}
              />
            </SettingsCard>
          </div>
          {errorText ? (
            <Text role="alert" size={200} className={field.error}>
              {errorText}
            </Text>
          ) : null}
        </div>
      </DrawerBody>
      <DrawerFooter className={styles.footer}>
        {mode === 'create' ? (
          <>
            {/* 保存贴左端（marginRight:auto 把放弃推到最右端，2026-09-16
                用户拍板）；放弃即丢弃草稿不落库，与背板/× 同语义 */}
            <Button
              className={styles.pinLeft}
              appearance="primary"
              disabled={!form.canSave || saving}
              onClick={handleSave}
            >
              {t('characters.save')}
            </Button>
            <Button disabled={saving} onClick={requestClose}>
              {t('characters.discard')}
            </Button>
          </>
        ) : (
          <>
            {/* 导出贴左端（marginRight:auto 把删除推到最右端），2026-09-16 用户拍板 */}
            <Button className={styles.pinLeft} onClick={() => onExport(character)}>
              {t('characters.export')}
            </Button>
            <Button onClick={() => onDelete(character)}>
              {t('characters.delete')}
            </Button>
          </>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
