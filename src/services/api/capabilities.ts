/**
 * Backend feature detection: `GET /server/capabilities`.
 *
 * Only the ai-api-proxy fork of CLIProxyAPI serves this endpoint; upstream answers 404.
 * Fields added after the endpoint itself (`quota_cache`, `usage_store`) may be missing on
 * older fork builds, and a missing field means the feature is not available.
 */

import type { ApiError } from '@/types';
import { apiClient } from './client';
import { ShapeReader } from './responseShape';

export const STRATEGY_NAMES = [
  'round-robin',
  'weighted-round-robin',
  'fill-first',
  'soonest-reset',
] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

export type UsageStoreCapability = { enabled: false } | { enabled: true; droppedRecords: number };

export type ForkCapabilities = {
  tag: 'fork';
  configWritable: boolean;
  quotaCache: boolean;
  usageStore: UsageStoreCapability;
  /** Strategies the server can run; names this panel does not know are dropped. */
  strategies: StrategyName[];
};

export type Capabilities = { tag: 'upstream' } | ForkCapabilities;

const reader = new ShapeReader('GET /server/capabilities');
const reportedUnknownStrategies = new Set<string>();

const isStrategyName = (value: string): value is StrategyName =>
  (STRATEGY_NAMES as readonly string[]).includes(value);

const parseUsageStore = (value: unknown): UsageStoreCapability => {
  if (value === undefined) return { enabled: false };
  const record = reader.record(value, 'usage_store');
  if (!reader.boolean(record.enabled, 'usage_store.enabled')) return { enabled: false };
  return {
    enabled: true,
    droppedRecords: reader.count(record.dropped_records, 'usage_store.dropped_records'),
  };
};

const parseStrategies = (value: unknown): StrategyName[] =>
  reader.array(value, 'strategies').flatMap((entry, index) => {
    const name = reader.string(entry, `strategies[${index}]`);
    if (isStrategyName(name)) return [name];
    if (!reportedUnknownStrategies.has(name)) {
      reportedUnknownStrategies.add(name);
      console.warn(`Ignoring routing strategy unknown to this panel: ${name}`);
    }
    return [];
  });

/** Parses a 200 response body. */
export function parseCapabilities(payload: unknown): ForkCapabilities {
  const body = reader.record(payload, 'body');
  return {
    tag: 'fork',
    configWritable: reader.boolean(body.config_writable, 'config_writable'),
    quotaCache:
      body.quota_cache === undefined ? false : reader.boolean(body.quota_cache, 'quota_cache'),
    usageStore: parseUsageStore(body.usage_store),
    strategies: parseStrategies(body.strategies),
  };
}

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && (error as ApiError).status === 404;

export async function getServerCapabilities(): Promise<Capabilities> {
  let payload: unknown;
  try {
    payload = await apiClient.get<unknown>('/server/capabilities');
  } catch (error) {
    if (isNotFound(error)) return { tag: 'upstream' };
    throw error;
  }
  return parseCapabilities(payload);
}

let cachedCapabilities: { revision: number; value: Promise<Capabilities> } | null = null;

/**
 * Capabilities of the current connection, read once per connection revision. A failed read is
 * not kept, so the next call tries again.
 */
export function getCachedServerCapabilities(): Promise<Capabilities> {
  const revision = apiClient.getConnectionRevision();
  if (cachedCapabilities?.revision !== revision) {
    const value = getServerCapabilities();
    cachedCapabilities = { revision, value };
    value.catch(() => {
      if (cachedCapabilities?.value === value) cachedCapabilities = null;
    });
  }
  return cachedCapabilities.value;
}

/** True when the server reads Claude and Codex quota itself (fork, `observability.quota`). */
export async function serverReadsQuota(): Promise<boolean> {
  const capabilities = await getCachedServerCapabilities();
  return capabilities.tag === 'fork' && capabilities.quotaCache;
}
