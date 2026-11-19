import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getServerCapabilities, parseCapabilities } from '@/services/api/capabilities';
import { apiClient } from '@/services/api/client';
import { ResponseShapeError } from '@/services/api/responseShape';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

/** The fork's current response; each test changes only what it is about. */
const forkBody = (overrides: Record<string, unknown> = {}) => ({
  strategies: ['round-robin', 'weighted-round-robin', 'fill-first'],
  usage_store: { enabled: true, dropped_records: 0 },
  ...overrides,
});

describe('parseCapabilities', () => {
  test('reads every fork field', () => {
    expect(
      parseCapabilities(
        forkBody({
          quota_cache: true,
          usage_store: { enabled: true, dropped_records: 12 },
          strategies: ['fill-first', 'pace'],
        })
      )
    ).toEqual({
      tag: 'fork',
      quotaCache: true,
      usageStore: { enabled: true, droppedRecords: 12 },
      strategies: ['fill-first', 'pace'],
    });
  });

  test('keeps strategy names as the server sends them', () => {
    const body = forkBody({ strategies: ['round-robin', 'future-strategy'] });
    expect(parseCapabilities(body).strategies).toEqual(['round-robin', 'future-strategy']);
  });

  test('a missing feature field means the feature is not available', () => {
    const body: Record<string, unknown> = forkBody();
    delete body.usage_store;
    const parsed = parseCapabilities(body);
    expect(parsed.quotaCache).toBe(false);
    expect(parsed.usageStore).toEqual({ enabled: false });
  });

  test('a disabled usage store carries no dropped-record count', () => {
    const parsed = parseCapabilities(
      forkBody({ usage_store: { enabled: false, dropped_records: 3 } })
    );
    expect(parsed.usageStore).toEqual({ enabled: false });
  });

  test.each([
    ['a non-object body', ['strategies'], 'body'],
    ['quota_cache not a boolean', forkBody({ quota_cache: 'yes' }), 'quota_cache'],
    ['usage_store.enabled missing', forkBody({ usage_store: {} }), 'usage_store.enabled'],
    [
      'a negative dropped-record count',
      forkBody({ usage_store: { enabled: true, dropped_records: -1 } }),
      'usage_store.dropped_records',
    ],
    [
      'an enabled store without a dropped-record count',
      forkBody({ usage_store: { enabled: true } }),
      'usage_store.dropped_records',
    ],
    ['strategies not an array', forkBody({ strategies: 'round-robin' }), 'strategies'],
    ['a non-string strategy', forkBody({ strategies: [1] }), 'strategies[0]'],
  ])('rejects %s', (_name, body, path) => {
    let thrown: unknown;
    try {
      parseCapabilities(body);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResponseShapeError);
    expect((thrown as ResponseShapeError).path).toBe(path);
  });
});

describe('getServerCapabilities', () => {
  const mockGet = () => {
    const spy = spyOn(apiClient, 'get');
    spies.push(spy);
    return spy;
  };

  test('reads GET /server/capabilities', async () => {
    const get = mockGet().mockResolvedValue(forkBody() as never);
    expect((await getServerCapabilities()).tag).toBe('fork');
    expect(get).toHaveBeenCalledWith('/server/capabilities');
  });

  test('a 404 identifies upstream CLIProxyAPI', async () => {
    mockGet().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await getServerCapabilities()).toEqual({ tag: 'upstream' });
  });

  test('other failures propagate', async () => {
    const failure = Object.assign(new Error('Bad Gateway'), { status: 502 });
    mockGet().mockRejectedValue(failure);
    await expect(getServerCapabilities()).rejects.toBe(failure);
  });
});
