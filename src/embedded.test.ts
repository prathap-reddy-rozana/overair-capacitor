/**
 * The check says when the binary's own web code was built, so the server
 * never offers something older than what a fresh install already runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const identity = {
  installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc', channel: 'production',
  appVersion: '1.0.0', nativeBuild: '1', embeddedAt: '2026-09-24T09:00:00.000Z',
};

const native = {
  identity: vi.fn(async () => ({ ...identity })),
  status: vi.fn(async () => ({
    current: null, next: null, rolledBack: false, rolledBackId: null,
    quarantined: [] as string[],
  })),
};

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => native,
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}));

const OPTIONS = { apiUrl: 'https://o.example.com', apiKey: 'oa_client_x' };

function sentChecks(): Record<string, unknown>[] {
  const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  return calls.filter(([url]) => url.endsWith('/v1/check'))
    .map(([, init]) => JSON.parse(String(init.body)));
}

describe('the check reports the embedded build', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ update: null, reason: 'HELD_OLDER_THAN_EMBEDDED' }),
    })) as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    native.identity.mockImplementation(async () => ({ ...identity }));
  });

  it('sends the time from capacitor.config', async () => {
    const { OverairUpdater } = await import('./index');

    const result = await OverairUpdater.sync(OPTIONS);

    expect(sentChecks()[0]['embedded_at']).toBe('2026-09-24T09:00:00.000Z');
    expect(result.reason).toBe('HELD_OLDER_THAN_EMBEDDED');
  });

  it('sends null for a value that is not a time', async () => {
    native.identity.mockImplementation(async () => ({ ...identity, embeddedAt: '24/09/2026' }));
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync(OPTIONS);

    expect(sentChecks()[0]['embedded_at']).toBeNull();
  });

  it('lets the app correct a shipped build', async () => {
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync({ ...OPTIONS, embeddedAt: '2026-09-01T00:00:00Z' });

    expect(sentChecks()[0]['embedded_at']).toBe('2026-09-01T00:00:00Z');
  });

  it('sends null, not an empty string, when the app does not set it', async () => {
    // An empty string is not a time; the server would refuse the whole check.
    native.identity.mockImplementation(async () => ({ ...identity, embeddedAt: '' }));
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync(OPTIONS);

    expect(sentChecks()[0]['embedded_at']).toBeNull();
  });
});
