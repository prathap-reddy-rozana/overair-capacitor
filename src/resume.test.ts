/**
 * Checking again when the app comes back to the foreground.
 *
 * Before this a device checked on launch and wherever the app happened to ask.
 * An app left open for days never heard of an update, and one whose home
 * trigger was misrouted checked on launch only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let resume: (() => void) | null = null;
let downloadState = 'IDLE';

const native = {
  identity: vi.fn(async () => ({
    installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc', channel: 'production',
    appVersion: '1.0.0', nativeBuild: '1', embeddedAt: '',
  })),
  status: vi.fn(async () => ({
    current: null, next: null, previous: null, quarantined: [] as string[],
    rolledBack: false, rolledBackId: null,
    download: { id: '', state: downloadState, failure: null },
  })),
  addListener: vi.fn(async (event: string, listener: () => void) => {
    if (event === 'resume') resume = listener;
    return { remove: async () => undefined };
  }),
};

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => native,
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}));

const OPTIONS = { apiUrl: 'https://o.example.com', apiKey: 'oa_client_x' };
const MINUTE = 60_000;

/** Every /v1/check the SDK made. `down` makes the next ones fail. */
function serve() {
  const state = { checks: 0, down: false };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/v1/check')) {
      state.checks += 1;
      if (state.down) throw new TypeError('offline');
    }
    return { ok: true, status: 200, json: async () => ({ update: null, reason: 'UP_TO_DATE' }) };
  }) as unknown as typeof fetch);
  return state;
}

/** Fire a resume and let its check finish. */
async function resumed() {
  resume?.();
  await vi.waitFor(() => Promise.resolve());
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.resetModules();
  resume = null;
  downloadState = 'IDLE';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a resume', () => {
  it('checks once the gap has passed, and not before', async () => {
    const server = serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);

    vi.setSystemTime(Date.now() + 4 * MINUTE);
    await resumed();
    expect(server.checks).toBe(1);

    vi.setSystemTime(Date.now() + 2 * MINUTE);
    await resumed();
    expect(server.checks).toBe(2);
  });

  it('asks sooner after a check that got no answer', async () => {
    const server = serve();
    server.down = true;
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);
    server.down = false;

    vi.setSystemTime(Date.now() + 61_000);
    await resumed();

    expect(server.checks).toBe(2);
  });

  it('stays quiet when switched off, including later from remote config', async () => {
    const server = serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);
    OverairUpdater.configure({ checkOnResume: false });

    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await resumed();

    expect(server.checks).toBe(1);
  });

  it('never checks over a download in progress', async () => {
    const server = serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);
    downloadState = 'DOWNLOADING';

    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await resumed();

    expect(server.checks).toBe(1);
  });
});

describe('onResult', () => {
  it('hears the checks the app asked for and the ones a resume made', async () => {
    serve();
    const { OverairUpdater } = await import('./index');
    const heard: string[] = [];
    OverairUpdater.onResult((result) => heard.push(result.reason));

    await OverairUpdater.sync(OPTIONS);
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await resumed();

    expect(heard).toEqual(['UP_TO_DATE', 'UP_TO_DATE']);
  });

  it('stops hearing once unsubscribed, and a throwing listener harms nobody', async () => {
    serve();
    const { OverairUpdater } = await import('./index');
    const heard: string[] = [];
    OverairUpdater.onResult(() => { throw new Error('buggy listener'); });
    const stop = OverairUpdater.onResult((result) => heard.push(result.reason));

    await expect(OverairUpdater.sync(OPTIONS)).resolves.toMatchObject({ reason: 'UP_TO_DATE' });
    stop();
    await OverairUpdater.sync(OPTIONS);

    expect(heard).toEqual(['UP_TO_DATE']);
  });
});

describe('what listeners are told', () => {
  it('a check that fails before asking is an unanswered one, with the short wait', async () => {
    const server = serve();
    const { OverairUpdater } = await import('./index');
    await OverairUpdater.sync(OPTIONS);
    const heard: string[] = [];
    OverairUpdater.onResult((result) => heard.push(result.reason));
    native.identity.mockImplementationOnce(async () => { throw new Error('bridge'); });

    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await expect(OverairUpdater.sync(OPTIONS)).rejects.toThrow('bridge');
    expect(heard).toEqual(['CHECKED']);

    vi.setSystemTime(Date.now() + 61_000);
    await resumed();
    expect(server.checks).toBe(2);
  });
});
