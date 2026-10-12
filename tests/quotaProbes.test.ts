import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { refreshedAgo } from '@/features/quota/refreshedAgo';
import { refreshedAtOf, serverQuotaState } from '@/features/quota/serverQuota';
import type { QuotaAdapter } from '@/features/quota/providers';
import {
  parseQuotaProbeRefresh,
  parseQuotaProbes,
  ResponseShapeError,
  type QuotaProbeEntry,
} from '@/services/api';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as unknown as TFunction;
const claude = CLAUDE_CONFIG as unknown as QuotaAdapter;
const codex = CODEX_CONFIG as unknown as QuotaAdapter;

const claudeUsage = JSON.stringify({
  five_hour: { utilization: 40, resets_at: '2026-10-11T15:00:00Z' },
  seven_day: { utilization: 10, resets_at: '2026-10-15T10:00:00Z' },
});

const wireEntry = (overrides: Record<string, unknown> = {}) => ({
  auth_index: 'a1',
  provider: 'claude',
  attempted_at: '2026-10-11T10:00:00.123456789Z',
  fetched_at: '2026-10-11T10:00:00.123456789Z',
  error: null,
  responses: {
    usage: { status_code: 200, body: claudeUsage },
    profile: { status_code: 200, body: JSON.stringify({ account: { has_claude_max: true } }) },
  },
  ...overrides,
});

const entry = (overrides: Record<string, unknown> = {}): QuotaProbeEntry =>
  parseQuotaProbeRefresh(wireEntry(overrides));

describe('quota probe responses', () => {
  test('turn into the api-call results the quota parsers read', () => {
    const [parsed] = parseQuotaProbes({ entries: [wireEntry()] });
    expect(parsed.authIndex).toBe('a1');
    expect(parsed.fetchedAt).toBe(Date.parse('2026-10-11T10:00:00.123Z'));
    expect(parsed.error).toBeNull();
    const usage = parsed.responses.get('usage');
    expect(usage?.statusCode).toBe(200);
    expect(usage?.body).toEqual(JSON.parse(claudeUsage));
    expect(usage?.bodyText).toBe(claudeUsage);
  });

  test('keep a failed read with no earlier success', () => {
    const parsed = entry({
      fetched_at: null,
      error: { status: 401, message: 'token expired' },
      responses: {},
    });
    expect(parsed.fetchedAt).toBeNull();
    expect(parsed.error).toEqual({ status: 401, message: 'token expired' });
    expect(parsed.responses.size).toBe(0);
  });

  test('reject a response without its status code', () => {
    expect(() => entry({ responses: { usage: { body: '{}' } } })).toThrow(ResponseShapeError);
    expect(() => parseQuotaProbes({})).toThrow(ResponseShapeError);
  });
});

describe('quota from a server read', () => {
  test('Claude windows and plan come from the stored responses', () => {
    const data = CLAUDE_CONFIG.fromServerProbe!({} as AuthFileItem, entry(), t);
    expect(data.windows.map((window) => window.id)).toEqual(['five-hour', 'seven-day']);
    expect(data.planType).toBe('plan_max');
    expect(data.refreshedAt).toBe(Date.parse('2026-10-11T10:00:00.123Z'));
    // No reset_grants answer: the card shows a read error instead of reading it itself.
    expect(data.resetGrants).toBeNull();
  });

  test('Claude reset grants come from the same server read', () => {
    const data = CLAUDE_CONFIG.fromServerProbe!(
      {} as AuthFileItem,
      entry({
        responses: {
          usage: { status_code: 200, body: claudeUsage },
          reset_grants: {
            status_code: 200,
            body: JSON.stringify({
              cedar_ember: {
                eligible: true,
                at_limit: false,
                grants: [{ id: 'g1', resets_total: 2, resets_left: 1, usable_now: true }],
              },
            }),
          },
        },
      }),
      t
    );
    expect(data.resetGrants?.grants.map((grant) => grant.id)).toEqual(['g1']);
  });

  test('an account never read successfully reports the server error', () => {
    const failed = entry({
      fetched_at: null,
      error: { status: 429, message: 'rate limited' },
      responses: {},
    });
    expect(() => CLAUDE_CONFIG.fromServerProbe!({} as AuthFileItem, failed, t)).toThrow(
      'rate limited'
    );
  });

  test('Codex reports a missing reset-credit answer instead of zero credits', () => {
    const data = CODEX_CONFIG.fromServerProbe!(
      { name: 'codex.json' } as AuthFileItem,
      entry({
        provider: 'codex',
        responses: {
          usage: {
            status_code: 200,
            body: JSON.stringify({
              plan_type: 'pro',
              rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } },
            }),
          },
        },
      }),
      t
    );
    expect(data.planType).toBe('pro');
    expect(data.rateLimitResetCreditsAvailableCount).toBeNull();
    expect(data.rateLimitResetCreditsError).toBe('common.unknown_error');
  });
});

describe('merging server reads into card states', () => {
  const file = { name: 'claude.json' } as AuthFileItem;

  test('a new read replaces the card; the same read again changes nothing', () => {
    const first = serverQuotaState(claude, file, undefined, entry(), t);
    expect(first?.status).toBe('success');
    expect(refreshedAtOf(first!)).toBe(Date.parse('2026-10-11T10:00:00.123Z'));
    expect(serverQuotaState(claude, file, first!, entry(), t)).toBeNull();
    const later = entry({ fetched_at: '2026-10-11T10:15:00Z' });
    expect(refreshedAtOf(serverQuotaState(claude, file, first!, later, t)!)).toBe(
      Date.parse('2026-10-11T10:15:00Z')
    );
  });

  test('a running refresh is left alone', () => {
    expect(serverQuotaState(claude, file, claude.buildLoadingState(), entry(), t)).toBeNull();
  });

  test('a failure shows only where no quota is shown yet', () => {
    const failed = entry({
      fetched_at: null,
      error: { status: 401, message: 'expired' },
      responses: {},
    });
    const shown = serverQuotaState(claude, file, undefined, entry(), t)!;
    expect(serverQuotaState(claude, file, shown, failed, t)).toBeNull();
    const errorState = serverQuotaState(claude, file, undefined, failed, t);
    expect(errorState).toMatchObject({ status: 'error', error: 'expired', errorStatus: 401 });
    expect(serverQuotaState(claude, file, errorState!, failed, t)).toBeNull();
  });

  test('providers the server does not read are skipped', () => {
    expect(
      serverQuotaState({ ...codex, fromServerProbe: undefined }, file, undefined, entry(), t)
    ).toBeNull();
  });
});

describe('refreshed ago', () => {
  test.each([
    [-2_000, 'seconds', '0'],
    [0, 'seconds', '0'],
    [59_999, 'seconds', '59'],
    [60_000, 'minutes', '1'],
    [59 * 60_000 + 59_999, 'minutes', '59'],
    [3_600_000, 'hours', '1:00'],
    [3_600_000 + 5 * 60_000 + 30_000, 'hours', '1:05'],
    [26 * 3_600_000, 'hours', '26:00'],
  ] as const)('%d ms reads as %s %s', (age, unit, value) => {
    expect(refreshedAgo(age)).toEqual({ unit, value });
  });
});
