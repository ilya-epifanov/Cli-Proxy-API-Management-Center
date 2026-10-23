import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { PoolRunwayLines } from '@/features/quota/components/QuotaRouting';
import { classifyQuotaFiles, sortQuotaEntries, type QuotaFileEntry } from '@/features/quota/logic';
import {
  activeModelCooldowns,
  formatPace,
  poolRunwayLines,
  routingByAuthIndex,
  routingNotes,
  routingRankTitle,
  routingSortKey,
  type CardRouting,
} from '@/features/quota/routing';
import { parseRoutingRanking, ResponseShapeError, type RankEntry } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { DAY_MS } from '@/utils/time/durations';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const t = i18n.t.bind(i18n);
const now = Date.parse('2026-10-13T12:00:00Z');

const wireEntry = (overrides: Record<string, unknown> = {}) => ({
  auth_index: 'c1',
  rank: 1,
  priority: 0,
  class: 'ready',
  top_band: true,
  long_windows: ['seven-day', 'seven-day-fable'],
  pace: 3.724,
  pace_window: 'seven-day-fable',
  resets_at: '2026-10-14T14:00:00Z',
  estimated: false,
  short_remaining: 0.99,
  exhausted_window: undefined,
  back_at: null,
  observed_at: '2026-10-13T11:58:00Z',
  stale: false,
  ...overrides,
});

const wire = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
  strategy: 'pace',
  generated_at: '2026-10-13T12:00:00Z',
  pools: [
    {
      provider: 'claude',
      model: 'claude-fable-5-1',
      ranked: true,
      long_windows: ['seven-day', 'seven-day-fable'],
      entries,
      not_candidates: [{ auth_index: 'c9', reason: 'cooldown', until: '2026-10-13T14:00:00Z' }],
      ...extra,
    },
  ],
});

describe('parseRoutingRanking', () => {
  test('reads a ready entry and the not-candidates', () => {
    const ranking = parseRoutingRanking(wire([wireEntry()]));
    const pool = ranking.pools[0];
    expect(ranking.strategy).toBe('pace');
    expect(pool.model).toBe('claude-fable-5-1');
    expect(pool.entries[0]).toEqual({
      authIndex: 'c1',
      rank: 1,
      priority: 0,
      topBand: true,
      longWindows: ['seven-day', 'seven-day-fable'],
      observedAt: Date.parse('2026-10-13T11:58:00Z'),
      stale: false,
      class: 'ready',
      pace: 3.724,
      paceWindow: 'seven-day-fable',
      resetsAt: Date.parse('2026-10-14T14:00:00Z'),
      estimated: false,
      shortRemaining: 0.99,
    });
    expect(pool.notCandidates).toEqual([
      { authIndex: 'c9', reason: 'cooldown', until: Date.parse('2026-10-13T14:00:00Z') },
    ]);
  });

  test('reads exhausted and unknown entries without pace fields', () => {
    const pool = parseRoutingRanking(
      wire([
        wireEntry({
          class: 'exhausted',
          pace: null,
          pace_window: undefined,
          exhausted_window: 'five-hour',
          back_at: '2026-10-13T14:00:00Z',
        }),
        wireEntry({ auth_index: 'c2', rank: 2, class: 'unknown', pace: null, top_band: false }),
      ])
    ).pools[0];
    expect(pool.entries[0]).toMatchObject({
      class: 'exhausted',
      window: 'five-hour',
      backAt: Date.parse('2026-10-13T14:00:00Z'),
    });
    expect(pool.entries[1]).toMatchObject({ class: 'unknown', authIndex: 'c2' });
  });

  test('rejects an unknown class and a ready entry without pace', () => {
    expect(() => parseRoutingRanking(wire([wireEntry({ class: 'burstLow' })]))).toThrow(
      ResponseShapeError
    );
    expect(() => parseRoutingRanking(wire([wireEntry({ pace: null })]))).toThrow(
      ResponseShapeError
    );
  });
});

const ranked = (
  overrides: Partial<RankEntry> & Pick<RankEntry, 'class'>,
  poolSize = 3
): CardRouting =>
  ({
    tag: 'ranked',
    poolSize,
    entry: {
      authIndex: 'c1',
      rank: 1,
      priority: 0,
      topBand: false,
      longWindows: ['seven-day'],
      observedAt: now,
      stale: false,
      ...overrides,
    } as RankEntry,
  }) as CardRouting;

const file = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'claude-a.json',
  type: 'claude',
  ...overrides,
});

