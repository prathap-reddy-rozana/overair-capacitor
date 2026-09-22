/**
 * The delivery plane: two endpoints, one credential.
 *
 * Plain `fetch` rather than CapacitorHttp - the payloads are small, and the
 * webview's own stack handles redirects and TLS the way the platform
 * expects. Bytes never come through here; the native side fetches those.
 */
export class DeliveryApi {
    baseUrl;
    apiKey;
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }
    /** Never throws on a refusal: every outcome, including every "no", is a
     *  200 with a reason. A throw here means the network failed. */
    async check(report) {
        const res = await fetch(this.url('/v1/check'), {
            method: 'POST', headers: this.headers(), body: JSON.stringify(report),
        });
        if (!res.ok)
            throw new Error(`check failed: ${res.status}`);
        return (await res.json());
    }
    /** Batched, so a weak connection spends one request on a whole session. */
    async report(events) {
        if (!events.length)
            return;
        const res = await fetch(this.url('/v1/events'), {
            method: 'POST', headers: this.headers(), body: JSON.stringify({ events }),
        });
        if (!res.ok)
            throw new Error(`events failed: ${res.status}`);
    }
    url(path) {
        return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    }
    headers() {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
    }
}
