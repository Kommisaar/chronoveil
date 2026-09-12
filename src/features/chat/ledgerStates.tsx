/**
 * 叙事账本第一段：人物状态。
 *
 * 按 scope 分「当前状态」「关系」两组，`key：value` 行；组空省标题（整组
 * 含标题一起省），全空显示空态文案。expiry 不展示——那是结算清算线索，
 * 不是叙事信息。数据由面板壳拉取后经 props 下发，本组件只管渲染。
 */
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { CharacterStateDto } from '../../api/types';
import { useLedgerSectionStyles } from './useLedgerSectionStyles';

const useStyles = makeStyles({
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  stateRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.6',
    wordBreak: 'break-word',
  },
  stateMarker: {
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  stateText: {
    minWidth: 0,
  },
});

/** 状态分组（组空由调用方省略整组含标题）：`key：value` 行，expiry 不展示。 */
function StateGroup({ title, rows }: { title: string; rows: CharacterStateDto[] }) {
  const styles = useStyles();
  const chrome = useLedgerSectionStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.group}>
      <Text className={chrome.groupTitle}>{title}</Text>
      {rows.map((s) => (
        <div key={s.id} className={styles.stateRow}>
          <span className={styles.stateMarker} aria-hidden="true">
            ·
          </span>
          <span className={styles.stateText}>
            {t('chat.ledger.stateRow', { key: s.key, value: s.value })}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface LedgerStatesSectionProps {
  /** 会话级人物状态列表（面板壳拉取；null = 拉取未落定，渲染为空列表）。 */
  states: CharacterStateDto[] | null;
}

export function LedgerStatesSection({ states }: LedgerStatesSectionProps) {
  const chrome = useLedgerSectionStyles();
  const { t } = useTranslation();
  const stateList = states ?? [];
  const relationRows = stateList.filter((s) => s.scope === 'relation');
  const stateRows = stateList.filter((s) => s.scope !== 'relation');
  return (
    <section className={chrome.section} aria-label={t('chat.ledger.states')}>
      <Text className={chrome.sectionTitle}>{t('chat.ledger.states')}</Text>
      {stateList.length === 0 ? (
        <Text className={chrome.groupTitle}>{t('chat.ledger.statesEmpty')}</Text>
      ) : (
        <>
          {stateRows.length > 0 && <StateGroup title={t('chat.ledger.groupState')} rows={stateRows} />}
          {relationRows.length > 0 && (
            <StateGroup title={t('chat.ledger.groupRelation')} rows={relationRows} />
          )}
        </>
      )}
    </section>
  );
}
