/**
 * Calendar arithmetic in an explicit IANA zone.
 *
 * The usage API starts `1d` buckets at local midnight in the `tz` the panel sends. These helpers
 * take that same zone as an argument instead of reading the process zone, so the bucket list the
 * panel builds matches the server's for any zone, including across DST changes.
 */

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const partsFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of partsFormatter(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? Number.NaN,
    month: values.month ?? Number.NaN,
    day: values.day ?? Number.NaN,
    hour: values.hour ?? Number.NaN,
    minute: values.minute ?? Number.NaN,
    second: values.second ?? Number.NaN,
  };
}

/** Local wall clock minus UTC at `ms`, in ms. */
const zoneOffsetMs = (ms: number, timeZone: string): number => {
  const p = zonedParts(ms, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
};

/** The instant of local midnight on the given calendar date. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wallAsUtc = Date.UTC(year, month - 1, day);
  // Two passes: the offset at the first guess can differ from the offset at midnight itself
  // when a DST change falls between them.
  const guess = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  return wallAsUtc - zoneOffsetMs(guess, timeZone);
}

/** Local midnight `days` calendar days after the local day that contains `ms`. */
export function addZonedDays(ms: number, days: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
}
