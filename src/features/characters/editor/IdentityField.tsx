/**
 * 基础信息分组卡（与 SettingsView 的分组设置卡同一结构件）：名称与称号
 * 两个全宽身份块 + 性别 / 年龄 / 强调色行 + 人设块，块与行间 SettingsDivider。
 *
 * 身份优先层级（2026-09-15 晚间重设计，用户批准的编辑器重排授权）：卡面/
 * 编辑器承载身份，配置退居次位——名称是身份首键，升级为卡内第一行全宽块
 * （aria-label 不变，仅弃 SettingsRow 行形态）；称号与名称同属身份主键，
 * 同比照全宽块（Task-07 修正轮：称号原置于 SettingsRow 的 control 槽，该槽
 * flexShrink:0 且不 grow，width:100% 被内容收缩包裹、chips 多时溢出卡边，
 * 故随名称弃行形态出槽）。该授权有意覆盖同日早前「名称/性别/年龄/称号各行
 * 统一 200px 对齐」定稿，200px 仅保留给性别/年龄两个不抢层级的次级行。
 *
 * 常驻编辑（2026-09-15 重设计，用户定稿）：身份行不再有「展示态⇄编辑态」
 * 整卡会话——旧开关纯展示性（数据在键入时已随修改即保存落库），铅笔/对钩/
 * Esc 还原快照随之裁撤；输入框常驻，与编辑器其余卡（输出动画 / 模型配置）
 * 同款「所见即所改」形态。
 *
 * 称号行（2026-09-15 chip 形态定稿；Task-07 修正轮定型为全宽身份块）：chip
 * 编辑器在 TitlesChips（逐行输入框弃用），装在 titlesBox 内折行，本卡只接线
 * titles 数据流。无可见行标题（比照名称块先例）：读屏可达性由 TitlesChips
 * 自带 role=group + aria-label（称号）与逐枚编辑输入框 aria-label 承担。
 *
 * 人设块独立持有「预览|编辑」切换（2026-09-15 自整卡会话拆出，部分回退
 * 2026-09-13「同一会话」定稿）：默认预览态渲染 markdown（与聊天同语法
 * 语义，MarkdownPreviewBox）；切编辑变多行输入框。多行文本没有 Enter 提交
 * 语义，切回预览即「提交」——落库始终走修改即保存，切换不动数据。空间随
 * 晚间重设计提升：人设是角色卡信息量最大的字段，编辑态 10 行、预览态容器
 * minHeight 200px 兜底。
 */
import { Input, Text, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard, SettingsDivider, SettingsRow } from '../../../components/SettingsCard';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { MarkdownPreviewBox } from '../../../components/MarkdownPreviewBox';
import { AccentColorPicker } from './AccentColorPicker';
import { TitlesChips } from './TitlesChips';

