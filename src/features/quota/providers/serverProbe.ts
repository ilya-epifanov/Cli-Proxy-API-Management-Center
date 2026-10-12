/** Reading a Claude or Codex server read (`/quota/probes`) in the provider adapters. */

import type { ApiCallResult, QuotaProbeEntry } from '@/services/api';
import { createStatusError } from '@/utils/quota';

/**
 * The entry's `usage` answer; throws the server's error for an account it has never read
 * successfully.
 */
export function probeUsage(entry: QuotaProbeEntry, fallback: string): ApiCallResult {
  const usage = entry.responses.get('usage');
  if (usage) return usage;
  throw createStatusError(entry.error?.message || fallback, entry.error?.status ?? undefined);
}
