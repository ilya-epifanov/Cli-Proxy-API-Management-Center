/** Merging the server's quota reads (`/quota/probes`) into the Quota page's card states. */

import type { TFunction } from 'i18next';
import type { QuotaProbeEntry } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { getStatusFromError } from '@/utils/quota';
import type { QuotaAdapter, QuotaCardState } from './providers';

type ServerQuotaAdapter = Pick<
  QuotaAdapter,
  'fromServerProbe' | 'buildSuccessState' | 'buildErrorState'
>;

/** When the server read the quota a state shows; undefined for a state without one. */
export const refreshedAtOf = (state: QuotaCardState | undefined): number | undefined => {
  const value = state && 'refreshedAt' in state ? state.refreshedAt : undefined;
  return typeof value === 'number' ? value : undefined;
};

/**
 * The card state for the server's read of one account, or null to keep the current state: a
 * running refresh, a read already shown, or a failure that would replace shown data.
 */
export function serverQuotaState(
  adapter: ServerQuotaAdapter,
  file: AuthFileItem,
  current: QuotaCardState | undefined,
  entry: QuotaProbeEntry,
  t: TFunction
): QuotaCardState | null {
  if (!adapter.fromServerProbe || current?.status === 'loading') return null;
  // The read already shown: skip parsing it again.
  if (current?.status === 'success' && refreshedAtOf(current) === (entry.fetchedAt ?? undefined)) {
    return null;
  }
  let data: unknown;
  try {
    data = adapter.fromServerProbe(file, entry, t);
  } catch (err: unknown) {
    if (current?.status === 'success') return null;
    const message = err instanceof Error ? err.message : t('common.unknown_error');
    if (current?.status === 'error' && current.error === message) return null;
    return adapter.buildErrorState(message, getStatusFromError(err));
  }
  return adapter.buildSuccessState(data);
}
