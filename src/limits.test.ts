/**
 * Staying inside the server's caps.
 *
 * Over any of them the server refuses the whole check with a 400, and the SDK
 * reads a failed check as offline. An app that put a large object in `attrs`
 * never heard of an update again, and nothing anywhere said why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_JSON_BYTES, capCheck, capDetail, jsonSize } from './limits';
import type { CheckRequest } from './types';

const base: CheckRequest = { install_id: 'i-1', platform: 'android', runtime: 'fp_abc' };

describe('jsonSize', () => {
  it('counts what the server measures: compact, with non-ASCII escaped', () => {
    // len(json.dumps({'a': 1, 'b': [1, 2], 'c': 'é😀'}, separators=(',', ':'))) == 42.
    expect(jsonSize({ a: 1, b: [1, 2], c: 'é😀' })).toBe(42);
  });
});

describe('capCheck', () => {
  it('trims every string field to its cap', () => {
    const capped = capCheck({
      ...base,
      runtime: 'r'.repeat(100), channel: 'c'.repeat(100), app_version: 'v'.repeat(100),
      build_number: 'b'.repeat(50), os_version: 'o'.repeat(50), locale: 'l'.repeat(30),
      custom_id: 'u'.repeat(300),
    }, () => undefined);

    expect(capped.runtime).toHaveLength(80);
    expect(capped.channel).toHaveLength(80);
    expect(capped.app_version).toHaveLength(80);
    expect(capped.build_number).toHaveLength(40);
    expect(capped.os_version).toHaveLength(40);
    expect(capped.locale).toHaveLength(20);
    expect(capped.custom_id).toHaveLength(200);
  });

  it('drops attrs over the cap, and says so', () => {
    const logged: string[] = [];
    const capped = capCheck({ ...base, attrs: { notes: 'x'.repeat(MAX_JSON_BYTES) } },
      (m) => logged.push(m));

    expect(capped.attrs).toEqual({});
    expect(logged.join()).toContain('attrs');
  });

  it('measures attrs as the server does: non-ASCII is six bytes a character', () => {
    // 1000 characters, but 6000 bytes once escaped.
    const capped = capCheck({ ...base, attrs: { name: 'क'.repeat(1000) } }, () => undefined);
    expect(capped.attrs).toEqual({});
  });

  it('keeps attrs the server accepts, however many separators they have', () => {
    // 136 keys: 4081 bytes as the server measures them, 4352 with spaces.
    const attrs = Object.fromEntries(
      Array.from({ length: 136 }, (_, i) => [`k${String(i).padStart(3, '0')}`, 'v'.repeat(20)]));

    expect(jsonSize(attrs)).toBe(4081);
    expect(capCheck({ ...base, attrs }, () => undefined).attrs).toEqual(attrs);
  });

  it('leaves a check that fits exactly as it was', () => {
    const request = { ...base, attrs: { tier: 'gold' }, locale: 'hi-IN' };
    expect(capCheck(request, () => undefined)).toEqual(request);
  });
});

describe('capDetail', () => {
  it('shortens a non-ASCII message until the event fits', () => {
    const capped = capDetail({ message: 'त्रुटि'.repeat(1000), installId: 'i-1' });

    expect(jsonSize(capped)).toBeLessThan(MAX_JSON_BYTES);
    expect(capped['installId']).toBe('i-1');
    expect(String(capped['message']).length).toBeGreaterThan(0);
  });

  it('replaces a detail that cannot be made to fit', () => {
    expect(capDetail({ blob: 'x'.repeat(5000) })).toEqual({ truncated: true });
  });

  it('leaves a small detail alone', () => {
    const detail = { message: 'connection reset', installId: 'i-1' };
    expect(capDetail(detail)).toBe(detail);
  });
});

describe('what the device sends', () => {
  const native = {
    identity: vi.fn(async () => ({
      installId: 'i-1', apiUrl: '', apiKey: '', runtime: 'fp_abc', channel: 'production',
      appVersion: '1.0.0', nativeBuild: '1', embeddedAt: '', osVersion: '14',
    })),
    status: vi.fn(async () => ({
      current: null, next: null, previous: null, quarantined: [] as string[],
      rolledBack: false, rolledBackId: null,
      download: { id: '', state: 'IDLE', failure: null },
    })),
  };

  function sentChecks(): Record<string, unknown>[] {
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    return calls.filter(([url]) => url.endsWith('/v1/check'))
      .map(([, init]) => JSON.parse(String(init.body)));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: () => native,
      Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ update: null, reason: 'UP_TO_DATE' }),
    })) as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.doUnmock('@capacitor/core');
    vi.unstubAllGlobals();
  });

  it('reports the OS version native read', async () => {
    const { OverairUpdater } = await import('./index');

    await OverairUpdater.sync({ apiUrl: 'https://o.example.com', apiKey: 'oa_client_x' });

    expect(sentChecks()[0]!['os_version']).toBe('14');
  });

  it('still checks when the app hands it oversized attrs', async () => {
    const { OverairUpdater } = await import('./index');

    const result = await OverairUpdater.sync({
      apiUrl: 'https://o.example.com', apiKey: 'oa_client_x',
      attrs: { history: 'x'.repeat(10_000) },
    });

    expect(sentChecks()[0]!['attrs']).toEqual({});
    expect(result.reason).toBe('UP_TO_DATE');
  });
});