describe('routingByAuthIndex', () => {
  test('maps ranked pools and skips pools the strategy does not rank', () => {
    const ranking = parseRoutingRanking(
      wire([wireEntry(), wireEntry({ auth_index: 'c2', rank: 2, top_band: false })])
    );
    const map = routingByAuthIndex(ranking.pools);
    expect(map.get('c2')).toMatchObject({ tag: 'ranked', poolSize: 2 });
    expect(map.get('c9')).toMatchObject({ tag: 'notCandidate' });
    const unranked = parseRoutingRanking(wire([wireEntry()], { ranked: false }));
    expect(routingByAuthIndex(unranked.pools).size).toBe(0);
  });
});

describe('routing sort', () => {
  const entries = classifyQuotaFiles([
    { name: 'codex-a.json', type: 'codex', auth_index: 'x1' },
    { name: 'claude-a.json', type: 'claude', auth_index: 'c1' },
    { name: 'claude-b.json', type: 'claude', auth_index: 'c2' },
    { name: 'claude-c.json', type: 'claude', auth_index: 'c3' },
  ]);
  const routes = new Map<string, CardRouting>([
    ['c1', ranked({ class: 'unknown', rank: 2 })],
    ['c2', ranked({ class: 'unknown', rank: 1 })],
    ['x1', ranked({ class: 'unknown', rank: 1 })],
  ]);
  const key = (entry: QuotaFileEntry) =>
    routingSortKey(entry, routes.get(String(entry.file.auth_index)));

  test('orders by rank inside provider groups, unranked last', () => {
    const sorted = sortQuotaEntries(entries, 'routing', key).map((entry) => entry.file.name);
    expect(sorted).toEqual(['claude-b.json', 'claude-a.json', 'codex-a.json', 'claude-c.json']);
  });
});

describe('formatPace', () => {
  test.each([
    [0.04, '<0.1×'],
    [0.42, '0.4×'],
    [3.724, '3.7×'],
    [100.8, '101×'],
  ])('%p → %s', (pace, text) => expect(formatPace(pace)).toBe(text));
});

