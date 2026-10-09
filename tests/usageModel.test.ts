import { describe, expect, test } from 'bun:test';
import {
  accountNames,
  accountProviders,
  assignSeriesSlots,
  axisTickIndices,
  bucketStarts,
  buildUsageStack,
  buildUsageTree,
  fillSeries,
  groupLabel,
  rankGroups,
  totalTokens,
  UsageTimelineError,
  usageWindow,
  ZERO_COUNTERS,
  type FilledSeries,
  type SeriesSlot,
} from '@/features/usage/usageModel';
import type { AuthIndex, UsageCounters, UsageTotalsRow } from '@/services/api/usageHistory';
import type { AuthFileItem } from '@/types';

const HOUR = 3_600_000;
const utc = (iso: string) => Date.parse(iso);
const counters = (values: Partial<UsageCounters>): UsageCounters => ({
  ...ZERO_COUNTERS,
  ...values,
});

describe('query windows and bucket starts', () => {
  test('24 h ends with the hour that contains now, in 24 hourly buckets', () => {
    const now = utc('2026-10-09T10:34:56Z');
    const window = usageWindow('24h', now, 'Europe/Amsterdam');
    expect(window).toEqual({
      bucket: '1h',
      from: utc('2026-10-08T11:00:00Z'),
      to: utc('2026-10-09T11:00:00Z'),
    });
    const starts = bucketStarts('1h', window.from, window.to, 'Europe/Amsterdam');
    expect(starts).toHaveLength(24);
    expect(starts[23]).toBe(utc('2026-10-09T10:00:00Z'));
  });

  test('7 d is 168 hourly buckets', () => {
    const window = usageWindow('7d', utc('2026-10-09T10:00:00Z'), 'UTC');
    expect(bucketStarts('1h', window.from, window.to, 'UTC')).toHaveLength(168);
  });

  test('30 d starts at local midnight and keeps one bucket per local day across a DST change', () => {
    // Europe/Amsterdam leaves summer time on 2026-10-25, so that day lasts 25 hours.
    const zone = 'Europe/Amsterdam';
    const window = usageWindow('30d', utc('2026-10-30T12:34:00Z'), zone);
    expect(window.bucket).toBe('1d');
    expect(window.from).toBe(utc('2026-09-30T22:00:00Z'));
    expect(window.to).toBe(utc('2026-10-30T13:00:00Z'));

    const starts = bucketStarts('1d', window.from, window.to, zone);
    expect(starts).toHaveLength(30);
    expect(starts).toContain(utc('2026-10-24T22:00:00Z'));
    expect(starts).toContain(utc('2026-10-25T23:00:00Z'));
    expect(starts[29]).toBe(utc('2026-10-29T23:00:00Z'));
  });

  test('a zone whose clocks jump forward at local midnight keeps one bucket per day', () => {
    // America/Santiago skips 2026-09-06 00:00 (UTC-4 → UTC-3); that day starts at 23:00 the
    // evening before, the instant Go's time.Date picks on the server.
    const zone = 'America/Santiago';
    const window = usageWindow('30d', utc('2026-09-20T12:00:00Z'), zone);
    const starts = bucketStarts('1d', window.from, window.to, zone);
    expect(starts).toHaveLength(30);
    expect(starts.every((start, index) => index === 0 || start > starts[index - 1])).toBe(true);
    expect(starts).toContain(utc('2026-09-05T04:00:00Z'));
    expect(starts).toContain(utc('2026-09-06T03:00:00Z'));
    expect(starts).toContain(utc('2026-09-07T03:00:00Z'));
  });

  test('30 d in a half-hour zone starts at a whole hour and keeps 30 buckets', () => {
    const zone = 'Asia/Kolkata';
    const window = usageWindow('30d', utc('2026-10-09T07:15:00Z'), zone);
    // Local midnight on 2026-09-10 is 18:30Z; the hour from 18:00Z belongs to the day before.
    expect(window.from).toBe(utc('2026-09-09T19:00:00Z'));
    expect(bucketStarts('1d', window.from, window.to, zone)).toHaveLength(30);
  });

  test('a window that starts mid-day gets a partial first day bucket', () => {
    // Asia/Kolkata is UTC+5:30: the server aligns local midnight (18:30Z) down to 18:00Z.
    const starts = bucketStarts(
      '1d',
      utc('2026-10-08T18:00:00Z'),
      utc('2026-10-10T07:00:00Z'),
      'Asia/Kolkata'
    );
    expect(starts).toEqual([
      utc('2026-10-07T18:30:00Z'),
      utc('2026-10-08T18:30:00Z'),
      utc('2026-10-09T18:30:00Z'),
    ]);
  });

  test('axis labels fall on 6-hour marks for 24 h and on weekly steps back from today for 30 d', () => {
    const hourly = Array.from({ length: 24 }, (_, i) => utc('2026-10-08T11:00:00Z') + i * HOUR);
    expect(
      axisTickIndices('24h', hourly, 'UTC').map((i) => new Date(hourly[i]).getUTCHours())
    ).toEqual([12, 18, 0, 6]);
    const daily = Array.from({ length: 30 }, (_, i) => i);
    expect(axisTickIndices('30d', daily, 'UTC')).toEqual([1, 8, 15, 22, 29]);
  });
});

