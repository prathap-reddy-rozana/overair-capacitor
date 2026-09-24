import type { DownloadProgress, DownloadStatus, OverairPlugin } from './definitions';
import type { Manifest, Reason } from './types';
export * from './definitions';
export * from './types';
/** The native plugin. Use it directly for status and manual control; most
 *  apps want `Updater` below instead. */
export declare const Overair: OverairPlugin;
export interface SyncResult {
    reason: Reason;
    /** Downloaded, verified and unpacked. It runs on the next launch, or now
     *  if the app calls `applyNow()`. */
    staged: boolean;
    /** Offered, but over `auto_max_bytes` and left for the app to decide. */
    deferred: Manifest | null;
    /** The server asked this device back to the build in its binary. */
    reverted: boolean;
    /**
     * Whatever was offered, staged or deferred.
     *
     * Carries `mandatory`, which decides whether the app may let someone keep
     * working - and the version and size, which are the only things worth
     * showing a person about an update.
     */
    update: Manifest | null;
}
/**
 * Is this update too big to take without asking?
 *
 * The ceiling is the DEVICE's call because it is the only thing that knows it
 * is on somebody's data plan. Two things override it: `mandatory`, because a
 * build that is actively broken is worth the megabytes; and the user having
 * already accepted this exact bundle, because re-asking after a failed
 * download is how a retry button comes to do nothing at all.
 *
 * Keyed on the bundle id rather than a flag: agreeing to one large update is
 * not agreeing to the next one.
 */
export declare function shouldDefer(update: Manifest, acceptedId: string | null): boolean;
export interface UpdaterOptions {
    /** All four default to the values in `capacitor.config`, which is where they
     *  belong: the binary's own configuration, not the replaceable web layer. */
    apiUrl?: string;
    apiKey?: string;
    /** Move this build to another channel without shipping a binary. Safe
     *  because the head is still keyed on the runtime below: a wrong channel
     *  can only ever reach bundles that declare this build's fingerprint. */
    channel?: string;
    /**
     * Override the fingerprint this build claims to be.
     *
     * There is no guard behind this one - `runtime` IS the guard, and it is the
     * only thing standing between a device and a bundle built for native code
     * it does not have. Nothing checks an override against the binary, because
     * nothing can: a value that disagrees will be believed.
     *
     * Keying it on `identity.nativeBuild` removes that risk; a plain remote
     * string does not, and is a choice to make with the risk in view. Empty
     * keeps whatever the binary was built with.
     */
    runtime?: string;
    /** Override when this build's web code was built (ISO 8601). For correcting
     *  a shipped build stamped wrongly; empty keeps capacitor.config's. */
    embeddedAt?: string;
    attrs?: Record<string, unknown>;
    customId?: string;
    debug?: boolean;
}
/** A time the server can read, or null. Anything else is dropped here rather
 *  than sent: the value is baked into the binary. */
export declare function embeddedTime(value: string | undefined): string | null;
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
    /** The last manifest held back by the size ceiling, for `accept`. */
    private deferred;
    /** The bundle the user has already said yes to. Per bundle id, not a flag:
     *  agreeing to one large update is not agreeing to the next one. */
    private acceptedId;
    /**
     * Events raised before an endpoint was known.
     *
     * `notifyReady` runs BEFORE the first sync on purpose - the watchdog has to
     * be satisfied before a check can overtake it - so the READY it emits has
     * nowhere to go yet. `this.api?.report(...)` turned that into a silent
     * no-op, which left `ready` at zero for every real fleet while
     * `pause_below_ready_bps` was reading exactly that number.
     */
    private queued;
    /** Its OWN guard, not `inFlight`. Joining a check would resolve with that
     *  check's answer - deferred - and the tap would look like it did nothing. */
    private accepting;
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
    /**
     * Serve the staged bundle now, reloading the webview into it.
     *
     * Nothing runs after this: the page that called it is replaced. Confirm
     * with the user first, because anything unsaved on screen goes with it.
     */
    applyNow(): Promise<void>;
    /** Stop the download in flight. Safe when there is not one. */
    cancel(): Promise<void>;
    /**
     * Take an update that `sync` deferred.
     *
     * The ceiling in `auto_max_bytes` is a decision to ASK, not a refusal, so
     * something has to be able to say yes. Without this the deferred manifest
     * is a fact the app can display and nothing more.
     *
     * A fresh check comes first, for the reason `retry` gives: the deferred
     * manifest's URL is presigned and can expire while the card sits on screen.
     * The server may also have paused the release or moved on since; its
     * current answer wins, and only offline does the held link get used.
     */
    accept(update?: Manifest): Promise<SyncResult>;
    /**
     * Try again after a failed download.
     *
     * Deliberately a fresh check rather than a replay of the attempt that
     * failed. The download URL is PRESIGNED and short-lived: replaying it
     * re-uses a link that may already have expired, or that points at an
     * object the server has since moved - a button that cannot work however
     * many times it is pressed. One small request buys a URL that can.
     *
     * `retryable` is still honoured: a digest mismatch means the bytes on the
     * server are wrong, and a fresh link fetches the same wrong bytes.
     */
    retry(): Promise<SyncResult>;
    /** Where the current or most recent download got to. Unlike a listener,
     *  this survives the web reload a bundle swap causes. */
    downloadStatus(): Promise<DownloadStatus>;
    /**
     * Step back one bundle after a failure the app detected itself.
     *
     * The boot watchdog only catches a bundle that never starts. This is for
     * the one that starts and is then obviously broken - and it costs the user
     * the bad update rather than every update they have ever taken.
     */
    rollback(): Promise<{
        rolledBackTo: string;
    }>;
    /** Back to the build compiled into the binary, forgetting the rest. */
    reset(): Promise<void>;
    private run;
    private stage;
    /** Telemetry never makes a device wait, and a failed report must never
     *  fail the update it was describing. */
    private emit;
    /** Send whatever was raised before the endpoint was known. Same bargain as
     *  `emit`: reporting must never be why an update fails. */
    private flushQueued;
    private log;
}
/** One instance: two of these racing would be two answers to a question
 *  that has one, and both would download. */
export declare const OverairUpdater: Updater;
