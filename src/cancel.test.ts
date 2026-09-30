/**
 * Stopping a download is not a download failing.
 *
 * A cancel made native reject, and the SDK reported that as FAILED with
 * `stage_failed`: three taps on Stop and the server quarantined the bundle for
 * the install. The consent also outlived the cancel while the offer did not,
 * so accept() threw "nothing deferred to accept" and the next check quietly
 * downloaded the large bundle the user had just stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let failure: { id: string; code: string; retryable: boolean } | null = null;

const native = {
  identity: vi.fn(async () => ({
    installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc', channel: 'production',
    appVersion: '1.0.0', nativeBuild: '1', embeddedAt: '',
  })),
  status: vi.fn(async () => ({
    current: null, next: null, previous: null, quarantined: [] as string[],
    rolledBack: false, rolledBackId: null,
    download: { id: failure?.id ?? '', state: failure ? 'CANCELLED' : 'IDLE', failure },
  })),
  download: vi.fn(async (_: unknown): Promise<unknown> => {
    failure = { id: '26', code: 'cancelled', retryable: false };
    throw new Error('cancelled');
  }),
  next: vi.fn(async (_: unknown) => undefined),
  quarantine: vi.fn(async (_: unknown) => undefined),
};

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => native,
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}));

const OPTIONS = { apiUrl: 'https://o.example.com', apiKey: 'oa_client_x' };

/** 2 MB against a 1 MB ceiling: deferred until the user accepts it. */
const OFFER = {
  reason: 'OFFERED',
  update: {
    bundle_id: '26', version: '11.123.1', sha256: 'a'.repeat(64), size: 2_097_152,
    url: 'https://s3.test/b.zip', signature: null, mandatory: false,
    auto_max_bytes: 1_048_576, tree_sha256: '', delta: null,
  },
};

function serve(offer: typeof OFFER = OFFER) {
  const events: { type: string; bundle: string; error_code: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/events')) {
      events.push(...JSON.parse(String(init.body)).events);
      return { ok: true, status: 202, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => offer };
  }) as unknown as typeof fetch);
  return events;
}

beforeEach(() => {
  vi.resetModules();
  failure = null;
  Object.values(native).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a cancelled download', () => {
  it('reports no failure', async () => {
    const events = serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);

    const result = await OverairUpdater.accept();

    expect(result.staged).toBe(false);
    expect(events.filter((e) => e.type === 'FAILED')).toEqual([]);
    expect(native.quarantine).not.toHaveBeenCalled();
  });

  it('can be accepted again', async () => {
    serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);

    const cancelled = await OverairUpdater.accept();
    expect(cancelled.deferred?.bundle_id).toBe('26');

    native.download.mockImplementationOnce(async () => ({ id: '26', size: 10 }));
    const again = await OverairUpdater.accept();

    expect(again.staged).toBe(true);
    expect(native.download).toHaveBeenCalledTimes(2);
  });

  it('is not downloaded again by the next check without asking', async () => {
    serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);
    await OverairUpdater.accept();

    const next = await OverairUpdater.sync(OPTIONS);

    expect(next.deferred?.bundle_id).toBe('26');
    expect(native.download).toHaveBeenCalledTimes(1);
  });
});

describe('a stopped download under the ceiling', () => {
  it('waits to be asked for again, rather than downloading on the next check', async () => {
    const small = { ...OFFER, update: { ...OFFER.update, size: 400_000 } };
    serve(small);
    const { OverairUpdater } = await import('./index');

    const stopped = await OverairUpdater.sync(OPTIONS);
    expect(stopped.deferred?.bundle_id).toBe('26');

    const next = await OverairUpdater.sync(OPTIONS);

    expect(next.deferred?.bundle_id).toBe('26');
    expect(native.download).toHaveBeenCalledTimes(1);
  });

  it('downloads once accepted', async () => {
    const small = { ...OFFER, update: { ...OFFER.update, size: 400_000 } };
    serve(small);
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);

    native.download.mockImplementationOnce(async () => ({ id: '26', size: 10 }));
    const accepted = await OverairUpdater.accept();

    expect(accepted.staged).toBe(true);
  });
});

describe('a download refused because another is running', () => {
  it('is not reported as the release failing', async () => {
    native.download.mockImplementationOnce(async () => {
      throw new Error('a download is already running');
    });
    const events = serve();
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync({ ...OPTIONS });
    await OverairUpdater.accept();

    expect(events.filter((e) => e.type === 'FAILED')).toEqual([]);
  });
});

describe('a real failure', () => {
  it('is still reported', async () => {
    native.download.mockImplementationOnce(async () => {
      failure = { id: '26', code: 'network', retryable: true };
      throw new Error('connection reset');
    });
    const events = serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);

    await OverairUpdater.accept();

    expect(events.find((e) => e.type === 'FAILED')?.error_code).toBe('stage_failed');
  });
});