describe('fillSeries', () => {
  const starts = [0, 1, 2, 3].map((i) => utc('2026-10-09T00:00:00Z') + i * HOUR);
  const to = starts[3] + HOUR;

  test('fills missing buckets with zeros and totals the series', () => {
    const [filled] = fillSeries(
      [
        {
          key: 'claude',
          points: [
            { t: starts[1], ...counters({ requests: 2, input: 10 }) },
            { t: starts[3], ...counters({ requests: 1, output: 5 }) },
          ],
        },
      ],
      starts,
      to
    );
    expect(filled.buckets.map((bucket) => bucket.requests)).toEqual([0, 2, 0, 1]);
    expect(filled.total).toEqual(counters({ requests: 3, input: 10, output: 5 }));
  });

  test('places a point inside a partial first bucket into that bucket', () => {
    const [filled] = fillSeries(
      [{ key: 'm', points: [{ t: starts[0] + 30 * 60_000, ...counters({ requests: 4 }) }] }],
      starts,
      to
    );
    expect(filled.buckets[0].requests).toBe(4);
  });

  test.each([
    ['before the first bucket', starts[0] - 1],
    ['at the exclusive end', to],
  ])('rejects a point %s', (_name, t) => {
    expect(() =>
      fillSeries([{ key: 'claude', points: [{ t, ...counters({ requests: 1 }) }] }], starts, to)
    ).toThrow(UsageTimelineError);
  });
});

describe('totals', () => {
  test('total tokens add the disjoint token buckets once and ignore request counts', () => {
    expect(
      totalTokens(
        counters({
          requests: 9,
          failed: 9,
          input: 1,
          cacheRead: 20,
          cacheWrite: 300,
          output: 4000,
          reasoning: 50000,
          unclassified: 600000,
        })
      )
    ).toBe(654321);
  });
});

const filledSeries = (key: string, perBucket: Partial<UsageCounters>[]): FilledSeries => {
  const buckets = perBucket.map(counters);
  const total = buckets.reduce(
    (sum, bucket) =>
      counters({ requests: sum.requests + bucket.requests, input: sum.input + bucket.input }),
    counters({})
  );
  return { key, buckets, total };
};

describe('rankGroups', () => {
  test('keeps the six largest by the metric, ties by key, and folds the rest', () => {
    const filled = ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'].map((key, index) =>
      filledSeries(key, [{ input: index < 2 ? 50 : 10 * index, requests: 1 }])
    );
    // input: h 50, g 50, f 20, e 30, d 40, c 50, b 60, a 70
    expect(rankGroups(filled, 'tokens')).toEqual({
      members: ['a', 'b', 'c', 'g', 'h', 'd'],
      folded: ['e', 'f'],
    });
  });

  test('leaves out groups with nothing to draw for the metric', () => {
    const filled = [
      filledSeries('busy', [{ input: 5, requests: 1 }]),
      filledSeries('idle', [{ requests: 2 }]),
    ];
    expect(rankGroups(filled, 'tokens').members).toEqual(['busy']);
    expect(rankGroups(filled, 'requests').members).toEqual(['idle', 'busy']);
  });
});

describe('assignSeriesSlots', () => {
  const slotsOf = (map: Map<string, SeriesSlot>) => Object.fromEntries(map);
  const expectContiguous = (map: Map<string, SeriesSlot>) =>
    expect([...map.values()].sort()).toEqual(Array.from({ length: map.size }, (_, i) => i));

  test('first assignment follows rank', () => {
    expect(slotsOf(assignSeriesSlots(new Map(), ['x', 'y', 'z']))).toEqual({ x: 0, y: 1, z: 2 });
  });

  test('a change of rank does not repaint any group', () => {
    const previous = assignSeriesSlots(new Map(), ['x', 'y', 'z']);
    expect(slotsOf(assignSeriesSlots(previous, ['z', 'y', 'x']))).toEqual({ x: 0, y: 1, z: 2 });
  });

  test('a newcomer takes the slot a leaver freed', () => {
    const previous = assignSeriesSlots(new Map(), ['x', 'y', 'z']);
    expect(slotsOf(assignSeriesSlots(previous, ['w', 'x', 'z']))).toEqual({ x: 0, w: 1, z: 2 });
  });

  test('when groups leave, slots stay contiguous from the first', () => {
    const previous = assignSeriesSlots(new Map(), ['x', 'y', 'z']);
    const next = assignSeriesSlots(previous, ['z', 'x']);
    expect(slotsOf(next)).toEqual({ x: 0, z: 1 });
    expectContiguous(next);
  });
});

