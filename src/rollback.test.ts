/**
 * Two failures the console never heard about.
 *
 * A rollback: native `status()` cleared the flag on its first read, and
 * notifyReady - which runs before sync - was that read. Sync then saw nothing
 * to report, so no rollback ever reached the console or the health gate.
 *
 * An unusable archive: a zipped www folder unpacked with index.html one level
 * down. It was reported as a download failure and never refused, so the
 * device would take it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let rolledBackId: string | null = null;
let failure: { id: string; code: string } | null = null;

const native = {
  identity: vi.fn(async () => ({
    installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc', channel: 'production',
    appVersion: '1.0.0', nativeBuild: '1', embeddedAt: '',
  })),
  status: vi.fn(async () => ({
    current: null, next: null, previous: null, quarantined: [] as string[],
    rolledBack: rolledBackId !== null, rolledBackId,
    download: { id: failure?.id ?? '', state: failure ? 'FAILED' : 'IDLE', failure },
  })),
  acknowledgeRollback: vi.fn(async () => { rolledBackId = null; }),
  notifyReady: vi.fn(async () => undefined),
  download: vi.fn(async () => { throw new Error('no index.html at the top of the bundle'); }),
  next: vi.fn(async () => undefined),
  quarantine: vi.fn(async (_: { id: string }) => undefined),
  rollback: vi.fn(async () => ({ rolledBackTo: '1.0.0' })),
};

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => native,
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}));

const OPTIONS = { apiUrl: 'https://o.example.com', apiKey: 'oa_client_x' };

const OFFER = {
  reason: 'OFFERED',
  update: {
    bundle_id: '26', version: '11.123.1', sha256: 'a'.repeat(64), size: 1000,
    url: 'https://s3.test/b.zip', signature: null, mandatory: false,
    auto_max_bytes: 1_048_576, tree_sha256: '', delta: null,
  },
};

function serve(check: unknown, { eventsDownFor = 0 } = {}) {
  const events: { type: string; bundle: string; error_code: string }[] = [];
  let refused = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/events')) {
      if (refused++ < eventsDownFor) throw new TypeError('offline');
      events.push(...JSON.parse(String(init.body)).events);
      return { ok: true, status: 202, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => check };
  }) as unknown as typeof fetch);
  return events;
}

beforeEach(() => {
  vi.resetModules();
  rolledBackId = null;
  failure = null;
  Object.values(native).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a rollback is reported', () => {
  it('even when notifyReady reads the status first, and only once', async () => {
    rolledBackId = '26';
    const events = serve({ update: null, reason: 'HELD_QUARANTINE' });
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.notifyReady();
    await OverairUpdater.sync(OPTIONS);

    const failed = events.filter((e) => e.type === 'FAILED');
    expect(failed).toEqual([expect.objectContaining({ bundle: '26', error_code: 'boot_failed' })]);
    expect(native.acknowledgeRollback).toHaveBeenCalledTimes(1);
  });

  it('once even when it cannot be acknowledged, and never breaks startup', async () => {
    rolledBackId = '26';
    native.acknowledgeRollback.mockImplementationOnce(async () => { throw new Error('nope'); });
    const events = serve({ update: null, reason: 'HELD_QUARANTINE' });
    const { OverairUpdater } = await import('./index');

    await expect(OverairUpdater.notifyReady()).resolves.toBeUndefined();
    await OverairUpdater.sync(OPTIONS);

    expect(events.filter((e) => e.type === 'FAILED')).toHaveLength(1);
  });
});

describe('a rollback the server did not get', () => {
  it('is not acknowledged, and the next sync sends it', async () => {
    rolledBackId = '26';
    const events = serve({ update: null, reason: 'HELD_QUARANTINE' }, { eventsDownFor: 1 });
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.notifyReady();
    await OverairUpdater.sync(OPTIONS);
    expect(native.acknowledgeRollback).not.toHaveBeenCalled();

    await OverairUpdater.sync(OPTIONS);

    expect(events.filter((e) => e.error_code === 'boot_failed')).toHaveLength(1);
    expect(native.acknowledgeRollback).toHaveBeenCalledTimes(1);
  });
});

describe('rollback() on a broken bundle', () => {
  it('reports the broken one, and never names the one it goes back to', async () => {
    const events = serve({ update: null, reason: 'UP_TO_DATE' });
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);
    native.status.mockImplementationOnce(async () => ({
      current: { id: '27' }, next: null, previous: { id: '26' }, quarantined: [],
      rolledBack: false, rolledBackId: null,
      download: { id: '', state: 'IDLE', failure: null },
    }) as never);

    await OverairUpdater.rollback();

    expect(events.find((e) => e.type === 'FAILED')?.bundle).toBe('27');
    expect(events.find((e) => e.type === 'REVERTED')?.bundle).toBe('');
  });
});

describe('an archive that cannot run', () => {
  it('is refused here and reported as the bundle, not the download', async () => {
    failure = { id: '26', code: 'unpack' };
    const events = serve(OFFER);
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync(OPTIONS);

    expect(native.quarantine).toHaveBeenCalledWith({ id: '26' });
    expect(events.find((e) => e.type === 'FAILED')?.error_code).toBe('bad_bundle');
  });

  it('nor bytes that never match their digest', async () => {
    failure = { id: '26', code: 'digest' };
    const events = serve(OFFER);
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync(OPTIONS);

    expect(native.quarantine).toHaveBeenCalledWith({ id: '26' });
    expect(events.find((e) => e.type === 'FAILED')?.error_code).toBe('bad_bundle');
  });

  it('is still reported when the device cannot record it', async () => {
    failure = { id: '26', code: 'unpack' };
    native.quarantine.mockImplementationOnce(async () => { throw new Error('bridge'); });
    const events = serve(OFFER);
    const { OverairUpdater } = await import('./index');

    await expect(OverairUpdater.sync(OPTIONS)).resolves.toMatchObject({ staged: false });
    expect(events.find((e) => e.type === 'FAILED')?.error_code).toBe('bad_bundle');
  });

  it('while a dropped download is only a download failure', async () => {
    failure = { id: '26', code: 'network' };
    const events = serve(OFFER);
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync(OPTIONS);

    expect(native.quarantine).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'FAILED')?.error_code).toBe('stage_failed');
  });
});
