/**
 * Reads the pace selector's ranking (`GET /routing/ranking`) for the Quota cards: on open,
 * every 30 s while the tab is visible, when the account list reloads and when the Claude
 * ranking model changes. Servers without the pace strategy are never asked.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import {
  authFilesApi,
  getCachedServerCapabilities,
  routingRankingApi,
  type RoutingRanking,
} from '@/services/api';
import type { ApiError } from '@/types';

const RANKING_POLL_MS = 30_000;

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && (error as ApiError).status === 404;

/**
 * The ranking, or null before the first read and on servers that do not rank.
 * `claudeModel` ranks Claude for one model (a Fable model adds the Fable window); null ranks
 * for any model. Codex is always ranked for any model: its windows do not depend on it.
 */
export function useRoutingRanking(
  disabled: boolean,
  claudeModel: string | null,
  reloadToken: unknown
): RoutingRanking | null {
  const [supported, setSupported] = useState(false);
  const [ranking, setRanking] = useState<RoutingRanking | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    let live = true;
    // DECISION: unreadable capabilities leave the cards without routing, as on upstream.
    getCachedServerCapabilities().then(
      (capabilities) =>
        live &&
        setSupported(capabilities.tag === 'fork' && capabilities.strategies.includes('pace')),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);

  const active = supported && !disabled;

  const read = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = claudeModel
        ? await Promise.all([
            routingRankingApi.get({ provider: 'claude', model: claudeModel }),
            routingRankingApi.get({ provider: 'codex' }),
          ]).then(([claude, codex]) => ({
            strategy: claude.strategy,
            pools: [...claude.pools, ...codex.pools],
          }))
        : await routingRankingApi.get();
      if (request === requestRef.current) setRanking(next);
    } catch (err: unknown) {
      if (request !== requestRef.current) return;
      if (isNotFound(err)) {
        // A fork build from before the pace selector.
        setSupported(false);
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
  return ranking;
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
