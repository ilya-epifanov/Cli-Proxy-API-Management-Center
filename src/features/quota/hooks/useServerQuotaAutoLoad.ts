/**
 * Shows the server's own quota reads (`GET /quota/probes`) on the Quota page without asking for
 * a refresh: on open, every minute while the tab is visible, and when the tab becomes visible.
 * The server decides when an account is read; this hook never makes it read one.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { quotaProbesApi, serverReadsQuota, type QuotaProbeEntry } from '@/services/api';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { getQuotaSetter, QUOTA_ADAPTERS } from '../providers';
import { serverQuotaState } from '../serverQuota';

const SERVER_QUOTA_POLL_MS = 60_000;

export function useServerQuotaAutoLoad(entries: QuotaFileEntry[], disabled: boolean) {
  const { t } = useTranslation();
  const [serverReads, setServerReads] = useState(false);

  useEffect(() => {
    let live = true;
    // DECISION: an unreadable capability leaves the page on click-to-load, as before.
    serverReadsQuota().then(
      (value) => live && setServerReads(value),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);

  const sync = useCallback(async () => {
    const generation = captureQuotaCacheGeneration();
    let probes: QuotaProbeEntry[];
    try {
      probes = await quotaProbesApi.list();
    } catch (err: unknown) {
      // DECISION: a failed background read keeps what is shown; refresh reports errors.
      console.warn('Reading server quota failed', err);
      return;
    }
    const byAuthIndex = new Map(probes.map((probe) => [probe.authIndex, probe]));
    const byType = new Map<QuotaFileEntry['type'], QuotaFileEntry[]>();
    entries.forEach((entry) => byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]));
    commitIfQuotaCacheCurrent(generation, () => {
      byType.forEach((typeEntries, type) => {
        const adapter = QUOTA_ADAPTERS[type];
        getQuotaSetter(adapter)((prev) => {
          let next = prev;
          typeEntries.forEach(({ file }) => {
            const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
            const probe = authIndex ? byAuthIndex.get(authIndex) : undefined;
            const key = getQuotaCacheKey(file);
            const state = probe && serverQuotaState(adapter, file, prev[key], probe, t);
            if (state) next = { ...next, [key]: state };
          });
          return next;
        });
      });
    });
  }, [entries, t]);

  const active = serverReads && !disabled;
  useEffect(() => {
    if (active) void sync();
  }, [active, sync]);
  const poll = useCallback(() => void sync(), [sync]);
  useVisiblePolling(poll, active ? SERVER_QUOTA_POLL_MS : null);
}
