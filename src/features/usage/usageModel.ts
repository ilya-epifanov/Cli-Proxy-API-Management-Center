/**
 * Pure logic behind the Usage page: query windows, gap filling, top-N stacking with stable
 * colours, and the provider ▸ account ▸ model tree. Components only render what these return.
 */

import { providerLabel } from '@/features/dashboard/utils';
import type {
  UsageBucket,
  UsageCounters,
  UsageGroupBy,
  UsageSeries,
  UsageTotalsRow,
} from '@/services/api/usageHistory';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { addZonedDays, zonedParts } from './zonedTime';

const HOUR_MS = 3_600_000;

/* ---------- ranges ---------- */

export const USAGE_RANGES = ['24h', '7d', '30d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const USAGE_METRICS = ['tokens', 'requests'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

const RANGE_SPECS: Record<UsageRange, { bucket: UsageBucket; buckets: number }> = {
  '24h': { bucket: '1h', buckets: 24 },
  '7d': { bucket: '1h', buckets: 7 * 24 },
  '30d': { bucket: '1d', buckets: 30 },
};

export const rangeBucket = (range: UsageRange): UsageBucket => RANGE_SPECS[range].bucket;

export interface UsageWindow {
  from: number;
  to: number;
  bucket: UsageBucket;
}

/**
 * The query window for `range`, ending with the hour that contains `nowMs`. Day ranges start at
 * the first whole UTC hour from local midnight in `timeZone`, so the last bucket is today so far.
 * The server keeps whole hours and assigns an hour to the day it starts in: in a zone with a
 * half-hour offset, the hour around the first midnight belongs to the day before, which rounding
 * down would add as an extra column.
 */
export function usageWindow(range: UsageRange, nowMs: number, timeZone: string): UsageWindow {
  const { bucket, buckets } = RANGE_SPECS[range];
  const to = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  const from =
    bucket === '1h'
      ? to - buckets * HOUR_MS
      : Math.ceil(addZonedDays(nowMs, -(buckets - 1), timeZone) / HOUR_MS) * HOUR_MS;
  return { from, to, bucket };
}

/**
 * Bucket starts covering the server-aligned window [from, to). Day buckets start at local
 * midnight in `timeZone`; the first one starts at or before `from` and may be partial.
 */
export function bucketStarts(
  bucket: UsageBucket,
  from: number,
  to: number,
  timeZone: string
): number[] {
  const starts: number[] = [];
  if (bucket === '1h') {
    for (let t = Math.floor(from / HOUR_MS) * HOUR_MS; t < to; t += HOUR_MS) starts.push(t);
    return starts;
  }
  // Count calendar dates from `from`'s local date. Stepping from the previous start instead
  // stalls where local midnight does not exist: that start falls on the evening before.
  for (let day = 0; ; day += 1) {
    const t = addZonedDays(from, day, timeZone);
    if (t >= to) return starts;
    // A date a zone skipped entirely starts where the next date starts.
    if (starts.length === 0 || t > starts[starts.length - 1]) starts.push(t);
  }
}

/** Indices of the buckets that get an x-axis label. */
export function axisTickIndices(
  range: UsageRange,
  starts: readonly number[],
  timeZone: string
): number[] {
  if (range === '30d') {
    // Count weeks back from today, so the latest day is always labelled.
    return starts.flatMap((_, index) => ((starts.length - 1 - index) % 7 === 0 ? [index] : []));
  }
  const step = range === '24h' ? 6 : 24;
  return starts.flatMap((t, index) => (zonedParts(t, timeZone).hour % step === 0 ? [index] : []));
}

/* ---------- counters ---------- */

export const ZERO_COUNTERS: Readonly<UsageCounters> = Object.freeze({
  requests: 0,
  failed: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  unclassified: 0,
});

export const addCounters = (a: UsageCounters, b: UsageCounters): UsageCounters => ({
  requests: a.requests + b.requests,
  failed: a.failed + b.failed,
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  unclassified: a.unclassified + b.unclassified,
});

export const sumCounters = (items: readonly UsageCounters[]): UsageCounters =>
  items.reduce<UsageCounters>(addCounters, ZERO_COUNTERS);

/** The token buckets are disjoint, so their sum is the total. */
export const totalTokens = (c: UsageCounters): number =>
  c.input + c.cacheRead + c.cacheWrite + c.output + c.reasoning + c.unclassified;

export const metricValue = (c: UsageCounters, metric: UsageMetric): number =>
  metric === 'tokens' ? totalTokens(c) : c.requests;

/* ---------- gap filling ---------- */

/** A series point outside the window the server echoed: the response contradicts itself. */
export class UsageTimelineError extends Error {
  constructor(
    readonly key: string,
    readonly t: number
  ) {
    super(`Usage series "${key}" has a point at ${new Date(t).toISOString()} outside its window`);
    this.name = 'UsageTimelineError';
  }
}

export interface FilledSeries {
  key: string;
  /** One entry per bucket start, zero where the server sent no point. */
  buckets: UsageCounters[];
  total: UsageCounters;
}

/** Index of the bucket containing `t`, or -1 when `t` is outside [starts[0], to). */
const bucketIndex = (starts: readonly number[], to: number, t: number): number => {
  if (starts.length === 0 || t < starts[0] || t >= to) return -1;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= t) low = mid;
    else high = mid - 1;
  }
  return low;
};

