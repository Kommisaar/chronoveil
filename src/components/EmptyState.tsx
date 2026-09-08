import { Text, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    color: tokens.colorNeutralForeground3,
  },
});

/** 跨域共享的空态占位。 */
export function EmptyState({ message }: { message: string }) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Text>{message}</Text>
    </div>
  );
}
