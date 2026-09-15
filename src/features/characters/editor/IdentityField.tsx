/**
 * 基础信息分组卡（与 SettingsView 的分组设置卡同一结构件，一个配置项一行）：
 * 名称 / 性别 / 年龄 / 称号 / 强调色五行 + 人设块，行间 SettingsDivider。
 *
 * 常驻编辑（2026-09-15 重设计，用户定稿）：身份行不再有「展示态⇄编辑态」
 * 整卡会话——旧开关纯展示性（数据在键入时已随修改即保存落库），铅笔/对钩/
 * Esc 还原快照随之裁撤；输入框常驻，与编辑器其余卡（输出动画 / 模型配置）
 * 同款「所见即所改」形态。
 *
 * 人设块独立持有「预览|编辑」切换（2026-09-15 自整卡会话拆出，部分回退
 * 2026-09-13「同一会话」定稿）：默认预览态渲染 markdown（与聊天同语法
 * 语义，PersonaPreviewBox）；切编辑变多行输入框。多行文本没有 Enter 提交
 * 语义，切回预览即「提交」——落库始终走修改即保存，切换不动数据。
 */
import { Button, Input, Text, Textarea, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Add20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { SettingsCard, SettingsDivider, SettingsRow } from '../../../components/SettingsCard';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { AccentColorPicker } from './AccentColorPicker';
import { PersonaPreviewBox } from './pieces';

const useStyles = makeStyles({
  // 身份行输入统一宽度（2026-09-15 用户定稿：名称/性别/年龄/称号各行对齐，
  // 不再按字段长短分档）
  identityInput: {
    width: '200px',
    minWidth: '0px',
  },
  // 人设内容区：标题行下的全宽块（渲染预览 / 输入框），随卡面内距
  personaBody: {
    display: 'block',
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
  // 称号行：逐行输入竖排（行 = Input + 删除钮，底部添加钮）
  titlesControl: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalS,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
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
      <SettingsRow
        title={t('characters.nameLabel')}
        control={
          <Input
            className={styles.identityInput}
            value={name}
            onChange={(_, d) => onNameChange(d.value)}
            aria-label={t('characters.name')}
          />
        }
      />
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
      <SettingsRow
        title={t('characters.titleLabel')}
        control={
          <div className={styles.titlesControl}>
            {titles.map((title, index) => (
              <div key={index} className={styles.titleRow}>
                <Input
                  className={styles.identityInput}
                  value={title}
                  onChange={(_, d) =>
                    onTitlesChange(titles.map((v, j) => (j === index ? d.value : v)))
                  }
                  aria-label={`${t('characters.characterTitle')} ${index + 1}`}
                  placeholder={t('characters.titlePlaceholder')}
                />
                <Tooltip content={t('characters.titleRemove')} relationship="label">
                  <Button
                    appearance="subtle"
                    size="small"
                    aria-label={t('characters.titleRemove')}
                    icon={<Dismiss20Regular />}
                    onClick={() => onTitlesChange(titles.filter((_, j) => j !== index))}
                  />
                </Tooltip>
              </div>
            ))}
            <Button
              appearance="transparent"
              size="small"
              icon={<Add20Regular />}
              onClick={() => onTitlesChange([...titles, ''])}
            >
              {t('characters.titleAdd')}
            </Button>
          </div>
        }
      />
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
            rows={4}
            onChange={(_, d) => onPersonaChange(d.value)}
            aria-label={t('characters.persona')}
            placeholder={t('characters.personaPlaceholder')}
          />
        ) : (
          <PersonaPreviewBox text={persona} />
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
