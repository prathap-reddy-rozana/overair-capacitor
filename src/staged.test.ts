/**
 * What a staged bundle is recorded as.
 *
 * `next()` was called with the id alone, so native stored every bundle with
 * version "", checksum "" and size 0. `status().current.version` was always
 * empty, and a rollback reported that it had gone back to "".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = {
  identity: vi.fn(async () => ({
    installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc', channel: 'production',
    appVersion: '1.0.0', nativeBuild: '1', embeddedAt: '',
  })),
  status: vi.fn(async () => ({
    current: null, next: null, previous: null, quarantined: [] as string[],
    rolledBack: false, rolledBackId: null,
    download: { id: '', state: 'IDLE', failure: null },
  })),
  download: vi.fn(async (_: unknown): Promise<unknown> => ({
    id: '26', version: '11.123.1', status: 'DOWNLOADED', size: 4096, checksum: 'a'.repeat(64),
  })),
  next: vi.fn(async (_: unknown) => undefined),
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
    auto_max_bytes: 0, tree_sha256: '', delta: null,
  },
};

beforeEach(() => {
  vi.resetModules();
  Object.values(native).forEach((fn) => fn.mockClear());
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => OFFER,
  })) as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a staged bundle', () => {
  it('is recorded with its version, checksum and unpacked size', async () => {
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync(OPTIONS);

    expect(native.next).toHaveBeenCalledWith({
      id: '26', version: '11.123.1', checksum: 'a'.repeat(64), size: 4096,
    });
  });

  it('falls back to the manifest size when native reports none', async () => {
    native.download.mockImplementationOnce(async () => undefined);
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync(OPTIONS);

    expect(native.next).toHaveBeenCalledWith(expect.objectContaining({ size: 1000 }));
  });
});
