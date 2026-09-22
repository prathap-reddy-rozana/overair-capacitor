/**
 * The READY report, and the ordering that used to lose it.
 *
 * `notifyReady` runs BEFORE the first sync, deliberately: the watchdog has to
 * be satisfied before a check can overtake it and report the device as running
 * nothing. But the endpoint is only constructed inside sync, so the READY it
 * raised went to `this.api?.report(...)` while `api` was still null - and the
 * optional chain made that a silent no-op rather than an error anyone could
 * catch.
 *
 * Nothing failed, nothing logged, and `ready` stayed at zero for every real
 * fleet while `pause_below_ready_bps` was gating on exactly that number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = {
  identity: vi.fn(async () => ({
    installId: 'i-1',
    apiUrl: '',
    apiKey: '',
    runtime: 'fp_abc',
    channel: 'production',
    appVersion: '1.0.0',
    nativeBuild: '1',
  })),
  status: vi.fn(async () => ({
    current: { id: '42', version: '1.0.2' },
    rolledBack: false,
    rolledBackId: null,
    quarantined: [] as string[],
  })),
  notifyReady: vi.fn(async () => undefined),
  download: vi.fn(async () => undefined),
};

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => native,
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}));

/** Every request the SDK made, as {url, body}. */
function captureFetch(check: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
    return { ok: true, status: 200, json: async () => check };
  }) as unknown as typeof fetch);
  return calls;
}

const UP_TO_DATE = { update: null, reason: 'UP_TO_DATE' };

function readyEvents(calls: { url: string; body: Record<string, unknown> }[]) {
  return calls
    .filter((c) => c.url.endsWith('/v1/events'))
    .flatMap((c) => (c.body['events'] as { type: string; bundle: string }[]) ?? [])
    .filter((e) => e.type === 'READY');
}

describe('READY survives being raised before the endpoint exists', () => {
  beforeEach(() => {
    vi.resetModules();
    native.identity.mockClear();
    native.status.mockClear();
    native.notifyReady.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reaches the server on the sync that follows', async () => {
    const calls = captureFetch(UP_TO_DATE);
    const { OverairUpdater } = await import('./index');

    // Exactly the order startOta uses: confirm the boot, then check.
    await OverairUpdater.notifyReady();
    await OverairUpdater.sync({
      apiUrl: 'https://o.example.com', apiKey: 'oa_client_x', channel: 'production',
    });

    const ready = readyEvents(calls);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.bundle).toBe('42');
  });

  it('names the bundle that actually booted', async () => {
    // The health gate counts READY per release. An event with no bundle is
    // counted against nothing and the rollout still reads as zero.
    const calls = captureFetch(UP_TO_DATE);
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.notifyReady();
    await OverairUpdater.sync({
      apiUrl: 'https://o.example.com', apiKey: 'oa_client_x', channel: 'production',
    });

    expect(readyEvents(calls)[0]!.bundle).toBe('42');
  });

  it('raises nothing when the webview is on the build in the binary', async () => {
    // Not an update, so there is nothing to call healthy. A READY here would
    // make every fresh install look like a successful rollout.
    native.status.mockResolvedValueOnce({
      current: null, rolledBack: false, rolledBackId: null, quarantined: [],
    } as never);
    const calls = captureFetch(UP_TO_DATE);
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.notifyReady();
    await OverairUpdater.sync({
      apiUrl: 'https://o.example.com', apiKey: 'oa_client_x', channel: 'production',
    });

    expect(readyEvents(calls)).toHaveLength(0);
  });

  it('does not grow without bound when a build never syncs', async () => {
    // OTA switched off: notifyReady still runs on every launch, and nothing
    // ever drains the queue.
    captureFetch(UP_TO_DATE);
    const { OverairUpdater } = await import('./index');

    for (let i = 0; i < 50; i += 1) await OverairUpdater.notifyReady();

    const queued = (OverairUpdater as unknown as { queued: unknown[] }).queued;
    expect(queued.length).toBeLessThanOrEqual(20);
  });
});
