/**
 * Routing ranking of the fork's pace strategy: `GET /routing/ranking[?provider=][&model=]`
 * returns how a cold pick would order each provider's accounts, and why. Only fork builds with
 * the pace selector serve it; older servers answer 404.
 */

import { apiClient } from './client';
import { ShapeReader } from './responseShape';

export const RANK_CLASSES = ['ready', 'burst_low', 'unknown', 'exhausted'] as const;
export type RankClass = (typeof RANK_CLASSES)[number];

export const NOT_CANDIDATE_REASONS = ['disabled', 'auth_error', 'cooldown', 'unavailable'] as const;
export type NotCandidateReason = (typeof NOT_CANDIDATE_REASONS)[number];

interface RankBase {
  authIndex: string;
  /** 1-based position within the pool, across priority tiers. */
  rank: number;
  priority: number;
  /** A new session picks one top-band account at random. */
  topBand: boolean;
  /** Long (weekly) windows this account was ranked on, e.g. `seven-day`, `seven-day-fable`. */
  longWindows: string[];
  /** Oldest quota observation used; epoch ms. */
  observedAt: number | null;
  stale: boolean;
}

export type RankEntry = RankBase &
  (
    | {
        class: 'ready' | 'burst_low';
        /** Remaining share of the pace window divided by the share of its time left. */
        pace: number;
        paceWindow: string;
        /** Pace window reset, epoch ms; null when no reset is pending. */
        resetsAt: number | null;
        /** The pace window's reset passed since it was read; assumed refilled until re-read. */
        estimated: boolean;
        /** 5-hour remaining fraction, 0..1; null when not observed. */
        shortRemaining: number | null;
      }
    | {
        class: 'exhausted';
        /** The window at 0 %. */
        window: string;
        /** When that window resets, epoch ms; null when unknown. */
        backAt: number | null;
      }
    | { class: 'unknown' }
  );

export interface NotCandidate {
  authIndex: string;
  reason: NotCandidateReason;
  /** Cooldown end, epoch ms; null when unknown or not applicable. */
  until: number | null;
}

export interface PoolRanking {
  provider: string;
  /** null: ranked for any model (credential scope). */
  model: string | null;
  /** false when the active strategy does not rank; entries are then in ID order. */
  ranked: boolean;
  longWindows: string[];
  entries: RankEntry[];
  notCandidates: NotCandidate[];
}

export interface RoutingRanking {
  strategy: string;
  pools: PoolRanking[];
}

const reader = new ShapeReader('GET /routing/ranking');

const finite = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : reader.fail(path, 'a number');

const integer = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : reader.fail(path, 'an integer');

const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null =>
  value === null || value === undefined ? null : read(value);

const strings = (value: unknown, path: string): string[] =>
  reader.array(value, path).map((item, index) => reader.string(item, `${path}[${index}]`));

const parseEntry = (value: unknown, path: string): RankEntry => {
  const raw = reader.record(value, path);
  const base: RankBase = {
    authIndex: reader.string(raw.auth_index, `${path}.auth_index`),
    rank: reader.count(raw.rank, `${path}.rank`),
    priority: integer(raw.priority, `${path}.priority`),
    topBand: reader.boolean(raw.top_band, `${path}.top_band`),
    longWindows: strings(raw.long_windows, `${path}.long_windows`),
    observedAt: nullable(raw.observed_at, (v) => reader.instant(v, `${path}.observed_at`)),
    stale: reader.boolean(raw.stale, `${path}.stale`),
  };
  const rankClass = reader.oneOf(raw.class, RANK_CLASSES, `${path}.class`);
  switch (rankClass) {
    case 'ready':
    case 'burst_low':
      return {
        ...base,
        class: rankClass,
        pace: finite(raw.pace, `${path}.pace`),
        paceWindow: reader.string(raw.pace_window, `${path}.pace_window`),
        resetsAt: nullable(raw.resets_at, (v) => reader.instant(v, `${path}.resets_at`)),
        estimated: reader.boolean(raw.estimated, `${path}.estimated`),
        shortRemaining: nullable(raw.short_remaining, (v) => finite(v, `${path}.short_remaining`)),
      };
    case 'exhausted':
      return {
        ...base,
        class: rankClass,
        window: reader.string(raw.exhausted_window, `${path}.exhausted_window`),
        backAt: nullable(raw.back_at, (v) => reader.instant(v, `${path}.back_at`)),
      };
    case 'unknown':
      return { ...base, class: rankClass };
  }
};

const parsePool = (value: unknown, path: string): PoolRanking => {
  const raw = reader.record(value, path);
  return {
    provider: reader.string(raw.provider, `${path}.provider`),
    model: nullable(raw.model, (v) => reader.string(v, `${path}.model`)),
    ranked: reader.boolean(raw.ranked, `${path}.ranked`),
    longWindows: strings(raw.long_windows, `${path}.long_windows`),
    entries: reader
      .array(raw.entries, `${path}.entries`)
      .map((entry, index) => parseEntry(entry, `${path}.entries[${index}]`)),
    notCandidates: reader.array(raw.not_candidates, `${path}.not_candidates`).map((item, index) => {
      const itemPath = `${path}.not_candidates[${index}]`;
      const nc = reader.record(item, itemPath);
      return {
        authIndex: reader.string(nc.auth_index, `${itemPath}.auth_index`),
        reason: reader.oneOf(nc.reason, NOT_CANDIDATE_REASONS, `${itemPath}.reason`),
        until: nullable(nc.until, (v) => reader.instant(v, `${itemPath}.until`)),
      };
    }),
  };
};

/** Parses a 200 response body. */
export function parseRoutingRanking(payload: unknown): RoutingRanking {
  const body = reader.record(payload, 'body');
  return {
    strategy: reader.string(body.strategy, 'strategy'),
    pools: reader
      .array(body.pools, 'pools')
      .map((pool, index) => parsePool(pool, `pools[${index}]`)),
  };
}

export const routingRankingApi = {
  /** Ranking of one provider (or of Claude and Codex when omitted), optionally for one model. */
  async get(params: { provider?: string; model?: string } = {}): Promise<RoutingRanking> {
    const query = new URLSearchParams();
    if (params.provider) query.set('provider', params.provider);
    if (params.model) query.set('model', params.model);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return parseRoutingRanking(await apiClient.get<unknown>(`/routing/ranking${suffix}`));
  },
};
