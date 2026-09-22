import type { CheckRequest, CheckResponse, DeviceEvent } from './types';
/**
 * The delivery plane: two endpoints, one credential.
 *
 * Plain `fetch` rather than CapacitorHttp - the payloads are small, and the
 * webview's own stack handles redirects and TLS the way the platform
 * expects. Bytes never come through here; the native side fetches those.
 */
export declare class DeliveryApi {
    private readonly baseUrl;
    private readonly apiKey;
    constructor(baseUrl: string, apiKey: string);
    /** Never throws on a refusal: every outcome, including every "no", is a
     *  200 with a reason. A throw here means the network failed. */
    check(report: CheckRequest): Promise<CheckResponse>;
    /** Batched, so a weak connection spends one request on a whole session. */
    report(events: DeviceEvent[]): Promise<void>;
    private url;
    private headers;
}
