/**
 * Reads the pace selector's ranking (`GET /routing/ranking`) for the Quota cards: on open,
 * every 30 s while the tab is visible, when the account list reloads and when the Claude
 * ranking model changes. Servers without the pace strategy are never asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { useServerCapability } from '@/hooks/useServerCapability';
import { authFilesApi, routingRankingApi, type RoutingRanking } from '@/services/api';
import { isNotFound } from '@/services/api/apiError';
import type { Capabilities } from '@/services/api/capabilities';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { getErrorMessage } from '@/utils/helpers';
import type { ThrottleOverrideChange } from '../components/QuotaRouting';
import type { QuotaFileEntry } from '../logic';
import { routingByAuthIndex } from '../routing';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';

const RANKING_POLL_MS = 30_000;

const ranksByPace = (capabilities: Capabilities): boolean =>
  capabilities.tag === 'fork' && capabilities.strategies.includes('pace');

/**
 * The ranking, or null before the first read and on servers that do not rank, and a reload
 * for after a change to the routing state.
 * `claudeModel` ranks Claude for one model (a Fable model adds the Fable window); null ranks
 * for any model. Codex is always ranked for any model: its windows do not depend on it.
 */
export function useRoutingRanking(
  disabled: boolean,
  claudeModel: string | null,
  reloadToken: unknown
): { ranking: RoutingRanking | null; reload: () => Promise<void> } {
  // DECISION: unreadable capabilities leave the cards without routing, as on upstream.
  const paceAdvertised = useServerCapability(ranksByPace, false);
  // A fork build from before the pace selector advertises pace but answers 404.
  const [rankingMissing, setRankingMissing] = useState(false);
  const [ranking, setRanking] = useState<RoutingRanking | null>(null);
  const requestRef = useRef(0);

  const active = paceAdvertised && !rankingMissing && !disabled;

  const read = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = claudeModel
        ? await Promise.all([
            routingRankingApi.get({ provider: 'claude', model: claudeModel }),
            routingRankingApi.get({ provider: 'codex' }),
          ]).then(([claude, codex]) => ({ pools: [...claude.pools, ...codex.pools] }))
        : await routingRankingApi.get();
      if (request === requestRef.current) setRanking(next);
    } catch (err: unknown) {
      if (request !== requestRef.current) return;
      if (isNotFound(err)) {
        setRankingMissing(true);
        setRanking(null);
        return;
      }
      // DECISION: a failed background read keeps the last ranking shown.
      console.warn('Reading the routing ranking failed', err);
    }
  }, [claudeModel]);

  useEffect(() => {
    if (!active) {
      requestRef.current += 1;
      setRanking(null);
      return;
    }
    void read();
  }, [active, read, reloadToken]);

  const poll = useCallback(() => void read(), [read]);
  useVisiblePolling(poll, active ? RANKING_POLL_MS : null);
  return { ranking, reload: read };
}

/** Claude model ids the ranking can be asked for, read once while `enabled`. */
export function useClaudeRankingModels(enabled: boolean): string[] {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    authFilesApi.getModelDefinitions('claude').then(
      (definitions) => live && setModels([...new Set(definitions.map((model) => model.id))].sort()),
      (err: unknown) => console.warn('Reading Claude model definitions failed', err)
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return models;
}

/**
 * The Quota page's routing state: the ranking, the per-account lookup, the Claude model the
 * ranking is for (remembered across visits) and the pool throttle override.
 * `showRankModel` says whether the page's tab lists Claude accounts, so the model picker applies.
 */
export function useQuotaRouting({
  disabled,
  files,
  showRankModel,
}: {
  disabled: boolean;
  files: AuthFileItem[];
  showRankModel: boolean;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [claudeRankModel, setClaudeRankModel] = useState<string>(
    () => readQuotaUiState()?.claudeRankModel ?? ''
  );
  const { ranking, reload: reloadRanking } = useRoutingRanking(
    disabled,
    claudeRankModel || null,
    files
  );
  const routingByIndex = useMemo(() => routingByAuthIndex(ranking?.pools ?? []), [ranking]);
  const routingFor = useCallback(
    (entry: QuotaFileEntry) => {
      const authIndex = normalizeAuthIndex(entry.file.auth_index ?? entry.file.authIndex);
      return authIndex ? routingByIndex.get(authIndex) : undefined;
    },
    [routingByIndex]
  );
  const claudeModels = useClaudeRankingModels(Boolean(ranking));
  const onThrottleOverride = useCallback<ThrottleOverrideChange>(
    async (provider, speed) => {
      try {
        if (speed === null) await routingRankingApi.clearThrottleOverride(provider);
        else await routingRankingApi.setThrottleOverride(provider, speed);
      } catch (err: unknown) {
        showNotification(
          t('quota_routing.override_failed', {
            message: getErrorMessage(err, String(err)),
          }),
          'error'
        );
      }
      await reloadRanking();
    },
    [reloadRanking, showNotification, t]
  );
  const onRankModelChange = useCallback((next: string) => {
    setClaudeRankModel(next);
    writeQuotaUiState({ claudeRankModel: next });
  }, []);
  const rankModelOptions = useMemo(() => {
    const models =
      claudeRankModel && !claudeModels.includes(claudeRankModel)
        ? [claudeRankModel, ...claudeModels]
        : claudeModels;
    return [
      { value: '', label: t('quota_routing.rank_model_any') },
      ...models.map((model) => ({ value: model, label: model })),
    ];
  }, [claudeModels, claudeRankModel, t]);

  return {
    ranking,
    routingFor,
    rankingShown: routingByIndex.size > 0,
    rankModel: {
      show: Boolean(ranking) && showRankModel,
      value: claudeRankModel,
      options: rankModelOptions,
      onChange: onRankModelChange,
    },
    onThrottleOverride,
  };
}
