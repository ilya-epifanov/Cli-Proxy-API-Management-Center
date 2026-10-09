import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInterval } from '@/hooks/useInterval';
import {
  apiClient,
  authFilesApi,
  getServerCapabilities,
  getUsageSeries,
  getUsageTotals,
  UsageStoreDisabledError,
  type UsageGroupBy,
  type UsageTotalsRow,
} from '@/services/api';
import { useAuthStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import {
  accountNames,
  bucketStarts,
  fillSeries,
  usageWindow,
  type FilledSeries,
  type UsageRange,
} from './usageModel';

/** §12: hourly buckets fill slowly, so a minute keeps the last bar honest. */
export const USAGE_POLL_MS = 60_000;

export interface UsageQuery {
  range: UsageRange;
  groupBy: UsageGroupBy;
}

export interface UsageSnapshot {
  /** The query this data answers; the controls may already show a newer one. */
  query: UsageQuery;
  timeZone: string;
  /** Bucket starts of the server-aligned window. */
  starts: number[];
  series: FilledSeries[];
  rows: UsageTotalsRow[];
  droppedRecords: number;
  /** auth_index → display name. */
  names: ReadonlyMap<string, string>;
  /** Set when the credential list failed; names then come from the previous load, if any. */
  namesError: string | null;
}

/** What the server can tell about usage; `checking` until the first answer arrives. */
export type UsageData =
  | { tag: 'checking' }
  | { tag: 'upstream' }
  | { tag: 'disabled' }
  | { tag: 'enabled'; snapshot: UsageSnapshot };

interface UsageHistoryState {
  data: UsageData;
  /** A request is in flight; `data` still holds the previous answer. */
  loading: boolean;
  /** The latest request failed; `data` still holds the previous answer. */
  error: string | null;
}

export interface UsageHistory extends UsageHistoryState {
  reload: () => Promise<void>;
}

type NamesResult = { ok: true; names: Map<string, string> } | { ok: false; message: string };

type LoadResult =
  | { tag: 'upstream' }
  | { tag: 'disabled' }
  | {
      tag: 'enabled';
      snapshot: Omit<UsageSnapshot, 'names' | 'namesError'>;
      names: NamesResult;
    };

const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchUsage(query: UsageQuery, nowMs: number, timeZone: string): Promise<LoadResult> {
  const capabilities = await getServerCapabilities();
  if (capabilities.tag === 'upstream') return { tag: 'upstream' };
  if (!capabilities.usageStore.enabled) return { tag: 'disabled' };

  const window = usageWindow(query.range, nowMs, timeZone);
  try {
    const [series, totals, names] = await Promise.all([
      getUsageSeries({ ...window, groupBy: query.groupBy, timeZone }),
      getUsageTotals({ from: window.from, to: window.to }),
      // Names only decorate account keys; their failure must not hide the usage itself.
      authFilesApi.list().then(
        (response): NamesResult => ({ ok: true, names: accountNames(response.files) }),
        (error: unknown): NamesResult => ({ ok: false, message: getErrorMessage(error, '?') })
      ),
    ]);
    const starts = bucketStarts(series.bucket, series.from, series.to, timeZone);
    return {
      tag: 'enabled',
      snapshot: {
        query,
        timeZone,
        starts,
        series: fillSeries(series.series, starts, series.to),
        rows: totals.rows,
        droppedRecords: capabilities.usageStore.droppedRecords,
      },
      names,
    };
  } catch (error) {
    // The store was switched off between the capability check and the query.
    if (error instanceof UsageStoreDisabledError) return { tag: 'disabled' };
    throw error;
  }
}

const applyResult = (prev: UsageHistoryState, result: LoadResult): UsageHistoryState => {
  if (result.tag !== 'enabled') return { data: { tag: result.tag }, loading: false, error: null };
  const { names } = result;
  const previousNames = prev.data.tag === 'enabled' ? prev.data.snapshot.names : new Map();
  return {
    data: {
      tag: 'enabled',
      snapshot: {
        ...result.snapshot,
        names: names.ok ? names.names : previousNames,
        namesError: names.ok ? null : names.message,
      },
    },
    loading: false,
    error: null,
  };
};

/**
 * Usage data for the current query, refetched on query change, every minute while visible,
 * and on `reload`. Responses from an older request or connection are dropped.
 */
export function useUsageHistory(query: UsageQuery): UsageHistory {
  const { t } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [state, setState] = useState<UsageHistoryState>({
    data: { tag: 'checking' },
    loading: true,
    error: null,
  });
  const requestRef = useRef(0);
  const { range, groupBy } = query;

  const reload = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!connected) {
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();

    setState((prev) => (prev.loading ? prev : { ...prev, loading: true }));
    try {
      const result = await fetchUsage({ range, groupBy }, Date.now(), browserTimeZone());
      if (!isCurrent()) return;
      setState((prev) => applyResult(prev, result));
    } catch (error) {
      if (!isCurrent()) return;
      const message = getErrorMessage(error, t('notification.refresh_failed'));
      setState((prev) => ({ ...prev, loading: false, error: message }));
    }
  }, [connected, range, groupBy, t]);

  useEffect(() => {
    void reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload]);

  // Hidden tabs skip polls; a tab that becomes visible again refetches at once (design §12).
  const pollable = connected && state.data.tag !== 'upstream';
  useInterval(
    () => {
      if (document.visibilityState === 'visible') void reload();
    },
    pollable ? USAGE_POLL_MS : null
  );
  useEffect(() => {
    if (!pollable) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [pollable, reload]);

  return { ...state, reload };
}
