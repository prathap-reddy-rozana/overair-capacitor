import { WebPlugin } from '@capacitor/core';
import type { BundleInfo, DownloadOptions, OverairIdentity, OverairPlugin, OverairStatus } from './definitions';
/**
 * The web implementation, which deliberately does nothing.
 *
 * There is no over-the-air update in a browser: the page IS the latest
 * version, reloaded from the server every time. Every method resolves to an
 * empty, honest answer so a shared codebase can call the SDK during `ng
 * serve` without branching on the platform - and none of them pretends to
 * have applied anything.
 */
export declare class OverairWeb extends WebPlugin implements OverairPlugin {
    status(): Promise<OverairStatus>;
    private idle;
    identity(): Promise<OverairIdentity>;
    download(_options: DownloadOptions): Promise<BundleInfo>;
    next(_options: {
        id: string;
    }): Promise<void>;
    applyNow(): Promise<void>;
    cancel(): Promise<void>;
    retry(): Promise<BundleInfo>;
    /** The one method that succeeds on web: an app that calls it on every
     *  platform should not have to guard the call. */
    notifyReady(): Promise<void>;
    quarantine(_options: {
        id: string;
    }): Promise<void>;
    rollback(): Promise<{
        rolledBackTo: string;
    }>;
    reset(): Promise<void>;
    prune(): Promise<void>;
}
