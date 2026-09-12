/**
 * 身份行字段块：名称 / 性别 / 年龄的「展示态 + 行内编辑」，与名称同行的
 * 强调色板（Office 风格色块下拉）一并归属此块。
 *
 * 行内编辑交互：编辑态默认展示文本，点铅笔进输入态；Enter 提交回展示态，
 * Esc 还原进输入前的值。新建（无既有角色）直接以输入态起步。刻意不做
 * 失焦提交：Fluent 的焦点管理（tabster）会在开面板时挪走焦点，blur 一
 * 触发就把输入态弹回展示态；表单值本随键入实时更新，「编辑态」只是展示
 * 形态，不依赖失焦收口。
 */
import { Button, Input, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit20Regular } from '@fluentui/react-icons';
import { AccentColorPicker } from './AccentColorPicker';
import { useFieldStyles } from './pieces';

const useStyles = makeStyles({
  // 首行：名称（展示态 + 行内重命名）与强调色板同行（2026-09-09 定稿排版）
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalS,
  },
  nameValue: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    // 长名截断防把同行色板挤下折（色板自身 flexWrap 可换行兜底）
    maxWidth: '260px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  nameInput: {
    width: '200px',
    minWidth: '0px',
  },
  // 性别 / 年龄行内输入：短宽度，空间不足随行折行
  metaInput: {
    width: '96px',
    minWidth: '0px',
  },
  ageInput: {
    width: '72px',
    minWidth: '0px',
  },
  // 展示态元数据文本：次级于名称（常规字重），禁收缩防挤压变形
  metaItem: {
    flexShrink: 0,
  },
});

export interface IdentityFieldProps {
  /** 展示态名称（回退名，海报语言同一来源）；空名时为「新」。 */
  nameText: string;
  name: string;
  gender: string;
  age: string;
  onNameChange: (value: string) => void;
  onGenderChange: (value: string) => void;
  onAgeChange: (value: string) => void;
  /** 强调色（accent_color 语义）：null = 跟随海报派生。 */
  accentColor: string | null;
  /** 基础色（未经修饰）：跟随海报态取色器的显示色。 */
  baseColor: string;
  onAccentColorChange: (value: string | null) => void;
  /** 新建（无既有角色）直接以输入态起步。 */
  startInEdit: boolean;
  /** 名称必填校验：false 时字段块底部出必填提示（保存禁用在父级）。 */
  canSave: boolean;
}

export function IdentityField(props: IdentityFieldProps) {
  const {
    nameText,
    name,
    gender,
    age,
    onNameChange,
    onGenderChange,
    onAgeChange,
    accentColor,
    baseColor,
    onAccentColorChange,
    startInEdit,
    canSave,
  } = props;
  const styles = useStyles();
  const field = useFieldStyles();
  const { t } = useTranslation();

  const [editingName, setEditingName] = useState(startInEdit);
  const identityBeforeEditRef = useRef({ name: '', gender: '', age: '' });
  const startEditName = (): void => {
    identityBeforeEditRef.current = { name, gender, age };
    setEditingName(true);
  };
  const commitIdentity = (): void => setEditingName(false);
  const cancelIdentity = (): void => {
    onNameChange(identityBeforeEditRef.current.name);
    onGenderChange(identityBeforeEditRef.current.gender);
    onAgeChange(identityBeforeEditRef.current.age);
    setEditingName(false);
  };
  const identityKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') commitIdentity();
    if (e.key === 'Escape') cancelIdentity();
  };

  return (
    <div className={field.field}>
      <div className={styles.nameRow}>
        <Text size={300} weight="semibold">
          {t('characters.nameLabel')}
        </Text>
        {editingName ? (
          <>
            <Input
              className={styles.nameInput}
              value={name}
              onChange={(_, d) => onNameChange(d.value)}
              aria-label={t('characters.name')}
              autoFocus
              onKeyDown={identityKeyDown}
            />
            <Input
              className={styles.metaInput}
              value={gender}
              onChange={(_, d) => onGenderChange(d.value)}
              aria-label={t('characters.gender')}
              placeholder={t('characters.genderPlaceholder')}
              onKeyDown={identityKeyDown}
            />
            <Input
              className={styles.ageInput}
              value={age}
              onChange={(_, d) => onAgeChange(d.value)}
              aria-label={t('characters.age')}
              placeholder={t('characters.agePlaceholder')}
              onKeyDown={identityKeyDown}
            />
          </>
        ) : (
          <>
            <Text size={300} weight="semibold" className={styles.nameValue}>
              {nameText}
            </Text>
            {/* 元数据只展示非空项（用户定稿：空值不占位） */}
            {gender.trim() ? (
              <Text size={300} className={styles.metaItem}>
                {t('characters.genderLabel')}
                {gender}
              </Text>
            ) : null}
            {age.trim() ? (
              <Text size={300} className={styles.metaItem}>
                {t('characters.ageLabel')}
                {age}
              </Text>
            ) : null}
            <Button
              appearance="subtle"
              size="small"
              icon={<Edit20Regular />}
              aria-label={t('characters.rename')}
              title={t('characters.rename')}
              onClick={startEditName}
            />
          </>
        )}
        {/* 强调色取色器直接跟在名称后（Office 风格色块下拉） */}
        <AccentColorPicker accentColor={accentColor} baseColor={baseColor} onChange={onAccentColorChange} />
      </div>
      {!canSave ? <Text size={200}>{t('characters.nameRequired')}</Text> : null}
    </div>
  );
}
