/**
 * Usage history from the fork's usage store: `GET /observability/usage/{series,totals}`.
 *
 * Token buckets never overlap: `input` is uncached input and `output` excludes reasoning, so
 * total tokens = input + cacheRead + cacheWrite + output + reasoning + unclassified.
 */

import type { ApiError } from '@/types';
import { apiClient } from './client';
import { ShapeReader } from './responseShape';

/** CLIProxyAPI `auth_index`: identifies one credential. */
export type AuthIndex = string & { readonly __brand: 'AuthIndex' };

export const USAGE_BUCKETS = ['1h', '1d'] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

export const USAGE_GROUP_BYS = ['provider', 'auth_index', 'model'] as const;
export type UsageGroupBy = (typeof USAGE_GROUP_BYS)[number];

export interface UsageCounters {
  requests: number;
  failed: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  unclassified: number;
}

export interface UsagePoint extends UsageCounters {
  /** Bucket start, epoch ms. */
  t: number;
}

export interface UsageSeries {
  /** Value of the group dimension: provider id, auth_index or model name. */
  key: string;
  /** Sparse: only buckets with data, in ascending `t`. */
  points: UsagePoint[];
}

export interface UsageSeriesResult {
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  /** Server-aligned window, epoch ms; `to` is exclusive. */
  from: number;
  to: number;
  series: UsageSeries[];
}

export interface UsageTotalsRow extends UsageCounters {
  provider: string;
  authIndex: AuthIndex;
  model: string;
}

export interface UsageTotalsResult {
  from: number;
  to: number;
  rows: UsageTotalsRow[];
}

export interface UsageWindowQuery {
  /** Epoch ms; the server aligns `from` down and `to` up to whole hours. */
  from: number;
  to: number;
}

export interface UsageSeriesQuery extends UsageWindowQuery {
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  /** IANA zone whose local midnights start `1d` buckets. */
  timeZone: string;
}

/** The server runs with `observability.usage.store` off (404 `usage_store_disabled`). */
export class UsageStoreDisabledError extends Error {
  constructor() {
    super('The usage store is disabled on this server');
    this.name = 'UsageStoreDisabledError';
  }
}

const SERIES_ENDPOINT = '/observability/usage/series';
const TOTALS_ENDPOINT = '/observability/usage/totals';
const seriesReader = new ShapeReader(`GET ${SERIES_ENDPOINT}`);
const totalsReader = new ShapeReader(`GET ${TOTALS_ENDPOINT}`);

const parseCounters = (
  reader: ShapeReader,
  record: Record<string, unknown>,
  path: string
): UsageCounters => ({
  requests: reader.count(record.requests, `${path}.requests`),
  failed: reader.count(record.failed, `${path}.failed`),
  input: reader.count(record.input, `${path}.input`),
  cacheRead: reader.count(record.cache_read, `${path}.cache_read`),
  cacheWrite: reader.count(record.cache_write, `${path}.cache_write`),
  output: reader.count(record.output, `${path}.output`),
  reasoning: reader.count(record.reasoning, `${path}.reasoning`),
  unclassified: reader.count(record.unclassified, `${path}.unclassified`),
});

const parseWindow = (reader: ShapeReader, body: Record<string, unknown>) => {
  const from = reader.instant(body.from, 'from');
  const to = reader.instant(body.to, 'to');
  if (to <= from) reader.fail('to', 'later than from');
  return { from, to };
};

const parseSeriesEntry = (value: unknown, path: string): UsageSeries => {
  const record = seriesReader.record(value, path);
  const key = seriesReader.string(record.key, `${path}.key`);
  const seen = new Set<number>();
  const points = seriesReader.array(record.points, `${path}.points`).map((entry, index) => {
    const pointPath = `${path}.points[${index}]`;
    const point = seriesReader.record(entry, pointPath);
    const t = seriesReader.instant(point.t, `${pointPath}.t`);
    if (seen.has(t)) seriesReader.fail(`${pointPath}.t`, 'unique within the series');
    seen.add(t);
    return { t, ...parseCounters(seriesReader, point, pointPath) };
  });
  return { key, points };
};

export function parseUsageSeries(payload: unknown): UsageSeriesResult {
  const body = seriesReader.record(payload, 'body');
  const keys = new Set<string>();
  const series = seriesReader.array(body.series, 'series').map((entry, index) => {
    const parsed = parseSeriesEntry(entry, `series[${index}]`);
    if (keys.has(parsed.key)) seriesReader.fail(`series[${index}].key`, 'unique');
    keys.add(parsed.key);
    return parsed;
  });
  return {
    bucket: seriesReader.oneOf(body.bucket, USAGE_BUCKETS, 'bucket'),
    groupBy: seriesReader.oneOf(body.group_by, USAGE_GROUP_BYS, 'group_by'),
    ...parseWindow(seriesReader, body),
    series,
  };
}

export function parseUsageTotals(payload: unknown): UsageTotalsResult {
  const body = totalsReader.record(payload, 'body');
  const rows = totalsReader.array(body.rows, 'rows').map((entry, index) => {
    const path = `rows[${index}]`;
    const row = totalsReader.record(entry, path);
    return {
      provider: totalsReader.string(row.provider, `${path}.provider`),
      authIndex: totalsReader.string(row.auth_index, `${path}.auth_index`) as AuthIndex,
      model: totalsReader.string(row.model, `${path}.model`),
      ...parseCounters(totalsReader, row, path),
    };
  });
  return { ...parseWindow(totalsReader, body), rows };
}

/** RFC 3339 in UTC without milliseconds, as the contract examples write it. */
const toRfc3339 = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const rethrowStoreDisabled = (error: unknown): never => {
  const apiError = error as ApiError;
  if (
    error instanceof Error &&
    apiError.status === 404 &&
    apiError.apiCode === 'usage_store_disabled'
  ) {
    throw new UsageStoreDisabledError();
  }
  throw error;
};

export async function getUsageSeries(query: UsageSeriesQuery): Promise<UsageSeriesResult> {
  const payload = await apiClient
    .get<unknown>(SERIES_ENDPOINT, {
      params: {
        from: toRfc3339(query.from),
        to: toRfc3339(query.to),
        bucket: query.bucket,
        tz: query.timeZone,
        group_by: query.groupBy,
      },
    })
    .catch(rethrowStoreDisabled);
  const result = parseUsageSeries(payload);
  if (result.bucket !== query.bucket) seriesReader.fail('bucket', `"${query.bucket}" as requested`);
  if (result.groupBy !== query.groupBy) {
    seriesReader.fail('group_by', `"${query.groupBy}" as requested`);
  }
  return result;
}

export async function getUsageTotals(query: UsageWindowQuery): Promise<UsageTotalsResult> {
  const payload = await apiClient
    .get<unknown>(TOTALS_ENDPOINT, {
      params: { from: toRfc3339(query.from), to: toRfc3339(query.to) },
    })
    .catch(rethrowStoreDisabled);
  return parseUsageTotals(payload);
}