describe('buildUsageStack', () => {
  const filled = [
    filledSeries('a', [{ input: 10, requests: 1 }, { input: 0 }, { input: 30, requests: 3 }]),
    filledSeries('b', [{ input: 5, requests: 1 }, { input: 0 }, { input: 1, requests: 1 }]),
    filledSeries('c', [{ input: 2, requests: 1 }, { input: 0 }, { input: 0 }]),
    filledSeries('d', [{ input: 0 }, { input: 0 }, { input: 4, requests: 2 }]),
  ];
  const slots = new Map<string, SeriesSlot>([
    ['b', 0],
    ['a', 1],
  ]);

  test('stacks groups in slot order with the folded groups on top as one layer', () => {
    const stack = buildUsageStack(filled, slots, ['c', 'd'], 'tokens', 3);
    expect(stack.layers.map((layer) => (layer.kind === 'group' ? layer.key : 'other'))).toEqual([
      'b',
      'a',
      'other',
    ]);
    expect(stack.layers[2]).toEqual({
      kind: 'other',
      keys: ['c', 'd'],
      values: [2, 0, 4],
      total: 6,
    });
    expect(stack.columnTotals).toEqual([17, 0, 35]);
    expect(stack.peak).toEqual({ index: 2, value: 35 });
    expect(stack.total).toBe(52);
  });

  test('the requests metric stacks request counts', () => {
    const stack = buildUsageStack(filled, slots, ['c', 'd'], 'requests', 3);
    expect(stack.columnTotals).toEqual([3, 0, 6]);
  });

  test('an empty range has no peak', () => {
    expect(buildUsageStack([], new Map(), [], 'tokens', 3).peak).toBeNull();
  });
});

const row = (
  provider: string,
  authIndex: string,
  model: string,
  values: Partial<UsageCounters>
): UsageTotalsRow => ({ provider, authIndex: authIndex as AuthIndex, model, ...counters(values) });

describe('buildUsageTree', () => {
  test('nests provider ▸ account ▸ model, sums each level and sorts by total tokens', () => {
    const tree = buildUsageTree([
      row('claude', 'a1', 'fable', { input: 10, requests: 1 }),
      row('codex', 'b1', 'gpt', { output: 100, requests: 4 }),
      row('claude', 'a2', 'fable', { cacheRead: 30, requests: 2 }),
      row('claude', 'a1', 'opus', { reasoning: 15, requests: 1 }),
    ]);
    expect(tree.map((node) => [node.key, node.tokens])).toEqual([
      ['codex', 100],
      ['claude', 55],
    ]);
    const claude = tree[1];
    expect(claude.counters.requests).toBe(4);
    expect(claude.children.map((node) => [node.key, node.tokens])).toEqual([
      ['a2', 30],
      ['a1', 25],
    ]);
    expect(claude.children[1].children.map((node) => [node.level, node.key, node.tokens])).toEqual([
      ['model', 'opus', 15],
      ['model', 'fable', 10],
    ]);
  });

  test('gives every node an id that is unique across providers and accounts', () => {
    const tree = buildUsageTree([
      row('claude', 'x', 'm', { input: 1 }),
      row('codex', 'x', 'm', { input: 1 }),
    ]);
    const ids = tree.flatMap((p) => [
      p.id,
      ...p.children.flatMap((a) => [a.id, ...a.children.map((m) => m.id)]),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('display names', () => {
  test('auth_index maps to email, else label, else file name', () => {
    const files: AuthFileItem[] = [
      { name: 'a.json', authIndex: 'a1', email: 'ops@example.com', label: 'Main' },
      { name: 'b.json', authIndex: 7, label: 'Team' },
      { name: 'c.json', authIndex: 'a3' },
      { name: 'no-index.json', email: 'lost@example.com' },
    ];
    expect(Object.fromEntries(accountNames(files))).toEqual({
      a1: 'ops@example.com',
      '7': 'Team',
      a3: 'c.json',
    });
  });

  const context = {
    names: new Map([['a1', 'ops@example.com']]),
    providers: accountProviders([row('claude', 'a1', 'm', {}), row('codex', 'b9', 'm', {})]),
    unknownLabel: 'Unknown',
  };

  test.each([
    ['provider', 'claude', 'Claude'],
    ['provider', 'unknown', 'Unknown'],
    ['auth_index', 'a1', 'ops@example.com · Claude'],
    ['auth_index', 'b9', 'b9 · Codex'],
    ['auth_index', 'zz', 'zz'],
    ['auth_index', '', 'Unknown'],
    ['model', 'claude-fable-5', 'claude-fable-5'],
  ] as const)('%s %p → %p', (groupBy, key, label) => {
    expect(groupLabel(groupBy, key, context)).toBe(label);
  });
});
