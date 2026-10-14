/**
 * The pace selector's view of each Quota card, from `GET /routing/ranking`.
 * React-free — consumed directly by tests/quotaRouting.test.ts.
 */

import type { TFunction } from 'i18next';
import type { NotCandidate, PoolRanking, RankEntry } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { cooldownRemainingSeconds } from '@/features/authFiles/cooldowns';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { QUOTA_TAB_ORDER } from './constants';
import type { QuotaFileEntry } from './logic';

/** Where the selector puts one account. */
export type CardRouting =
  | { tag: 'ranked'; entry: RankEntry; poolSize: number }
  | { tag: 'notCandidate'; candidate: NotCandidate };

/** Routing per auth_index, from the pools the server ranks. */
export function routingByAuthIndex(
  pools: readonly PoolRanking[]
): ReadonlyMap<string, CardRouting> {
  const out = new Map<string, CardRouting>();
  pools
    .filter((pool) => pool.ranked)
    .forEach((pool) => {
      pool.entries.forEach((entry) =>
        out.set(entry.authIndex, { tag: 'ranked', entry, poolSize: pool.entries.length })
      );
      pool.notCandidates.forEach((candidate) =>
        out.set(candidate.authIndex, { tag: 'notCandidate', candidate })
      );
    });
  return out;
}

/** Ranks stay within their provider group, which keeps the default grouping readable. */
const RANK_GROUP_SPAN = 1_000_000;

/** Sort key for the `routing` mode: provider group, then rank; null for unranked cards. */
export function routingSortKey(
  entry: QuotaFileEntry,
  routing: CardRouting | undefined
): number | null {
  if (routing?.tag !== 'ranked') return null;
  return QUOTA_TAB_ORDER.indexOf(entry.type) * RANK_GROUP_SPAN + routing.entry.rank;
}

/** `3.7×`, `12×`, `<0.1×`: one decimal while it carries information. */
export function formatPace(pace: number): string {
  if (pace < 0.1) return '<0.1×';
  if (pace >= 10) return `${Math.round(pace)}×`;
  return `${pace.toFixed(1)}×`;
}

/** i18n keys of the quota windows the ranking names. Unknown ids show as they are. */
const WINDOW_LABEL_KEYS: Record<string, string> = {
  'five-hour': 'claude_quota.five_hour',
  'seven-day': 'claude_quota.seven_day',
  'seven-day-fable': 'claude_quota.seven_day_fable',
  weekly: 'codex_quota.secondary_window',
  monthly: 'codex_quota.team_secondary_window',
};

const windowLabel = (t: TFunction, windowId: string): string =>
  windowId in WINDOW_LABEL_KEYS ? t(WINDOW_LABEL_KEYS[windowId]) : windowId;

export interface ModelCooldown {
  model: string;
  remainingSeconds: number;
}

/**
 * The account's active model-scoped cooldowns, from the credential list (`cooldownSnapshot`).
 * A model cooldown keeps the account ranked for other models, so the card names it.
 */
export function activeModelCooldowns(file: AuthFileItem, nowMs: number): ModelCooldown[] {
  const snapshot = file.cooldownSnapshot;
  if (!snapshot?.records) return [];
  return snapshot.records.flatMap((record) => {
    const remainingSeconds = cooldownRemainingSeconds(record, snapshot.receivedAtMs, nowMs);
    if (record.scope !== 'model' || !record.modelKey || remainingSeconds <= 0) return [];
    return [{ model: record.modelKey, remainingSeconds }];
  });
}

/** Tooltip of the rank chip. */
export function routingRankTitle(t: TFunction, entry: RankEntry, poolSize: number): string {
  const rank = t('quota_routing.rank_title', { rank: entry.rank, total: poolSize });
  return entry.topBand ? `${rank}. ${t('quota_routing.top_band_title')}` : rank;
}

export interface RoutingNote {
  text: string;
  title?: string;
  /** The account is held back: shown in the warning colour. */
  warn: boolean;
}

function rankedNotes(t: TFunction, entry: RankEntry, when: (ms: number) => string): RoutingNote[] {
  switch (entry.class) {
    case 'ready':
    case 'burst_low': {
      const window = windowLabel(t, entry.paceWindow);
      const parts = [t('quota_routing.pace', { pace: formatPace(entry.pace), window })];
      if (entry.estimated) parts.push(t('quota_routing.estimated'));
      if (entry.stale) parts.push(t('quota_routing.stale'));
      const pace = {
        text: parts.join(' · '),
        title: t('quota_routing.pace_title', { window }),
        warn: false,
      };
      if (entry.class === 'ready' || entry.shortRemaining === null) return [pace];
      const percent = Math.round(entry.shortRemaining * 100);
      return [pace, { text: t('quota_routing.burst_low', { percent }), warn: true }];
    }
    case 'exhausted': {
      const window = windowLabel(t, entry.window);
      return [
        {
          text:
            entry.backAt === null
              ? t('quota_routing.exhausted', { window })
              : t('quota_routing.exhausted_until', { window, when: when(entry.backAt) }),
          warn: true,
        },
      ];
    }
    case 'unknown':
      return [{ text: t('quota_routing.unknown'), warn: false }];
  }
}

/** What a card says about routing: its pace or why it is held back, then model cooldowns. */
export function routingNotes(
  t: TFunction,
  routing: CardRouting,
  file: AuthFileItem,
  nowMs: number,
  locale: string
): RoutingNote[] {
  const when = (ms: number) => formatRelativeInstant(ms, nowMs, locale);
  let notes: RoutingNote[];
  if (routing.tag === 'ranked') {
    notes = rankedNotes(t, routing.entry, when);
  } else {
    const { reason, until } = routing.candidate;
    notes = [
      {
        text:
          reason === 'cooldown' && until !== null
            ? t('quota_routing.not_routed_cooldown_until', { when: when(until) })
            : t(`quota_routing.not_routed_${reason}`),
        warn: true,
      },
    ];
  }
  const cooldowns = activeModelCooldowns(file, nowMs).map((cooldown) => ({
    text: t('quota_routing.model_cooldown', {
      model: cooldown.model,
      when: when(nowMs + cooldown.remainingSeconds * 1000),
    }),
    warn: true,
  }));
  return [...notes, ...cooldowns];
}
