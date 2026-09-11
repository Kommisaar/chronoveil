/**
 * AI 起草历法对话框（FR-014 二期）：世界观描述（限 4000 字符，实时计数）
 * → draftCalendar（真实 LLM 起草，可能数秒）→ 结果预览（CalendarDetail
 * 复用查看态渲染）→「应用到表单」（填入编辑态，不自动保存）或「丢弃」。
 *
 * 取消语义：draftCalendar 命令无前端取消通道，任何路径的关闭（取消 /
 * Esc / 轻消散）都等于放弃——序号守卫保证起草途中关闭后，迟到的结果
 * 或错误一律静默丢弃，不再触碰本组件状态。
 * 错误路径（conflict / unavailable 等）：就地 i18n 错误文案 +「重试」，
 * 重试沿用同一描述重新发起。
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Text,
  Textarea,
} from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { draftCalendar } from '../../../api/commands';
import type { CalendarConfigDto } from '../../../api/types';
import { CalendarDetail } from './CalendarSection';

/** 描述上限（与 services/calendar_draft 的参数校验一致）。 */
const MAX_DESCRIPTION = 4000;

type DraftPhase = 'input' | 'drafting' | 'result' | 'error';

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CalendarDraftDialog(props: {
  open: boolean;
  /** 应用到表单（父级填入编辑态，不自动保存）并关闭对话框。 */
  onApply: (config: CalendarConfigDto) => void;
  /** 关闭 = 放弃（起草途中关闭同样放弃，迟到结果忽略）。 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<DraftPhase>('input');
  const [result, setResult] = useState<CalendarConfigDto | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // 序号守卫：每次重新打开 / 重新起草递增；关闭也递增作废在途调用。
  const seqRef = useRef(0);

  // 每次打开重置为初始态（描述一并清空：关闭即放弃，不残留上次草稿）。
  useEffect(() => {
    if (props.open) {
      seqRef.current += 1;
      setDescription('');
      setPhase('input');
      setResult(null);
      setErrorText(null);
    }
  }, [props.open]);

  const close = (): void => {
    // 作废在途调用：命令无前端取消通道，迟到结果按序号丢弃（见文件头）。
    seqRef.current += 1;
    props.onClose();
  };

  const runDraft = (): void => {
    const seq = ++seqRef.current;
    setPhase('drafting');
    setErrorText(null);
    draftCalendar(description.trim())
      .then((config) => {
        if (seqRef.current !== seq) return; // 已关闭/已重新起草：迟到结果丢弃
        setResult(config);
        setPhase('result');
      })
      .catch((e: unknown) => {
        if (seqRef.current !== seq) return;
        setErrorText(`${t('characters.calendar.draftFailed')}：${describeError(e)}`);
        setPhase('error');
      });
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(_, data) => {
        // Esc / 轻消散等 Fluent 发起的关闭同样走放弃语义。
        if (!data.open) close();
      }}
    >
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>{t('characters.calendar.draftTitle')}</DialogTitle>
          <DialogContent>
            {phase === 'result' && result !== null ? (
              <CalendarDetail config={result} />
            ) : phase === 'error' ? (
              <Text role="alert" size={200}>
                {errorText}
              </Text>
            ) : (
              <>
                <Text size={200}>{t('characters.calendar.draftHint')}</Text>
                <Textarea
                  rows={6}
                  maxLength={MAX_DESCRIPTION}
                  value={description}
                  onChange={(_, data) => setDescription(data.value)}
                  aria-label={t('characters.calendar.draftDescriptionField')}
                  placeholder={t('characters.calendar.draftPlaceholder')}
                />
                <Text size={200}>
                  {description.length} / {MAX_DESCRIPTION}
                </Text>
                {phase === 'drafting' ? (
                  <Text size={200}>
                    <Spinner size="tiny" /> {t('characters.calendar.drafting')}
                  </Text>
                ) : null}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {phase === 'input' ? (
              <Button onClick={close}>{t('characters.cancel')}</Button>
            ) : null}
            {phase === 'input' ? (
              <Button
                appearance="primary"
                disabled={description.trim() === ''}
                onClick={runDraft}
              >
                {t('characters.calendar.draftRun')}
              </Button>
            ) : null}
            {phase === 'drafting' ? (
              // 起草中可关闭 = 放弃（迟到结果忽略），不给「后台继续」假象。
              <Button onClick={close}>{t('characters.cancel')}</Button>
            ) : null}
            {phase === 'result' ? (
              <Button onClick={close}>{t('characters.calendar.draftDiscard')}</Button>
            ) : null}
            {phase === 'result' ? (
              <Button
                appearance="primary"
                disabled={result === null}
                onClick={() => {
                  if (result !== null) props.onApply(result);
                }}
              >
                {t('characters.calendar.draftApply')}
              </Button>
            ) : null}
            {phase === 'error' ? (
              <Button onClick={close}>{t('characters.cancel')}</Button>
            ) : null}
            {phase === 'error' ? (
              <Button appearance="primary" onClick={runDraft}>
                {t('characters.calendar.draftRetry')}
              </Button>
            ) : null}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