export function fillSeries(
  series: readonly UsageSeries[],
  starts: readonly number[],
  to: number
): FilledSeries[] {
  return series.map(({ key, points }) => {
    const buckets = starts.map((): UsageCounters => ({ ...ZERO_COUNTERS }));
    for (const point of points) {
      const index = bucketIndex(starts, to, point.t);
      if (index < 0) throw new UsageTimelineError(key, point.t);
      buckets[index] = addCounters(buckets[index], point);
    }
    return { key, buckets, total: sumCounters(buckets) };
  });
}

/* ---------- stacking ---------- */

/** Groups drawn with their own colour; the rest fold into "other". */
export const STACK_LIMIT = 6;
export type SeriesSlot = 0 | 1 | 2 | 3 | 4 | 5;

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Groups with a non-zero metric, largest first: the top STACK_LIMIT and the folded rest. */
export function rankGroups(
  filled: readonly FilledSeries[],
  metric: UsageMetric
): { members: string[]; folded: string[] } {
  const ranked = filled
    .map((series) => ({ key: series.key, value: metricValue(series.total, metric) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || compareKeys(a.key, b.key))
    .map((entry) => entry.key);
  return { members: ranked.slice(0, STACK_LIMIT), folded: ranked.slice(STACK_LIMIT) };
}

/**
 * Colour slots for `members` (rank order). A group keeps its previous slot while that slot is
 * still in use, so refreshes and range changes do not repaint it. Slots stay contiguous from 0,
 * because the palette is validated for neighbouring slots only and the stack draws slot order.
 */
export function assignSeriesSlots(
  previous: ReadonlyMap<string, SeriesSlot>,
  members: readonly string[]
): Map<string, SeriesSlot> {
  const count = Math.min(members.length, STACK_LIMIT);
  const next = new Map<string, SeriesSlot>();
  const taken = new Set<SeriesSlot>();
  for (const key of members.slice(0, count)) {
    const slot = previous.get(key);
    if (slot !== undefined && slot < count && !taken.has(slot)) {
      next.set(key, slot);
      taken.add(slot);
    }
  }
  const free = (Array.from({ length: count }, (_, slot) => slot) as SeriesSlot[]).filter(
    (slot) => !taken.has(slot)
  );
  for (const key of members.slice(0, count)) {
    if (!next.has(key)) next.set(key, free.shift() as SeriesSlot);
  }
  return next;
}

export type StackLayer =
  | { kind: 'group'; key: string; slot: SeriesSlot; values: number[]; total: number }
  | { kind: 'other'; keys: string[]; values: number[]; total: number };

export interface UsageStack {
  /** Bottom to top: groups in slot order, then "other". */
  layers: StackLayer[];
  columnTotals: number[];
  peak: { index: number; value: number } | null;
  total: number;
}

export function buildUsageStack(
  filled: readonly FilledSeries[],
  slots: ReadonlyMap<string, SeriesSlot>,
  folded: readonly string[],
  metric: UsageMetric,
  bucketCount: number
): UsageStack {
  const byKey = new Map(filled.map((series) => [series.key, series]));
  const valuesOf = (keys: readonly string[]): number[] =>
    Array.from({ length: bucketCount }, (_, index) =>
      keys.reduce((sum, key) => {
        const bucket = byKey.get(key)?.buckets[index];
        return bucket ? sum + metricValue(bucket, metric) : sum;
      }, 0)
    );
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

  const layers: StackLayer[] = Array.from(slots, ([key, slot]) => {
    const values = valuesOf([key]);
    return { kind: 'group' as const, key, slot, values, total: sum(values) };
  }).sort((a, b) => a.slot - b.slot);
  if (folded.length > 0) {
    const values = valuesOf(folded);
    layers.push({ kind: 'other', keys: [...folded], values, total: sum(values) });
  }

  const columnTotals = Array.from({ length: bucketCount }, (_, index) =>
    layers.reduce((total, layer) => total + layer.values[index], 0)
  );
  let peak: UsageStack['peak'] = null;
  for (let index = 0; index < columnTotals.length; index += 1) {
    const value = columnTotals[index];
    if (value > 0 && (peak === null || value > peak.value)) peak = { index, value };
  }
  return { layers, columnTotals, peak, total: sum(columnTotals) };
}

/* ---------- provider ▸ account ▸ model tree ---------- */

export type UsageTreeLevel = 'provider' | 'account' | 'model';

export interface UsageTreeNode {
  /** Unique across the tree; stable across refreshes. */
  id: string;
  level: UsageTreeLevel;
  /** Provider id, auth_index or model name. */
  key: string;
  counters: UsageCounters;
  tokens: number;
  children: UsageTreeNode[];
}

const byTokensDesc = (a: UsageTreeNode, b: UsageTreeNode) =>
  b.tokens - a.tokens || compareKeys(a.key, b.key);

const groupRows = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
};

const treeNode = (
  level: UsageTreeLevel,
  path: readonly string[],
  counters: UsageCounters,
  children: UsageTreeNode[]
): UsageTreeNode => ({
  id: JSON.stringify(path),
  level,
  key: path[path.length - 1],
  counters,
  tokens: totalTokens(counters),
  children: children.sort(byTokensDesc),
});

/** Rows sharing a provider, account and model are summed; every level sorts by total tokens. */
export function buildUsageTree(rows: readonly UsageTotalsRow[]): UsageTreeNode[] {
  return Array.from(
    groupRows(rows, (row) => row.provider),
    ([provider, providerRows]) => {
      const accounts = Array.from(
        groupRows(providerRows, (row) => row.authIndex),
        ([authIndex, accountRows]) => {
          const models = Array.from(
            groupRows(accountRows, (row) => row.model),
            ([model, modelRows]) =>
              treeNode('model', [provider, authIndex, model], sumCounters(modelRows), [])
          );
          return treeNode(
            'account',
            [provider, authIndex],
            sumCounters(models.map((m) => m.counters)),
            models
          );
        }
      );
      return treeNode(
        'provider',
        [provider],
        sumCounters(accounts.map((a) => a.counters)),
        accounts
      );
    }
  ).sort(byTokensDesc);
}

/* ---------- display names ---------- */

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** auth_index → the most recognisable name of its credential: email, else label, else file name. */
export function accountNames(files: readonly AuthFileItem[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of files) {
    const authIndex = normalizeAuthIndex(file.authIndex);
    const name = nonEmpty(file.email) ?? nonEmpty(file.label) ?? nonEmpty(file.name);
    if (authIndex && name) names.set(authIndex, name);
  }
  return names;
}

/** auth_index → provider id, from the totals rows of the same window. */
export function accountProviders(rows: readonly UsageTotalsRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.authIndex as string, row.provider]));
}

export interface GroupLabelContext {
  /** auth_index → display name (accountNames). */
  names: ReadonlyMap<string, string>;
  /** auth_index → provider id (accountProviders). */
  providers: ReadonlyMap<string, string>;
  /** Shown for an empty key and the provider id `unknown`. */
  unknownLabel: string;
}

/**
 * Label for a group key. An account shows its credential name, or the raw auth_index when no
 * credential matches, followed by its provider: one email can sign in to several providers.
 */
export function groupLabel(groupBy: UsageGroupBy, key: string, context: GroupLabelContext): string {
  const { names, providers, unknownLabel } = context;
  if (groupBy === 'provider') return providerLabel(key, unknownLabel);
  if (!key) return unknownLabel;
  if (groupBy === 'model') return key;
  const name = names.get(key) ?? key;
  const provider = providers.get(key);
  return provider === undefined ? name : `${name} · ${providerLabel(provider, unknownLabel)}`;
}
