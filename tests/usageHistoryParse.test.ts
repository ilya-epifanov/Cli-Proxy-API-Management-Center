import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { ResponseShapeError } from '@/services/api/responseShape';
import {
  getUsageSeries,
  getUsageTotals,
  parseUsageSeries,
  parseUsageTotals,
  UsageStoreDisabledError,
} from '@/services/api/usageHistory';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const wireCounters = {
  requests: 3,
  failed: 1,
  input: 100,
  cache_read: 5000,
  cache_write: 200,
  output: 300,
  reasoning: 50,
  unclassified: 7,
};

const seriesBody = (overrides: Record<string, unknown> = {}) => ({
  bucket: '1h',
  group_by: 'provider',
  from: '2026-10-08T10:00:00Z',
  to: '2026-10-09T10:00:00Z',
  series: [{ key: 'claude', points: [{ t: '2026-10-09T09:00:00Z', ...wireCounters }] }],
  ...overrides,
});

const totalsBody = (overrides: Record<string, unknown> = {}) => ({
  from: '2026-10-08T10:00:00Z',
  to: '2026-10-09T10:00:00Z',
  rows: [{ provider: 'claude', auth_index: 'a1b2c3d4', model: 'claude-fable-5', ...wireCounters }],
  ...overrides,
});

const pathOfFailure = (parse: () => unknown): string => {
  try {
    parse();
  } catch (error) {
    expect(error).toBeInstanceOf(ResponseShapeError);
    return (error as ResponseShapeError).path;
  }
  throw new Error('expected a ResponseShapeError');
};

describe('parseUsageSeries', () => {
  test('reads the contract example into epoch-ms instants and named counters', () => {
    expect(parseUsageSeries(seriesBody())).toEqual({
      bucket: '1h',
      groupBy: 'provider',
      from: Date.UTC(2026, 9, 8, 10),
      to: Date.UTC(2026, 9, 9, 10),
      series: [
        {
          key: 'claude',
          points: [
            {
              t: Date.UTC(2026, 9, 9, 9),
              requests: 3,
              failed: 1,
              input: 100,
              cacheRead: 5000,
              cacheWrite: 200,
              output: 300,
              reasoning: 50,
              unclassified: 7,
            },
          ],
        },
      ],
    });
  });

  test('accepts zone offsets and fractional seconds in timestamps', () => {
    const parsed = parseUsageSeries(
      seriesBody({ from: '2026-10-08T12:00:00+02:00', to: '2026-10-09T10:00:00.000Z' })
    );
    expect(parsed.from).toBe(Date.UTC(2026, 9, 8, 10));
    expect(parsed.to).toBe(Date.UTC(2026, 9, 9, 10));
  });

  const point = (overrides: Record<string, unknown>) => ({
    t: '2026-10-09T09:00:00Z',
    ...wireCounters,
    ...overrides,
  });

  test.each([
    ['an unknown bucket', seriesBody({ bucket: '5m' }), 'bucket'],
    ['an unknown group', seriesBody({ group_by: 'api_key_fp' }), 'group_by'],
    ['a date without a time', seriesBody({ from: '2026-10-08' }), 'from'],
    ['to not after from', seriesBody({ to: '2026-10-08T10:00:00Z' }), 'to'],
    ['series not an array', seriesBody({ series: {} }), 'series'],
    [
      'a missing counter',
      seriesBody({ series: [{ key: 'claude', points: [point({ unclassified: undefined })] }] }),
      'series[0].points[0].unclassified',
    ],
    [
      'a fractional counter',
      seriesBody({ series: [{ key: 'claude', points: [point({ input: 1.5 })] }] }),
      'series[0].points[0].input',
    ],
    [
      'a negative counter',
      seriesBody({ series: [{ key: 'claude', points: [point({ output: -1 })] }] }),
      'series[0].points[0].output',
    ],
    [
      'two points in one bucket',
      seriesBody({ series: [{ key: 'claude', points: [point({}), point({})] }] }),
      'series[0].points[1].t',
    ],
    [
      'two series with one key',
      seriesBody({
        series: [
          { key: 'claude', points: [] },
          { key: 'claude', points: [] },
        ],
      }),
      'series[1].key',
    ],
  ])('rejects %s', (_name, body, path) => {
    expect(pathOfFailure(() => parseUsageSeries(body))).toBe(path);
  });
});

describe('parseUsageTotals', () => {
  test('reads rows with their provider, account and model', () => {
    const parsed = parseUsageTotals(totalsBody());
    expect(parsed.from).toBe(Date.UTC(2026, 9, 8, 10));
    expect(parsed.rows).toEqual([
      {
        provider: 'claude',
        authIndex: 'a1b2c3d4' as never,
        model: 'claude-fable-5',
        requests: 3,
        failed: 1,
        input: 100,
        cacheRead: 5000,
        cacheWrite: 200,
        output: 300,
        reasoning: 50,
        unclassified: 7,
      },
    ]);
  });

  test('rejects a row without an auth_index', () => {
    const body = totalsBody({ rows: [{ provider: 'claude', model: 'm', ...wireCounters }] });
    expect(pathOfFailure(() => parseUsageTotals(body))).toBe('rows[0].auth_index');
  });
});

describe('usage history requests', () => {
  const mockGet = () => {
    const spy = spyOn(apiClient, 'get');
    spies.push(spy);
    return spy;
  };
  const query = {
    from: Date.UTC(2026, 9, 8, 10),
    to: Date.UTC(2026, 9, 9, 10),
    bucket: '1h' as const,
    groupBy: 'provider' as const,
    timeZone: 'Europe/Amsterdam',
  };

  test('a 404 usage_store_disabled becomes UsageStoreDisabledError', async () => {
    const disabled = Object.assign(new Error('usage_store_disabled'), {
      status: 404,
      apiCode: 'usage_store_disabled',
    });
    mockGet().mockRejectedValue(disabled);
    await expect(getUsageSeries(query)).rejects.toBeInstanceOf(UsageStoreDisabledError);
    await expect(getUsageTotals(query)).rejects.toBeInstanceOf(UsageStoreDisabledError);
  });

  test('other errors, including a plain 404, propagate unchanged', async () => {
    const get = mockGet();
    const invalid = Object.assign(new Error('bad range'), {
      status: 400,
      apiCode: 'invalid_query',
    });
    get.mockRejectedValue(invalid);
    await expect(getUsageSeries(query)).rejects.toBe(invalid);
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    get.mockRejectedValue(notFound);
    await expect(getUsageTotals(query)).rejects.toBe(notFound);
  });

  test('a series answer for a different bucket or group is rejected', async () => {
    const get = mockGet();
    get.mockResolvedValue(seriesBody({ bucket: '1d' }) as never);
    await expect(getUsageSeries(query)).rejects.toBeInstanceOf(ResponseShapeError);
    get.mockResolvedValue(seriesBody({ group_by: 'model' }) as never);
    await expect(getUsageSeries(query)).rejects.toBeInstanceOf(ResponseShapeError);
  });
});
