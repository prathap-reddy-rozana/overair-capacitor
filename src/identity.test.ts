/**
 * The app's identity rides on every check, so a release can be aimed at people.
 * It has to survive a relaunch: the first check of a launch runs before the app
 * knows who is signed in, and an empty one would overwrite what the server has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const identity = {
  installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc', channel: 'production',
  appVersion: '1.0.0', nativeBuild: '1', embeddedAt: '',
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
const ASM = { customId: '42', attrs: { role_title: 'ASM', signed_in: 'yes' } };

/** Web storage as the webview keeps it: one store for every launch. */
function webStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
    clear: () => items.clear(),
    key: () => null,
    get length() { return items.size; },
  };
}

function sentChecks(): Record<string, unknown>[] {
  const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  return calls.filter(([url]) => url.endsWith('/v1/check'))
    .map(([, init]) => JSON.parse(String(init.body)));
}

/** A fresh updater, as a relaunch gets: module state gone, storage kept. */
async function launch() {
  vi.resetModules();
  return (await import('./index')).OverairUpdater;
}

describe('setIdentity', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', webStorage());
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ update: null, reason: 'HELD_TARGETING' }),
    })) as unknown as typeof fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is sent on the first check of the next launch', async () => {
    (await launch()).setIdentity(ASM);

    await (await launch()).sync(OPTIONS);

    const check = sentChecks()[0];
    expect([check['custom_id'], check['attrs']]).toEqual(['42', ASM.attrs]);
  });

  it('null forgets it, so the next check is anonymous', async () => {
    const updater = await launch();
    updater.setIdentity(ASM);
    updater.setIdentity(null);

    await (await launch()).sync(OPTIONS);

    const check = sentChecks()[0];
    expect([check['custom_id'], check['attrs']]).toEqual(['', {}]);
  });

  it('the options still win when the app sets them', async () => {
    const updater = await launch();
    updater.setIdentity(ASM);

    await updater.sync({ ...OPTIONS, customId: 'from-options', attrs: { tier: 'gold' } });

    const check = sentChecks()[0];
    expect([check['custom_id'], check['attrs']]).toEqual(['from-options', { tier: 'gold' }]);
  });

  it('storage that refuses leaves the check anonymous, not broken', async () => {
    vi.stubGlobal('localStorage', {
      ...webStorage(),
      setItem: () => { throw new Error('quota'); },
    });
    const updater = await launch();
    updater.setIdentity(ASM);

    const result = await updater.sync(OPTIONS);

    expect(sentChecks()[0]['custom_id']).toBe('');
    expect(result.reason).toBe('HELD_TARGETING');
  });
});
