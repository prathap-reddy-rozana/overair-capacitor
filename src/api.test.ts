import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeliveryApi } from './api';
import type { CheckRequest } from './types';

const report: CheckRequest = {
  install_id: 'i-1',
  platform: 'android',
  runtime: 'fp_abc',
};

function respond(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeliveryApi', () => {

  it('joins the path without doubling the slash', async () => {
    const fetchMock = respond({ update: null, reason: 'UP_TO_DATE' });
    // A base URL with a trailing slash is what someone pastes out of a
    // browser, so it must not produce //v1/check.
    await new DeliveryApi('https://o.example.com/', 'k').check(report);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://o.example.com/v1/check');
  });

  it('sends the key as a bearer token', async () => {
    const fetchMock = respond({ update: null, reason: 'UP_TO_DATE' });
    await new DeliveryApi('https://o.example.com', 'oa_client_x').check(report);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization)
      .toBe('Bearer oa_client_x');
  });

  it('returns a refusal rather than throwing on it', async () => {
    // Every outcome, including every "no", is a 200 with a reason. Treating
    // HELD_ROLLOUT as an error would make a normal answer look like a fault.
    respond({ update: null, reason: 'HELD_ROLLOUT' });
    const result = await new DeliveryApi('https://o.example.com', 'k').check(report);
    expect(result.reason).toBe('HELD_ROLLOUT');
    expect(result.update).toBeNull();
  });

  it('throws when the transport fails', async () => {
    respond({}, false, 503);
    await expect(new DeliveryApi('https://o.example.com', 'k').check(report))
      .rejects.toThrow('check failed: 503');
  });

  it('does not spend a request on an empty batch', async () => {
    const fetchMock = respond({});
    await new DeliveryApi('https://o.example.com', 'k').report([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('batches events into one request', async () => {
    const fetchMock = respond({ accepted: 2 });
    await new DeliveryApi('https://o.example.com', 'k').report([
      { install_id: 'i-1', type: 'DOWNLOADED', bundle: 'b1' },
      { install_id: 'i-1', type: 'READY', bundle: 'b1' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).events).toHaveLength(2);
  });
});