describe('routingNotes', () => {
  test('ready: pace and its window, with an explanation tooltip', () => {
    const notes = routingNotes(
      t,
      ranked({
        class: 'ready',
        pace: 3.72,
        paceWindow: 'seven-day-fable',
        resetsAt: null,
        estimated: false,
        shortRemaining: 0.9,
      }),
      file(),
      now,
      'en'
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('pace 3.7× on 7-day Fable 5');
    expect(notes[0].warn).toBe(false);
    expect(notes[0].title).toContain('1× is on schedule');
  });

  test('burst low is a separate warning; estimated and stale qualify the pace', () => {
    const notes = routingNotes(
      t,
      ranked({
        class: 'burst_low',
        pace: 2,
        paceWindow: 'seven-day',
        resetsAt: null,
        estimated: true,
        shortRemaining: 0.12,
        stale: true,
      }),
      file(),
      now,
      'en'
    );
    expect(notes.map(({ text, warn }) => ({ text, warn }))).toEqual([
      {
        text: 'pace 2.0× on 7-day limit · reset passed, re-reading · data may be out of date',
        warn: false,
      },
      { text: '5-hour at 12 %: used after other accounts', warn: true },
    ]);
  });

  test('exhausted names the window and when it comes back', () => {
    const [note] = routingNotes(
      t,
      ranked({ class: 'exhausted', window: 'weekly', backAt: now + 2 * DAY_MS }),
      file(),
      now,
      'en'
    );
    expect(note.text).toBe('Weekly limit used up, back in 2 days');
  });

  test('a not-candidate says why it is not used', () => {
    const cooldown: CardRouting = {
      tag: 'notCandidate',
      candidate: { authIndex: 'c9', reason: 'cooldown', until: now + 2 * 3600_000 },
    };
    expect(routingNotes(t, cooldown, file(), now, 'en')[0].text).toBe(
      'not used: cooling down, back in 2 hours'
    );
    const authError: CardRouting = {
      tag: 'notCandidate',
      candidate: { authIndex: 'c9', reason: 'auth_error', until: null },
    };
    expect(routingNotes(t, authError, file(), now, 'en')[0].text).toBe('not used: sign-in error');
  });

  test('model cooldowns from the credential list follow the routing note', () => {
    const cooling = file({
      cooldownSnapshot: {
        receivedAtMs: now,
        records: [
          {
            scope: 'model',
            modelKey: 'claude-fable-5-1',
            reason: 'quota',
            retryAt: '',
            remainingSeconds: 3 * 3600,
          },
          { scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: 60 },
          {
            scope: 'model',
            modelKey: 'expired',
            reason: 'quota',
            retryAt: '',
            remainingSeconds: 0,
          },
        ],
      },
    });
    const notes = routingNotes(t, ranked({ class: 'unknown' }), cooling, now, 'en');
    expect(notes.map((note) => note.text)).toEqual([
      'no quota data yet, used after accounts with data',
      'claude-fable-5-1 cooling down, back in 3 hours',
    ]);
    expect(activeModelCooldowns(cooling, now + 4 * 3600_000)).toEqual([]);
  });
});

describe('routingRankTitle', () => {
  test('names the rank and, for the top band, the random pick', () => {
    const routing = ranked({ class: 'unknown', rank: 2, topBand: true }, 5);
    if (routing.tag !== 'ranked') throw new Error('unreachable');
    expect(routingRankTitle(t, routing.entry, 5)).toBe(
      'Rank 2 of 5 for new sessions. A new session picks one of the accounts marked like this, at random'
    );
  });
});

const runwayWire = {
  reason: 'short',
  speed: 0.84,
  delay_ms: 6542,
  dry_at: '2026-10-19T21:03:16Z',
  window: 'seven-day',
  accounts: 5,
  demand_per_hour: 31.6,
  max_delay_ms: 120_000,
  unsized: [],
};

describe('runway parsing', () => {
  test('reads a short runway', () => {
    const pool = parseRoutingRanking(wire([wireEntry()], { runway: runwayWire })).pools[0];
    expect(pool.runway).toEqual({
      reason: 'short',
      speed: 0.84,
      delayMs: 6542,
      dryAt: Date.parse('2026-10-19T21:03:16Z'),
      window: 'seven-day',
      accounts: 5,
      demandPerHour: 31.6,
      maxDelayMs: 120_000,
      unsized: [],
    });
  });

  test('a clear runway has no dry date', () => {
    const pool = parseRoutingRanking(
      wire([wireEntry()], {
        runway: { ...runwayWire, reason: 'clear', speed: 1, delay_ms: 0, dry_at: null },
      })
    ).pools[0];
    expect(pool.runway).toMatchObject({ reason: 'clear', speed: 1, delayMs: 0, dryAt: null });
  });

  test('a learning runway has neither speed nor window', () => {
    const pool = parseRoutingRanking(
      wire([wireEntry()], {
        runway: {
          ...runwayWire,
          reason: 'learning',
          speed: null,
          window: null,
          delay_ms: 0,
          dry_at: null,
          unsized: ['five-hour'],
        },
      })
    ).pools[0];
    expect(pool.runway).toMatchObject({
      reason: 'learning',
      speed: null,
      window: null,
      unsized: ['five-hour'],
    });
  });

  test('null and missing (older server) read as null', () => {
    expect(parseRoutingRanking(wire([wireEntry()])).pools[0].runway).toBeNull();
    expect(parseRoutingRanking(wire([wireEntry()], { runway: null })).pools[0].runway).toBeNull();
  });

  const learning = { reason: 'learning', speed: null, window: null, dry_at: null };
  test.each([
    ['unknown reason', { reason: 'late' }],
    ['speed null while not learning', { speed: null }],
    ['window null while not learning', { window: null }],
    ['speed while learning', { ...learning, speed: 0.5 }],
    ['window while learning', { ...learning, window: 'seven-day' }],
    ['speed above 1', { speed: 1.2 }],
    ['negative speed', { speed: -0.1 }],
    ['short without a dry date', { dry_at: null }],
    ['malformed dry date', { dry_at: 'tomorrow' }],
    ['fractional delay', { delay_ms: 1.5 }],
    ['negative delay', { delay_ms: -1 }],
    ['missing max delay', { max_delay_ms: undefined }],
    ['negative accounts', { accounts: -1 }],
    ['negative demand', { demand_per_hour: -1 }],
    ['unsized not an array', { unsized: 'five-hour' }],
    ['unsized with a non-string', { unsized: [5] }],
    ['runway not an object', 0.5],
  ])('rejects %s', (_name, override) => {
    const runway = typeof override === 'object' ? { ...runwayWire, ...override } : override;
    expect(() => parseRoutingRanking(wire([wireEntry()], { runway }))).toThrow(ResponseShapeError);
  });
});

describe('poolRunwayLines', () => {
  const pools = (claude: Record<string, unknown>, codex: Record<string, unknown> = {}) =>
    parseRoutingRanking({
      strategy: 'pace',
      pools: [
        { ...wire([]).pools[0], ...claude },
        { ...wire([]).pools[0], provider: 'codex', model: null, ...codex },
      ],
    }).pools;
  const lines = (runway: Record<string, unknown>, tab: 'all' | 'claude' = 'claude') =>
    poolRunwayLines(t, pools({ runway: { ...runwayWire, ...runway } }), tab, now, 'en');
  const text = (runway: Record<string, unknown>) => lines(runway).map((line) => line.text);

  test('short: time to dry, the delay, in the warning tone', () => {
    expect(lines({ dry_at: '2026-10-19T12:00:00Z' })).toEqual([
      {
        provider: 'claude',
        text: 'Claude pool: would run out in 6 days at full speed · requests slowed by 7 s',
        title: expect.stringContaining('Runway: the forecast demand'),
        warn: true,
      },
    ]);
  });

  test('short: the time to dry is as coarse as on the cards', () => {
    expect(text({ dry_at: '2026-10-13T12:40:00Z' })[0]).toContain('would run out in 40 minutes');
    expect(text({ dry_at: '2026-10-13T17:30:00Z' })[0]).toContain('would run out in 5 hours');
  });

  test('clear: lasts the week, no delay, no warning', () => {
    const [line] = lines({ reason: 'clear', speed: 1, delay_ms: 0, dry_at: null });
    expect(line.text).toBe('Claude pool: lasts the week at this rate · no delay');
    expect(line.warn).toBe(false);
  });

  test('reserve: the maximum wait, in the warning tone', () => {
    const [line] = lines({ reason: 'reserve', speed: 0, delay_ms: 120_000 });
    expect(line.text).toBe('Claude pool: would run out before it refills at full speed · requests slowed by 120 s');
    expect(line.warn).toBe(true);
  });

  test('learning: no delay, no warning', () => {
    const [line] = lines({
      reason: 'learning',
      speed: null,
      window: null,
      delay_ms: 0,
      dry_at: null,
    });
    expect(line.text).toBe('Claude pool: sizing quota from usage · no delay');
    expect(line.warn).toBe(false);
  });

  test('a delay under half a second still reads as 1 s', () => {
    expect(text({ delay_ms: 200 })[0]).toEndWith('requests slowed by 1 s');
  });

  test('throttle off replaces the delay part for every reason', () => {
    const off = { max_delay_ms: 0, delay_ms: 0 };
    expect(text({ ...off, dry_at: '2026-10-19T12:00:00Z' })).toEqual([
      'Claude pool: would run out in 6 days at full speed · throttle off',
    ]);
    expect(text({ ...off, reason: 'clear', speed: 1, dry_at: null })).toEqual([
      'Claude pool: lasts the week at this rate · throttle off',
    ]);
    expect(text({ ...off, reason: 'reserve', speed: 0 })).toEqual([
      'Claude pool: would run out before it refills at full speed · throttle off',
    ]);
    expect(text({ ...off, reason: 'learning', speed: null, window: null, dry_at: null })).toEqual([
      'Claude pool: sizing quota from usage · throttle off',
    ]);
  });

  test('unsized windows are named at the end', () => {
    expect(
      text({ reason: 'clear', speed: 1, delay_ms: 0, dry_at: null, unsized: ['five-hour'] })
    ).toEqual(['Claude pool: lasts the week at this rate · no delay · 5-hour limit not sized yet']);
    expect(text({ max_delay_ms: 0, delay_ms: 0, unsized: ['five-hour'] })[0]).toEndWith(
      'throttle off · 5-hour limit not sized yet'
    );
  });

  test('skips pools without a runway and providers the tab hides', () => {
    expect(poolRunwayLines(t, pools({}, { runway: runwayWire }), 'claude', now, 'en')).toEqual([]);
    expect(poolRunwayLines(t, pools({}), 'all', now, 'en')).toEqual([]);
    const both = poolRunwayLines(
      t,
      pools({ runway: runwayWire }, { runway: { ...runwayWire, reason: 'clear', dry_at: null } }),
      'all',
      now,
      'en'
    );
    expect(both.map((line) => line.provider)).toEqual(['claude', 'codex']);
  });

  test('renders one line per pool, nothing without lines', () => {
    // The component reads the shared clock, so keep the text clear of the dry date.
    const clear = { ...runwayWire, reason: 'clear', speed: 1, delay_ms: 0, dry_at: null };
    const html = renderToStaticMarkup(
      createElement(PoolRunwayLines, { pools: pools({ runway: clear }), tab: 'all' })
    );
    expect(html).toContain('Claude pool: lasts the week at this rate · no delay');
    expect(html.match(/<p /g)).toHaveLength(1);
    expect(
      renderToStaticMarkup(createElement(PoolRunwayLines, { pools: pools({}), tab: 'all' }))
    ).toBe('');
  });
});
