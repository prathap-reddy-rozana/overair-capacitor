import { WebPlugin } from '@capacitor/core';
/**
 * The web implementation, which deliberately does nothing.
 *
 * There is no over-the-air update in a browser: the page IS the latest
 * version, reloaded from the server every time. Every method resolves to an
 * empty, honest answer so a shared codebase can call the SDK during `ng
 * serve` without branching on the platform - and none of them pretends to
 * have applied anything.
 */
export class OverairWeb extends WebPlugin {
    async status() {
        return {
            current: null, next: null, previous: null, quarantined: [],
            rolledBack: false, rolledBackId: null,
            download: this.idle(),
        };
    }
    idle() {
        return { id: '', state: 'IDLE', bytes: 0, total: 0, fraction: -1, failure: null };
    }
    async identity() {
        return {
            installId: 'web',
            channel: '',
            runtime: '',
            nativeBuild: '',
            embeddedAt: '',
            appVersion: '',
            apiUrl: '',
            apiKey: '',
        };
    }
    async download(_options) {
        throw this.unavailable('Bundles are only downloaded on a device.');
    }
    async next(_options) {
        throw this.unavailable('Bundles are only applied on a device.');
    }
    async applyNow() {
        throw this.unavailable('Bundles are only applied on a device.');
    }
    async cancel() {
        return;
    }
    async retry() {
        throw this.unavailable('Bundles are only downloaded on a device.');
    }
    /** The one method that succeeds on web: an app that calls it on every
     *  platform should not have to guard the call. */
    async notifyReady() {
        return;
    }
    async quarantine(_options) {
        return;
    }
    async rollback() {
        return { rolledBackTo: 'embedded' };
    }
    async reset() {
        return;
    }
    async prune() {
        return;
    }
}