const useStyles = makeStyles({
  // 次级属性行输入宽度：2026-09-15 晚间重设计后仅性别/年龄使用——名称已
  // 升级全宽身份块、称号 chips 容器已放开全宽，200px 只保留给不抢层级的
  // 次级行（该宽度对次级属性仍够用，维持行内紧凑）
  identityInput: {
    width: '200px',
    minWidth: '0px',
  },
  // 全宽身份块（2026-09-15 晚间重设计授权，有意覆盖同日早前「身份行统一
  // 200px 对齐」定稿；Task-07 修正轮称号入列）：名称是身份首键，卡内第一行
  // 全宽置顶；称号与名称同属身份主键，同比照。内距与 SettingsRow 行语言一致，
  // 块后由使用方插 SettingsDivider 与后续行分隔。卡 body 是纵向 flex，块作为
  // 默认 stretch 的 flex 项拉满卡宽，是 titlesBox 百分比宽的可靠解析基准
  identityBlock: {
    display: 'block',
    padding: '12px 20px',
  },
  nameInput: {
    width: '100%',
  },
  // 称号 chip 容器：描边圆角与 Fluent Input 同语言，chips 在盒内折行。
  // width:100% 只在普通块父级（identityBlock）下解析为满行——不可回置
  // SettingsRow 的 control 槽（flexShrink:0 收缩槽会按内容收缩包裹并溢出
  // 卡边，Task-07 修正的缺陷根源）；宽度兜底由 width:100% + 块父级 +
  // flexWrap 折行共同承担，border-box 令描边与内距计入 100% 宽
  titlesBox: {
    display: 'flex',
    boxSizing: 'border-box',
    width: '100%',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: '4px',
    padding: '3px 4px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  // 人设内容区：标题行下的全宽块（渲染预览 / 输入框），随卡面内距；
  // minHeight 兜预览态空间下限（人设是信息量最大的字段，短文也留足版面）
  // ——MarkdownPreviewBox 是 components 共享件（世界编辑器同用），尺寸
  // 下限落在本容器，不动共享件
  personaBody: {
    display: 'block',
    minHeight: '200px',
    padding: '0px 20px 12px',
  },
  // Fluent Textarea 默认不自撑满父容器，显式拉满卡面可用宽
  personaTextarea: {
    width: '100%',
  },
  // 人设「预览|编辑」分段（与覆写行的 modeSegment 同款行语言，两段更窄）
  personaMode: {
    width: '112px',
    minWidth: '0px',
  },
  // 名称必填提示：贴卡面底部内距（自动保存挂起时的就地说明）
  hint: {
    display: 'block',
    padding: '0px 20px 12px',
    marginTop: '-4px',
  },
});

export interface IdentityFieldProps {
  name: string;
  gender: string;
  age: string;
  onNameChange: (value: string) => void;
  onGenderChange: (value: string) => void;
  onAgeChange: (value: string) => void;
  /** 称号集合（0016，展示元数据）：可多个，空项由载荷侧过滤。 */
  titles: string[];
  onTitlesChange: (value: string[]) => void;
  /** 人设（系统提示词，markdown-lite）：预览态渲染 / 编辑态原文。 */
  persona: string;
  onPersonaChange: (value: string) => void;
  /** 强调色（accent_color 语义）：null = 跟随海报派生。 */
  accentColor: string | null;
  /** 基础色（未经修饰）：跟随海报态取色器的显示色。 */
  baseColor: string;
  onAccentColorChange: (value: string | null) => void;
  /** 名称必填校验：false 时卡面底部出必填提示（自动保存挂起在父级）。 */
  canSave: boolean;
}

export function IdentityField(props: IdentityFieldProps) {
  const {
    name,
    gender,
    age,
    onNameChange,
    onGenderChange,
    onAgeChange,
    titles,
    onTitlesChange,
    persona,
    onPersonaChange,
    accentColor,
    baseColor,
    onAccentColorChange,
    canSave,
  } = props;
  const styles = useStyles();
  const { t } = useTranslation();

  // 人设预览 / 编辑是纯视图切换：不参与数据（落库走修改即保存）。
  const [personaEditing, setPersonaEditing] = useState(false);

  return (
    <SettingsCard title={t('characters.sectionBasic')}>
      {/* 名称：全宽身份块置顶（无行标题，aria-label 承担可达性），块后
          SettingsDivider 与次级行分隔 */}
      <div className={styles.identityBlock}>
        <Input
          className={styles.nameInput}
          value={name}
          onChange={(_, d) => onNameChange(d.value)}
          aria-label={t('characters.name')}
        />
      </div>
      <SettingsDivider />
      <SettingsRow
        title={t('characters.genderLabel')}
        control={
          <Input
            className={styles.identityInput}
            value={gender}
            onChange={(_, d) => onGenderChange(d.value)}
            aria-label={t('characters.gender')}
            placeholder={t('characters.genderPlaceholder')}
          />
        }
      />
      <SettingsDivider />
      <SettingsRow
        title={t('characters.ageLabel')}
        control={
          <Input
            className={styles.identityInput}
            value={age}
            onChange={(_, d) => onAgeChange(d.value)}
            aria-label={t('characters.age')}
            placeholder={t('characters.agePlaceholder')}
          />
        }
      />
      <SettingsDivider />
      {/* 称号：全宽身份块（比照名称块，无可见行标题——TitlesChips 自带
          role=group + aria-label 承担可达性）。不可回置 SettingsRow 的
          control 槽：该槽 flexShrink:0 收缩包裹百分比宽，chips 多时溢出
          卡边（Task-07 修正的缺陷根源） */}
      <div className={styles.identityBlock}>
        <div className={styles.titlesBox}>
          <TitlesChips titles={titles} onTitlesChange={onTitlesChange} />
        </div>
      </div>
      <SettingsDivider />
      <SettingsRow
        title={t('characters.accentColor')}
        control={
          <AccentColorPicker
            accentColor={accentColor}
            baseColor={baseColor}
            onChange={onAccentColorChange}
          />
        }
      />
      <SettingsDivider />
      <SettingsRow
        title={t('characters.persona')}
        control={
          <SegmentedControl
            className={styles.personaMode}
            ariaLabel={t('characters.personaViewLabel')}
            value={personaEditing ? 'edit' : 'preview'}
            onChange={(v) => setPersonaEditing(v === 'edit')}
            options={[
              { value: 'preview', label: t('characters.personaModePreview') },
              { value: 'edit', label: t('characters.personaModeEdit') },
            ]}
          />
        }
      />
      <div className={styles.personaBody}>
        {personaEditing ? (
          <Textarea
            className={styles.personaTextarea}
            value={persona}
            rows={10}
            onChange={(_, d) => onPersonaChange(d.value)}
            aria-label={t('characters.persona')}
            placeholder={t('characters.personaPlaceholder')}
          />
        ) : (
          <MarkdownPreviewBox text={persona} hint={t('characters.personaPlaceholder')} />
        )}
      </div>
      {!canSave ? (
        <Text size={200} className={styles.hint}>
          {t('characters.nameRequired')}
        </Text>
      ) : null}
    </SettingsCard>
  );
}
