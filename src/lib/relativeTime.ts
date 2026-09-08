// 相对时间：Intl 按 i18n 当前语言格式化（「3 分钟前」「2 天前」）。
// 会话侧栏条目与角色卡共用（features 层不可 import app/，故落 lib/）。
export function formatRelative(ts: number, language: string): string {
  const diffMin = Math.round((Date.now() - ts) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (diffMin < 1) return rtf.format(0, 'minute');
  if (diffMin < 60) return rtf.format(-diffMin, 'minute');
  if (diffMin < 1440) return rtf.format(-Math.round(diffMin / 60), 'hour');
  return rtf.format(-Math.round(diffMin / 1440), 'day');
}

// 当日时钟时间（HH:mm，按 i18n 当前语言）；聊天消息头时间戳用——
// 消息流内相对时间会随页面驻留失真，钟面时间更稳定。
export function formatClock(ts: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts);
}
