import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const SECOND_MS = 1000;

export interface RefreshedAgo {
  unit: 'seconds' | 'minutes' | 'hours';
  value: string;
}

/** Compact age of a read: whole seconds, then whole minutes, then H:MM. */
export function refreshedAgo(ageMs: number): RefreshedAgo {
  // Server and browser clocks can disagree by a little; a read is never in the future.
  const age = Math.max(0, ageMs);
  if (age < MINUTE_MS) return { unit: 'seconds', value: String(Math.floor(age / SECOND_MS)) };
  if (age < HOUR_MS) return { unit: 'minutes', value: String(Math.floor(age / MINUTE_MS)) };
  const hours = Math.floor(age / HOUR_MS);
  const minutes = Math.floor((age % HOUR_MS) / MINUTE_MS);
  return { unit: 'hours', value: `${hours}:${String(minutes).padStart(2, '0')}` };
}
