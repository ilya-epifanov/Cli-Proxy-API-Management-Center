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
  /** A new session picks one top-band account at random. */
  topBand: boolean;
  stale: boolean;
}

export type RankEntry = RankBase &
  (
    | {
        class: 'ready' | 'burst_low';
        /** Remaining share of the pace window divided by the share of its time left. */
        pace: number;
        paceWindow: string;
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

export const RUNWAY_REASONS = ['clear', 'short', 'reserve', 'learning'] as const;
export type RunwayReason = (typeof RUNWAY_REASONS)[number];

/** The operator's speed for a pool, replacing the computed one until cleared. */
export interface ThrottleOverride {
  /** Share of full speed, 0 to 1; 1 never delays. */
  speed: number;
}

interface RunwayBase {
  /** What each new request for this pool waits now, the override applied; 0 when the throttle is off. */
  delayMs: number;
  /** What a request would wait without the override. */
  computedDelayMs: number;
  /** null unless the operator set one; reason and speed stay the computed ones. */
  override: ThrottleOverride | null;
  /** The longest a request waits; 0 means the throttle is off. */
  maxDelayMs: number;
  /** Short windows not sized yet, left out of the plan. */
  unsized: string[];
}

/**
 * Whether the pool lasts the next 7 days at the forecast demand, and how much the throttle
 * slows requests to make it:
 * - `clear`: it lasts; no delay.
 * - `short`: it runs dry at `dryAt` at full speed; the throttle slows requests to make it last.
 * - `reserve`: the accounts that can serve now hold under ~2 hours of demand; requests wait the
 *   maximum.
 * - `learning`: no account has spent enough of its weekly window to size it; the throttle does
 *   nothing.
 */
export type PoolRunway =
  | (RunwayBase & { reason: 'clear' | 'reserve' | 'learning' })
  | (RunwayBase & {
      reason: 'short';
      /** When the pool runs out at full speed, epoch ms. */
      dryAt: number;
    });

export interface PoolRanking {
  provider: string;
  /** false when the active strategy does not rank; entries are then in ID order. */
  ranked: boolean;
  entries: RankEntry[];
  notCandidates: NotCandidate[];
  /** null when the strategy is not pace, or the server predates the runway. */
  runway: PoolRunway | null;
}

export interface RoutingRanking {
  pools: PoolRanking[];
}

const reader = new ShapeReader('GET /routing/ranking');

const parseEntry = (value: unknown, path: string): RankEntry => {
  const raw = reader.record(value, path);
  const base: RankBase = {
    authIndex: reader.string(raw.auth_index, `${path}.auth_index`),
    rank: reader.count(raw.rank, `${path}.rank`),
    topBand: reader.boolean(raw.top_band, `${path}.top_band`),
    stale: reader.boolean(raw.stale, `${path}.stale`),
  };
  const rankClass = reader.oneOf(raw.class, RANK_CLASSES, `${path}.class`);
  switch (rankClass) {
    case 'ready':
    case 'burst_low':
      return {
        ...base,
        class: rankClass,
        pace: reader.number(raw.pace, `${path}.pace`),
        paceWindow: reader.string(raw.pace_window, `${path}.pace_window`),
        estimated: reader.boolean(raw.estimated, `${path}.estimated`),
        shortRemaining: reader.nullable(raw.short_remaining, (v) =>
          reader.number(v, `${path}.short_remaining`)
        ),
      };
    case 'exhausted':
      return {
        ...base,
        class: rankClass,
        window: reader.string(raw.exhausted_window, `${path}.exhausted_window`),
        backAt: reader.nullable(raw.back_at, (v) => reader.instant(v, `${path}.back_at`)),
      };
    case 'unknown':
      return { ...base, class: rankClass };
  }
};

const parseSpeed = (value: unknown, path: string): number => {
  const speed = reader.number(value, path);
  if (speed < 0 || speed > 1) reader.fail(path, 'a number between 0 and 1');
  return speed;
};

const parseOverride = (value: unknown, path: string): ThrottleOverride => {
  const raw = reader.record(value, path);
  return {
    speed: parseSpeed(raw.speed, `${path}.speed`),
  };
};

const parseRunway = (value: unknown, path: string): PoolRunway => {
  const raw = reader.record(value, path);
  const base: RunwayBase = {
    delayMs: reader.count(raw.delay_ms, `${path}.delay_ms`),
    computedDelayMs: reader.count(raw.computed_delay_ms, `${path}.computed_delay_ms`),
    override: reader.nullable(raw.override, (v) => parseOverride(v, `${path}.override`)),
    maxDelayMs: reader.count(raw.max_delay_ms, `${path}.max_delay_ms`),
    unsized: reader.strings(raw.unsized, `${path}.unsized`),
  };
  const reason = reader.oneOf(raw.reason, RUNWAY_REASONS, `${path}.reason`);
  if (reason === 'short') {
    const dryAt = reader.nullable(raw.dry_at, (v) => reader.instant(v, `${path}.dry_at`));
    if (dryAt === null)
      return reader.fail(`${path}.dry_at`, 'a timestamp when the pool runs short');
    return { ...base, reason, dryAt };
  }
  return { ...base, reason };
};

const parsePool = (value: unknown, path: string): PoolRanking => {
  const raw = reader.record(value, path);
  return {
    provider: reader.string(raw.provider, `${path}.provider`),
    ranked: reader.boolean(raw.ranked, `${path}.ranked`),
    entries: reader
      .array(raw.entries, `${path}.entries`)
      .map((entry, index) => parseEntry(entry, `${path}.entries[${index}]`)),
    notCandidates: reader.array(raw.not_candidates, `${path}.not_candidates`).map((item, index) => {
      const itemPath = `${path}.not_candidates[${index}]`;
      const nc = reader.record(item, itemPath);
      return {
        authIndex: reader.string(nc.auth_index, `${itemPath}.auth_index`),
        reason: reader.oneOf(nc.reason, NOT_CANDIDATE_REASONS, `${itemPath}.reason`),
        until: reader.nullable(nc.until, (v) => reader.instant(v, `${itemPath}.until`)),
      };
    }),
    runway: reader.nullable(raw.runway, (v) => parseRunway(v, `${path}.runway`)),
  };
};

/** Parses a 200 response body. */
export function parseRoutingRanking(payload: unknown): RoutingRanking {
  const body = reader.record(payload, 'body');
  return {
    pools: reader
      .array(body.pools, 'pools')
      .map((pool, index) => parsePool(pool, `pools[${index}]`)),
  };
}

export const routingRankingApi = {
  /** Ranking of one provider (or of Claude and Codex when omitted), optionally for one model. */
  async get(params: { provider?: string; model?: string } = {}): Promise<RoutingRanking> {
    return parseRoutingRanking(await apiClient.get<unknown>('/routing/ranking', { params }));
  },

  /** Runs `provider`'s pool at `speed` (0 to 1) until cleared, whatever its runway says. */
  async setThrottleOverride(provider: string, speed: number): Promise<void> {
    await apiClient.put(`/routing/throttle/overrides/${encodeURIComponent(provider)}`, { speed });
  },

  /** Returns `provider`'s pool to the computed throttle. */
  async clearThrottleOverride(provider: string): Promise<void> {
    await apiClient.delete(`/routing/throttle/overrides/${encodeURIComponent(provider)}`);
  },
};
