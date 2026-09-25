/**
 * Accepting a deferred update asks the server again first.
 *
 * The deferred manifest carries a presigned URL from the check that deferred
 * it. The user may tap Update long after that link expired, and the server may
 * have paused the release since. Downloading from the held manifest failed on
 * every late tap, and each failure was reported as the release failing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = {
  identity: vi.fn(async () => ({
    installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc',
    channel: 'production', appVersion: '1.0.0', nativeBuild: '1',
  })),
  status: vi.fn(async () => ({
    current: null, next: null, rolledBack: false, rolledBackId: null,
    quarantined: [] as string[],
  })),
  download: vi.fn(async (_: { url: string }) => undefined),
  next: vi.fn(async () => undefined),
};

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => native,
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}));

const OPTIONS = { apiUrl: 'https://o.example.com', apiKey: 'oa_client_x' };

/** 2 MB against a 1 MB ceiling, so the first check defers it. */
function offer(url: string) {
  return {
    reason: 'OFFERED',
    update: {
      bundle_id: '26', version: '1.0.1', sha256: 'a'.repeat(64), size: 2_097_152,
      url, signature: null, mandatory: false, auto_max_bytes: 1_048_576,
      tree_sha256: '', delta: null,
    },
  };
}

/** Answers each /v1/check with the next item; `null` means the network failed. */
function serve(...checks: (unknown | null)[]) {
  const queue = [...checks];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!url.endsWith('/v1/check')) return { ok: true, status: 202, json: async () => ({}) };
    const next = queue.shift();
    if (next === null) throw new TypeError('network down');
    return { ok: true, status: 200, json: async () => next };
  }) as unknown as typeof fetch);
}

describe('accept() re-checks before downloading a deferred update', () => {
  beforeEach(() => {
    vi.resetModules();
    native.download.mockClear();
    native.next.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads from the fresh link, not the one the deferral held', async () => {
    serve(offer('https://s3.test/stale'), offer('https://s3.test/fresh'));
    const { OverairUpdater } = await import('./index');

    const first = await OverairUpdater.sync(OPTIONS);
    expect(first.deferred?.url).toBe('https://s3.test/stale');

    const result = await OverairUpdater.accept();

    expect(result.staged).toBe(true);
    expect(native.download).toHaveBeenCalledTimes(1);
    expect(native.download.mock.calls[0][0].url).toBe('https://s3.test/fresh');
  });

  it('downloads nothing when the server no longer offers it', async () => {
    serve(offer('https://s3.test/stale'), { update: null, reason: 'HELD_PAUSED' });
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);

    const result = await OverairUpdater.accept();

    expect(result).toMatchObject({ reason: 'HELD_PAUSED', staged: false });
    expect(native.download).not.toHaveBeenCalled();
  });

  it('falls back to the held link when the device is offline', async () => {
    serve(offer('https://s3.test/held'), null);
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);
    const heard: boolean[] = [];
    OverairUpdater.onResult((r) => heard.push(r.staged));

    const result = await OverairUpdater.accept();

    expect(result.staged).toBe(true);
    expect(native.download.mock.calls[0][0].url).toBe('https://s3.test/held');
    // The inner check's "no answer", then the staged result - not just the first.
    expect(heard).toEqual([false, true]);
  });
});
