import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

/** Up to this age a read is "just now". */
const JUST_NOW_MS = 30_000;

export interface RefreshedAgo {
  unit: 'just_now' | 'under_minute' | 'minutes' | 'hours';
  value: string;
}

/** Compact age of a read: "just now", "<1 minute", whole minutes, then H:MM. */
export function refreshedAgo(ageMs: number): RefreshedAgo {
  // Server and browser clocks can disagree by a little; a read is never in the future.
  const age = Math.max(0, ageMs);
  if (age <= JUST_NOW_MS) return { unit: 'just_now', value: '' };
  if (age < MINUTE_MS) return { unit: 'under_minute', value: '' };
  if (age < HOUR_MS) return { unit: 'minutes', value: String(Math.floor(age / MINUTE_MS)) };
  const hours = Math.floor(age / HOUR_MS);
  const minutes = Math.floor((age % HOUR_MS) / MINUTE_MS);
  return { unit: 'hours', value: `${hours}:${String(minutes).padStart(2, '0')}` };
}
