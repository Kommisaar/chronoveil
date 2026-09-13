/**
 * 基础信息分组卡（与 SettingsView 的分组设置卡同一结构件，一个配置项一行）：
 * 名称 / 性别 / 年龄 / 强调色四行 + 人设块，行间 SettingsDivider。
 *
 * 编辑会话由卡片标题栏右侧的统一按钮控制（2026-09-13 用户定稿：人设不再
 * 单独挂切换钮，保存/取消与身份行同一会话）：展示态默认文本，点铅笔进编
 * 辑态——名称 / 性别 / 年龄变输入框、人设变多行输入框（拉满卡面宽），
 * Enter 或标题栏对钩提交回展示态，Esc 还原进编辑前的值（含人设）。刻意
 * 不做失焦提交：Fluent 的焦点管理（tabster）会在开面板时挪走焦点，blur 一
 * 触发就把编辑态弹回展示态；落库仍走修改即保存（随键入自动保存），提交/
 * 取消只切换展示形态，取消的回写会命中「与已存值一致」的防抖跳过。
 *
 * 人设（2026-09-10）：展示态 markdown 渲染（与聊天同语法语义）；多行文本
 * 没有 Enter 提交语义，编辑态的收起只走标题栏按钮。
 */
import { Button, Input, Text, Textarea, Tooltip, makeStyles } from '@fluentui/react-components';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit20Regular, Checkmark20Regular } from '@fluentui/react-icons';
import { SettingsCard, SettingsDivider, SettingsRow } from '../../../components/SettingsCard';
import { AccentColorPicker } from './AccentColorPicker';
import { PersonaPreviewBox } from './pieces';

const useStyles = makeStyles({
  nameInput: {
    width: '200px',
    minWidth: '0px',
  },
  // 性别 / 年龄行内输入：短宽度
  metaInput: {
    width: '96px',
    minWidth: '0px',
  },
  ageInput: {
    width: '72px',
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
  /** 人设（系统提示词，markdown-lite）：展示态渲染 / 编辑态原文。 */
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
    persona,
    onPersonaChange,
    accentColor,
    baseColor,
    onAccentColorChange,
    canSave,
  } = props;
  const styles = useStyles();
  const { t } = useTranslation();

  // 编辑既有卡恒以展示态起步（新建走「先建卡再进编辑器」，本组件不再有
  // create 输入态起点）。整卡一个会话：身份行 + 人设同开同收。
  const [editing, setEditing] = useState(false);
  const beforeEditRef = useRef({ name: '', gender: '', age: '', persona: '' });
  const startEdit = (): void => {
    beforeEditRef.current = { name, gender, age, persona };
    setEditing(true);
  };
  const commitEdit = (): void => setEditing(false);
  const cancelEdit = (): void => {
    onNameChange(beforeEditRef.current.name);
    onGenderChange(beforeEditRef.current.gender);
    onAgeChange(beforeEditRef.current.age);
    onPersonaChange(beforeEditRef.current.persona);
    setEditing(false);
  };
  const identityKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  };

  return (
    <SettingsCard
      title={t('characters.sectionBasic')}
      headerAction={
        // 编辑 / 保存按钮在卡片标题栏右侧（2026-09-13 用户定稿）：展示态出
        // 铅笔，编辑态出对钩（提交 = 对钩或身份行 Enter，取消 = Esc）。
        <Tooltip
          content={editing ? t('characters.done') : t('characters.rename')}
          relationship="label"
        >
          <Button
            appearance="subtle"
            size="small"
            aria-label={editing ? t('characters.done') : t('characters.rename')}
            icon={editing ? <Checkmark20Regular /> : <Edit20Regular />}
            onClick={editing ? commitEdit : startEdit}
          />
        </Tooltip>
      }
    >
      {editing ? (
        <>
          <SettingsRow
            title={t('characters.nameLabel')}
            control={
              <Input
                className={styles.nameInput}
                value={name}
                onChange={(_, d) => onNameChange(d.value)}
                aria-label={t('characters.name')}
                autoFocus
                onKeyDown={identityKeyDown}
              />
            }
          />
          <SettingsDivider />
          <SettingsRow
            title={t('characters.genderLabel')}
            control={
              <Input
                className={styles.metaInput}
                value={gender}
                onChange={(_, d) => onGenderChange(d.value)}
                aria-label={t('characters.gender')}
                placeholder={t('characters.genderPlaceholder')}
                onKeyDown={identityKeyDown}
              />
            }
          />
          <SettingsDivider />
          <SettingsRow
            title={t('characters.ageLabel')}
            control={
              <Input
                className={styles.ageInput}
                value={age}
                onChange={(_, d) => onAgeChange(d.value)}
                aria-label={t('characters.age')}
                placeholder={t('characters.agePlaceholder')}
                onKeyDown={identityKeyDown}
              />
            }
          />
        </>
      ) : (
        <>
          <SettingsRow title={`${t('characters.nameLabel')}${name}`} />
          {/* 元数据只展示非空项（用户定稿：空值不占位） */}
          {gender.trim() ? (
            <>
              <SettingsDivider />
              <SettingsRow title={`${t('characters.genderLabel')}${gender}`} />
            </>
          ) : null}
          {age.trim() ? (
            <>
              <SettingsDivider />
              <SettingsRow title={`${t('characters.ageLabel')}${age}`} />
            </>
          ) : null}
        </>
      )}
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
      <SettingsRow title={t('characters.persona')} />
      <div className={styles.personaBody}>
        {editing ? (
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
