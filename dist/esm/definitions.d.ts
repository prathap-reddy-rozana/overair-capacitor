import type { PluginListenerHandle } from '@capacitor/core';
/**
 * The native contract.
 *
 * The division is deliberate: **native owns the device, TypeScript owns the
 * protocol.** Everything that must survive a web bundle that cannot execute -
 * the boot decision, the rollback, the identity this binary subscribes to -
 * lives in Kotlin and Swift, because it has to run before any JavaScript does.
 * Talking to `/v1/check` is ordinary HTTP and stays up here.
 */
export type BundleStatus = 'DOWNLOADED' | 'ACTIVE' | 'PENDING' | 'BAD';
export interface BundleInfo {
    id: string;
    version: string;
    status: BundleStatus;
    /** Bytes on disk, after unpacking. */
    size: number;
    /** Hash of the archive, as the server named it. */
    checksum: string;
}
/**
 * Where a download is.
 *
 * Separate states for verifying and unpacking because they are separately
 * slow and separately able to fail: a digest mismatch and a bad archive are
 * different problems and only one of them is worth retrying.
 */
export type DownloadState = 'IDLE' | 'DOWNLOADING' | 'VERIFYING' | 'UNPACKING' | 'READY' | 'FAILED' | 'CANCELLED';
export type FailureCode = 
/** The connection went away. Worth retrying. */
'network'
/** The server answered, but not with the bundle. Worth retrying. */
 | 'http'
/** The bytes are not what the server said they were. NOT worth retrying:
 *  the same URL will produce the same wrong bytes. */
 | 'digest'
/** The archive would not expand, or tried to write outside its directory. */
 | 'unpack'
/** Somebody called cancel(). */
 | 'cancelled' | 'unknown';
export interface DownloadFailure {
    id: string;
    code: FailureCode;
    message: string;
    /** Whether `retry()` has any chance. A digest mismatch does not. */
    retryable: boolean;
}
export interface DownloadProgress {
    id: string;
    state: DownloadState;
    /** Bytes fetched so far. */
    bytes: number;
    /** Total bytes, or 0 when the server sends no content length. */
    total: number;
    /** 0..1, or -1 when the total is unknown - so a caller can tell the
     *  difference between "no progress yet" and "cannot know". */
    fraction: number;
}
/** The live download, as `status()` reports it. */
export interface DownloadStatus extends DownloadProgress {
    failure: DownloadFailure | null;
}
export interface OverairStatus {
    /** What the webview is serving right now. Null on the embedded build. */
    current: BundleInfo | null;
    /** Unpacked and verified, waiting for the next launch. */
    next: BundleInfo | null;
    /** What ran before `current`. This is what `rollback()` falls back to, and
     *  its absence is why a rollback sometimes lands on the embedded build. */
    previous: BundleInfo | null;
    /** Ids this device tried and refused. Sent on every check so the server
     *  stops offering them rather than the device rediscovering the break. */
    quarantined: string[];
    /** True when the last launch rolled a bundle back. The SDK reports it. */
    rolledBack: boolean;
    /** The bundle that was rolled back, if any. */
    rolledBackId: string | null;
    /** Where the current or most recent download got to. Survives a reload of
     *  the web layer, because it lives natively. */
    download: DownloadStatus;
}
/**
 * Identity this binary subscribes to, read from the NATIVE plugin config in
 * `capacitor.config.ts` - not from the web bundle.
 *
 * This is the whole reason it is native. A channel is what a binary
 * subscribes to at build time, forever; if it lived in the web layer, a
 * bundle mis-published to the wrong channel could move every device that
 * took it onto that channel permanently, where no correct publish on the old
 * channel could ever reach them again.
 */
export interface OverairIdentity {
    installId: string;
    channel: string;
    runtime: string;
    /** The native build number. A change means a store update landed. */
    nativeBuild: string;
    /** When the web code built into this binary was built (ISO 8601), from
     *  `embeddedAt` in capacitor.config. Nothing uploaded before it is offered,
     *  so a fresh install is never moved back. Empty when not set. */
    embeddedAt: string;
    appVersion: string;
    /** Set from `capacitor.config.ts`, so the app need not pass them. */
    apiUrl: string;
    apiKey: string;
}
export interface DownloadOptions {
    id: string;
    version: string;
    url: string;
    /** Verified natively, streaming, before a single file is written. */
    checksum: string;
}
export interface OverairPlugin {
    /** What is running, what is waiting, what was refused, and where any
     *  download got to. */
    status(): Promise<OverairStatus>;
    /** Identity and configuration, from native config. */
    identity(): Promise<OverairIdentity>;
    /**
     * Download, verify and unpack a bundle. Native throughout: streamed to
     * disk, hashed while streaming, unzipped without holding the archive in
     * the webview's heap.
     *
     * Rejects on failure; the reason is also in `status().download.failure`,
     * which outlives a web reload.
     */
    download(options: DownloadOptions): Promise<BundleInfo>;
    /**
     * Stop the download in flight.
     *
     * Resolves whether or not one was running, so a cancel button never has to
     * ask first. The partial file is deleted: a half-written archive is not a
     * head start, it is rubbish that would fail its digest anyway.
     */
    cancel(): Promise<void>;
    /**
     * Try the last failed download again.
     *
     * Rejects when nothing failed, or when the failure was not retryable - a
     * digest mismatch means the same URL produces the same wrong bytes, and
     * retrying it forever is how a device burns a data plan on nothing.
     */
    retry(): Promise<BundleInfo>;
    /** Make a downloaded bundle the one the next launch runs. */
    next(options: {
        id: string;
    }): Promise<void>;
    /**
     * Serve the staged bundle NOW, reloading the webview into it.
     *
     * The reload IS the restart. An iOS app cannot relaunch itself - calling
     * exit reads as a crash and is rejected by review - and killing the process
     * would drop the user on a home screen with no explanation. Reloading swaps
     * the whole web layer in place, which is the part an update replaces.
     *
     * Nothing resolves after the reload: the page calling this is gone.
     */
    applyNow(): Promise<void>;
    /**
     * Confirm the running bundle started.
     *
     * An app that never calls this is treated as never having booted: the next
     * launch rolls back before the webview loads. That is the watchdog, and it
     * only works because the decision is native.
     */
    notifyReady(): Promise<void>;
    /** Refuse a bundle forever. Reported as `quarantined` on every check. */
    quarantine(options: {
        id: string;
    }): Promise<void>;
    /**
     * Step back one bundle.
     *
     * For a failure the app itself detects and the boot watchdog cannot - a
     * screen that will not load, an error it cannot recover from. The current
     * bundle is refused forever and its predecessor takes over; with no
     * predecessor that is the embedded build.
     *
     * Prefer this to `reset()`: it costs the user the broken update, not every
     * update they ever took.
     */
    rollback(): Promise<{
        rolledBackTo: string;
    }>;
    /** Drop ALL the way to the build compiled into the binary and forget the
     *  rest. The blunt instrument; `rollback()` is usually what you want. */
    reset(): Promise<void>;
    /** Delete everything except what is running and what is next. */
    prune(): Promise<void>;
    /** Bytes as they arrive. Throttled natively to about ten a second, because
     *  a progress bar cannot show more and every one crosses the bridge. */
    addListener(eventName: 'downloadProgress', listener: (progress: DownloadProgress) => void): Promise<PluginListenerHandle>;
    /** Every state change, including the terminal ones. `failure` is set only
     *  on FAILED. */
    addListener(eventName: 'downloadStateChanged', listener: (status: DownloadStatus) => void): Promise<PluginListenerHandle>;
    removeAllListeners(): Promise<void>;
}
