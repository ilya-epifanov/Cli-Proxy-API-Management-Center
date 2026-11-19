import { DAY_MS } from '@/utils/time/durations';

const formatters = new Map<string, Intl.RelativeTimeFormat>();

const getFormatter = (locale?: string): Intl.RelativeTimeFormat => {
  const key = locale ?? '';
  const cached = formatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  formatters.set(key, formatter);
  return formatter;
};

/**
 * Whole days since `signedInAtMs`, as a localized phrase: "today", "yesterday", "3 days ago".
 * A time in the future (clock skew) counts as today.
 */
export const formatSignedInAgo = (signedInAtMs: number, nowMs: number, locale?: string): string => {
  const days = Math.max(0, Math.floor((nowMs - signedInAtMs) / DAY_MS));
  return getFormatter(locale).format(-days, 'day');
};
