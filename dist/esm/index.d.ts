import type { DownloadProgress, DownloadStatus, OverairPlugin } from './definitions';
import type { Manifest, Reason } from './types';
export * from './definitions';
export * from './types';
/** The native plugin. Use it directly for status and manual control; most
 *  apps want `Updater` below instead. */
export declare const Overair: OverairPlugin;
export interface SyncResult {
    reason: Reason;
    /** Downloaded, verified and unpacked. It runs on the next launch. */
    staged: boolean;
    /** Offered, but over `auto_max_bytes` and left for the app to decide. */
    deferred: Manifest | null;
    /** The server asked this device back to the build in its binary. */
    reverted: boolean;
}
export interface UpdaterOptions {
    /** Both default to the values in `capacitor.config`, which is where they
     *  belong: the binary's own configuration, not the replaceable web layer. */
    apiUrl?: string;
    apiKey?: string;
    attrs?: Record<string, unknown>;
    customId?: string;
    debug?: boolean;
}
/**
 * The protocol half of the SDK.
 *
 * Native decides what runs and owns the bytes; this decides what to ask for.
 * Keeping them apart is why the boot decision can happen before any of this
 * code exists.
 */
declare class Updater {
    private api;
    private options;
    private inFlight;
    /**
     * Ask the server, and act on the answer.
     *
     * Safe to call whenever - launch, resume, a button. A second call while
     * one is running joins the first rather than starting a second download.
     */
    sync(options?: UpdaterOptions): Promise<SyncResult>;
    /**
     * Tell the platform this bundle started.
     *
     * An app that never calls this is treated as never having booted: the next
     * launch rolls back before the webview loads. Call it after the first
     * meaningful render, not in a constructor - the point is to prove the app
     * actually works, not that a file parsed.
     */
    notifyReady(): Promise<void>;
    /** What the webview is serving, or null on the build in the binary. */
    current(): Promise<import("./definitions").BundleInfo | null>;
    /**
     * Bytes as they arrive, throttled natively to about ten a second.
     *
     * The handle survives nothing: a bundle swap reloads the web layer and
     * every listener with it. That is why the authoritative state is
     * `status().download` and this is only the live feed.
     */
    onProgress(listener: (progress: DownloadProgress) => void): Promise<import("@capacitor/core").PluginListenerHandle>;
    /** Every state change, including the terminal ones. `failure` is set only
     *  on FAILED, and carries whether retrying is worth it. */
    onStateChange(listener: (status: DownloadStatus) => void): Promise<import("@capacitor/core").PluginListenerHandle>;
    /** Stop the download in flight. Safe when there is not one. */
    cancel(): Promise<void>;
    /**
     * Try the last failed download again.
     *
     * Rejects when nothing failed or the failure was not retryable, so a retry
     * button can be disabled straight off `status().download.failure`.
     */
    retry(): Promise<SyncResult>;
    /** Where the current or most recent download got to. Unlike a listener,
     *  this survives the web reload a bundle swap causes. */
    downloadStatus(): Promise<DownloadStatus>;
    /** Back to the build compiled into the binary, forgetting the rest. */
    reset(): Promise<void>;
    private run;
    private stage;
    /** Telemetry never makes a device wait, and a failed report must never
     *  fail the update it was describing. */
    private emit;
    private log;
}
/** One instance: two of these racing would be two answers to a question
 *  that has one, and both would download. */
export declare const OverairUpdater: Updater;
