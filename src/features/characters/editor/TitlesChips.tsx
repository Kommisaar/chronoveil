/**
 * 称号 chip 编辑器（2026-09-15 用户定稿：一体式 chip，弃 InteractionTag）：
 * 参照 TokenLineEdit 的 token——单一圆角描边内并排「文本 + ×」，× 不是带
 * 独立边框的按钮。Fluent 现成组件无此形态：InteractionTag 的 Primary/
 * Secondary 各自带边框（呈两个断开方块）；Tag dismissible 会把整枚 chip
 * 变成一个 button（点文本 = 删除，Enter 也删）。故用外层描边 + 两枚
 * transparent 按钮自绘。
 *
 * 点「添加称号」追加一枚**编辑态 chip**：chip 本体不变（描边即编辑框），
 * 文字在其内原位变成透明裸输入框并自动聚焦，Enter / 失焦确认，Esc 取消；
 * 确认时空文本自动移除该枚（「添加后不填字 = 没加」）；点 chip 文本进入
 * 同样的原位编辑（改错字不必删了重加），点 × 删除。无独立输入行，chip 是
 * 唯一形态。
 *
 * 数据流仍是受控 string[]：编辑态是本组件内部视图态（draft），确认才写回
 * 父级；载荷侧空项过滤（useEditorForm.buildInput）继续兜底。
 */
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { Add12Regular, Dismiss12Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles({
  // chip 流式布局：多枚 chip + 添加按钮同行排布，超出换行（在全宽
  // titlesBox 身份块容器内使用；间距取 XS：chip 自带描边与内距，视觉
  // 分隔已足够，紧凑成组、宽盒一行多容，放大间距反而松散）
  chipsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  // 一体式 chip：单一圆角描边包住文本与 ×（高 24px + 上下边 = 26px，
  // 与原 InteractionTag medium 同档）
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  // 芯内按钮去掉 Fluent 按钮默认的大 minWidth，只留紧凑点击热区
  chipTextBtn: {
    minWidth: '0px',
    padding: '0px 8px',
  },
  chipDismissBtn: {
    minWidth: '0px',
    width: '16px',
    height: '20px',
    padding: '0px',
  },
  // 两枚图标钮的图标容器统一 16×16（Fluent 默认会因按钮是否 icon-only 给出
  // 14×20 / 20×20 两种盒，svg 同为 12×12 但容器不一致）
  chipIcon: {
    width: '16px',
    height: '16px',
  },
  // 图标恒持次要前景色：subtle 按钮 hover 会把 .fui-Button__icon 染成品牌
  // 色（--colorNeutralForeground2BrandHover），用户定稿图标不追强调色；色
  // 直接钉在 svg 元素上——hover 规则只作用于父级 span，子元素显式色不被覆盖
  neutralIcon: {
    color: tokens.colorNeutralForeground2,
  },
  // 编辑态：同一枚 chip 内原位编辑——无边框透明裸 input，chip 描边即编辑
  // 框（不出外置输入框）；宽 140+内距 ≈ 原 160px 输入框，chip 微宽即入编辑
  chipEditInput: {
    width: '140px',
    minWidth: '0px',
    height: '24px',
    boxSizing: 'border-box',
    border: '0px',
    padding: '0px 8px',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    // 焦点可视交给 chip 本体（光标即编辑位指示），不再叠一层输入框 outline
    outline: 'none',
  },
});

export function TitlesChips(props: {
  titles: string[];
  onTitlesChange: (value: string[]) => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  // 编辑中的 chip：index + 草稿文本。null = 无编辑态。
  const [editing, setEditing] = useState<{ index: number; draft: string } | null>(null);

  /** 确认编辑：trim 后写回；空文本即移除该枚（添加后不填字 = 没加）。 */
  const confirmEdit = (): void => {
    if (!editing) return;
    const { index, draft } = editing;
    setEditing(null);
    const value = draft.trim();
    if (value === '') {
      props.onTitlesChange(props.titles.filter((_, j) => j !== index));
    } else {
      props.onTitlesChange(props.titles.map((v, j) => (j === index ? value : v)));
    }
  };

  /** Esc 取消：还原草稿；该枚原本就是空（新加未命名）则移除。 */
  const cancelEdit = (): void => {
    if (!editing) return;
    const { index } = editing;
    setEditing(null);
    if (props.titles[index]?.trim() === '') {
      props.onTitlesChange(props.titles.filter((_, j) => j !== index));
    }
  };

  const addTitle = (): void => {
    props.onTitlesChange([...props.titles, '']);
    setEditing({ index: props.titles.length, draft: '' });
  };

  return (
    <div role="group" aria-label={t('characters.characterTitle')} className={styles.chipsRow}>
      {props.titles.map((title, index) =>
        editing?.index === index ? (
          <span key={`edit-${index}`} className={styles.chip}>
            <input
              className={styles.chipEditInput}
              value={editing.draft}
              autoFocus
              aria-label={`${t('characters.characterTitle')} ${index + 1}`}
              placeholder={t('characters.titlePlaceholder')}
              onChange={(e) => setEditing({ index, draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmEdit();
                if (e.key === 'Escape') cancelEdit();
              }}
              onBlur={confirmEdit}
            />
          </span>
        ) : (
          <span key={`${index}-${title}`} className={styles.chip}>
            {/* 点文本进入编辑（改错字不必删了重加）。subtle：hover 出背景色
                （Fluent token 标准悬停语言）；transparent 的 hover 只变文字色，
                其背景令牌是字面 transparent，视觉无反馈 */}
            <Button
              appearance="subtle"
              size="small"
              className={styles.chipTextBtn}
              onClick={() => setEditing({ index, draft: title })}
            >
              {title}
            </Button>
            <Button
              appearance="subtle"
              size="small"
              className={styles.chipDismissBtn}
              aria-label={t('characters.titleRemove')}
              icon={{ className: styles.chipIcon, children: <Dismiss12Regular className={styles.neutralIcon} /> }}
              onClick={() => props.onTitlesChange(props.titles.filter((_, j) => j !== index))}
            />
          </span>
        ),
      )}
      <Button
        appearance="subtle"
        size="small"
        icon={{ className: styles.chipIcon, children: <Add12Regular className={styles.neutralIcon} /> }}
        onClick={addTitle}
      >
        {t('characters.titleAdd')}
      </Button>
    </div>
  );
}
