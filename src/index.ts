import { Capacitor, registerPlugin } from '@capacitor/core';

import { DeliveryApi } from './api';
import type {
  DownloadProgress, DownloadStatus, OverairPlugin, OverairStatus,
} from './definitions';
import type { CheckResponse, DeviceEvent, Manifest, Platform, Reason } from './types';

export * from './definitions';
export * from './types';

/** The native plugin. Use it directly for status and manual control; most
 *  apps want `Updater` below instead. */
export const Overair = registerPlugin<OverairPlugin>('Overair', {
  web: () => import('./web').then((m) => new m.OverairWeb()),
});

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
export function shouldDefer(update: Manifest, acceptedId: string | null): boolean {
  if (update.mandatory) return false;
  if (update.bundle_id === acceptedId) return false;
  return update.auto_max_bytes > 0 && update.size > update.auto_max_bytes;
}

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
  /** Check again when the app comes back to the foreground. On unless set
   *  false: an app left open for days otherwise never hears of an update. */
  checkOnResume?: boolean;
  /** No resume check sooner than this after the last one answered. */
  resumeGapMinutes?: number;
  attrs?: Record<string, unknown>;
  customId?: string;
  debug?: boolean;
}

/** A time the server can read, or null. Anything else is dropped here rather
 *  than sent: the value is baked into the binary. */
export function embeddedTime(value: string | undefined): string | null {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

const NO_ANSWER: SyncResult = {
  reason: 'CHECKED', staged: false, deferred: null, reverted: false, update: null,
};
const DEFAULT_RESUME_GAP_MINUTES = 5;
/** After a check that got no answer, the next resume may ask this soon. */
const RESUME_RETRY_MS = 60_000;
const MOVING = ['DOWNLOADING', 'VERIFYING', 'UNPACKING'];

/** How many pre-endpoint events to hold. One launch raises at most a couple;
 *  the cap only matters for a build that never syncs at all. */
const QUEUED_EVENT_LIMIT = 20;

/** Longest failure message reported; keeps an event under the server's cap. */
const MAX_MESSAGE = 1000;

/**
 * The protocol half of the SDK.
 *
 * Native decides what runs and owns the bytes; this decides what to ask for.
 * Keeping them apart is why the boot decision can happen before any of this
 * code exists.
 */
class Updater {
  private api: DeliveryApi | null = null;
  private options: UpdaterOptions = {};
  private inFlight: Promise<SyncResult> | null = null;
  /** The last manifest held back by the size ceiling, for `accept`. */
  private deferred: Manifest | null = null;
  /** The bundle the user has already said yes to. Per bundle id, not a flag:
   *  agreeing to one large update is not agreeing to the next one. */
  private acceptedId: string | null = null;
  /**
   * Events raised before an endpoint was known.
   *
   * `notifyReady` runs BEFORE the first sync on purpose - the watchdog has to
   * be satisfied before a check can overtake it - so the READY it emits has
   * nowhere to go yet. `this.api?.report(...)` turned that into a silent
   * no-op, which left `ready` at zero for every real fleet while
   * `pause_below_ready_bps` was reading exactly that number.
   */
  private queued: DeviceEvent[] = [];
  /** The rollback already sent, so notifyReady and sync never both send it. */
  private rollbackReported: string | null = null;
  /** Every sync's answer goes here, whoever asked - the app, or a resume. */
  private listeners = new Set<(result: SyncResult) => void>();
  private resumeListener: Promise<unknown> | null = null;
  /** When a resume may check again. */
  private resumeAt = 0;
  /** Its OWN guard, not `inFlight`. Joining a check would resolve with that
   *  check's answer - deferred - and the tap would look like it did nothing. */
  private accepting: Promise<SyncResult> | null = null;

  /**
   * Ask the server, and act on the answer.
   *
   * Safe to call whenever - launch, resume, a button. A second call while
   * one is running joins the first rather than starting a second download.
   */
  async sync(options: UpdaterOptions = {}): Promise<SyncResult> {
    this.options = { ...this.options, ...options };
    this.listenForResume();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run()
      .then((result) => this.answered(result), (error: unknown) => {
        // Failed before it could ask: no answer, so the same one-minute wait.
        this.answered({ ...NO_ANSWER });
        throw error;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Change options without checking - e.g. switching resume checks off
   *  from remote config. */
  configure(options: UpdaterOptions): void {
    this.options = { ...this.options, ...options };
  }

  /** Every sync's result, whoever started it - resume checks find updates too.
   *  Returns a function that unsubscribes. */
  onResult(listener: (result: SyncResult) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private answered(result: SyncResult): SyncResult {
    // CHECKED is the answer to a check that got none (offline, no endpoint).
    const gap = this.options.resumeGapMinutes ?? DEFAULT_RESUME_GAP_MINUTES;
    this.resumeAt = Date.now() + (result.reason === 'CHECKED' ? RESUME_RETRY_MS : gap * 60_000);
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch {
        // One listener's bug is not every other listener's problem.
      }
    }
    return result;
  }

  /** Once, from the first sync: before that there are no options to check with. */
  private listenForResume(): void {
    if (this.resumeListener) return;
    try {
      this.resumeListener = Overair.addListener('resume', () => { void this.resumed(); })
        .catch(() => null);
    } catch {
      // A plugin without events (web, a mock): checks still work, just not on resume.
      this.resumeListener = Promise.resolve(null);
    }
  }

  private async resumed(): Promise<void> {
    if (this.options.checkOnResume === false || Date.now() < this.resumeAt) return;
    try {
      // Never over a download in progress: it would be offered the same bundle.
      const { download } = await Overair.status();
      if (MOVING.includes(download.state)) return;
    } catch {
      return;
    }
    this.log('back in the foreground; checking');
    try {
      await this.sync();
    } catch {
      // A resume must never surface an error; the next one asks again.
    }
  }

  /**
   * Tell the platform this bundle started.
   *
   * An app that never calls this is treated as never having booted: the next
   * launch rolls back before the webview loads. Call it after the first
   * meaningful render, not in a constructor - the point is to prove the app
   * actually works, not that a file parsed.
   */
  async notifyReady(): Promise<void> {
    await Overair.notifyReady();
    const status = await Overair.status();
    await this.reportRollback(status);
    if (status.current) await this.emit('READY', status.current.id);
  }

  /**
   * A rollback happens natively, before any JavaScript exists to see it.
   * Acknowledged only once the server has the report: cleared on a queued
   * one, an offline first launch lost it for good. Until then it stays set,
   * so the next sync, or the next launch, sends it again.
   */
  private async reportRollback(status: OverairStatus): Promise<void> {
    const id = status.rolledBack ? status.rolledBackId : null;
    if (!id || id === this.rollbackReported || !this.api) return;
    this.log(`rolled back ${id} before boot`);
    if (!(await this.emit('FAILED', id, 'boot_failed'))) return;
    this.rollbackReported = id;
    try {
      await Overair.acknowledgeRollback();
    } catch {
      // Never why an app fails to start; the guard above stops a resend.
    }
  }

  /** What the webview is serving, or null on the build in the binary. */
  async current() {
    return (await Overair.status()).current;
  }

  /**
   * Bytes as they arrive, throttled natively to about ten a second.
   *
   * The handle survives nothing: a bundle swap reloads the web layer and
   * every listener with it. That is why the authoritative state is
   * `status().download` and this is only the live feed.
   */
  async onProgress(listener: (progress: DownloadProgress) => void) {
    return Overair.addListener('downloadProgress', listener);
  }

  /** Every state change, including the terminal ones. `failure` is set only
   *  on FAILED, and carries whether retrying is worth it. */
  async onStateChange(listener: (status: DownloadStatus) => void) {
    return Overair.addListener('downloadStateChanged', listener);
  }

  /**
   * Serve the staged bundle now, reloading the webview into it.
   *
   * Nothing runs after this: the page that called it is replaced. Confirm
   * with the user first, because anything unsaved on screen goes with it.
   */
  async applyNow(): Promise<void> {
    await Overair.applyNow();
  }

  /** Stop the download in flight. Safe when there is not one. */
  async cancel(): Promise<void> {
    await Overair.cancel();
  }

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
  async accept(update?: Manifest): Promise<SyncResult> {
    const manifest = update ?? this.deferred;
    if (!manifest) throw new Error('nothing deferred to accept');
    // A second tap joins the first rather than starting a download native
    // would refuse - that refusal used to be reported as a release failing on
    // a handset when nothing had.
    if (this.accepting) return this.accepting;
    // Remembered BEFORE the check, so the ceiling does not defer the very
    // bundle this call is agreeing to (and `retry` can take it later).
    this.acceptedId = manifest.bundle_id;
    this.accepting = (async () => {
      // A check already running started before the consent; its answer is
      // "deferred", so wait it out and ask again.
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      const fresh = await this.sync();
      if (fresh.reason !== 'CHECKED') return fresh;
      const identity = await Overair.identity();
      // Listeners hear this too: an offline accept can still stage.
      return this.answered(await this.stage(manifest, 'OFFERED', identity.installId));
    })().finally(() => { this.accepting = null; });
    return this.accepting;
  }

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
  async retry(): Promise<SyncResult> {
    const { download } = await Overair.status();
    if (download.failure && !download.failure.retryable) {
      throw new Error(`not retryable: ${download.failure.message}`);
    }
    return this.sync();
  }

  /** Where the current or most recent download got to. Unlike a listener,
   *  this survives the web reload a bundle swap causes. */
  async downloadStatus(): Promise<DownloadStatus> {
    return (await Overair.status()).download;
  }

  /**
   * Step back one bundle after a failure the app detected itself.
   *
   * The boot watchdog only catches a bundle that never starts. This is for
   * the one that starts and is then obviously broken - and it costs the user
   * the bad update rather than every update they have ever taken.
   */
  async rollback(): Promise<{ rolledBackTo: string }> {
    const status = await Overair.status();
    const result = await Overair.rollback();
    if (status.current) await this.emit('FAILED', status.current.id, 'app_reported');
    // No bundle: the server quarantines the bundle an event names, and the
    // previous one is where this device is going, not what failed.
    await this.emit('REVERTED');
    return result;
  }

  /** Back to the build compiled into the binary, forgetting the rest. */
  async reset(): Promise<void> {
    await Overair.reset();
    await this.emit('REVERTED');
  }

  private async run(): Promise<SyncResult> {
    const idle: SyncResult = {
      reason: 'CHECKED', staged: false, deferred: null, reverted: false, update: null,
    };
    const identity = await Overair.identity();
    const apiUrl = this.options.apiUrl ?? identity.apiUrl;
    const apiKey = this.options.apiKey ?? identity.apiKey;
    if (!apiUrl || !apiKey) {
      this.log('no apiUrl/apiKey in capacitor.config or options; nothing to do');
      return idle;
    }
    this.api = new DeliveryApi(apiUrl, apiKey);
    await this.flushQueued();

    const status = await Overair.status();
    await this.reportRollback(status);

    let response: CheckResponse;
    try {
      response = await this.api.check({
        install_id: identity.installId,
        platform: Capacitor.getPlatform() as Platform,
        runtime: this.options.runtime || identity.runtime,
        channel: this.options.channel || identity.channel,
        app_version: identity.appVersion,
        build_number: identity.nativeBuild,
        os_version: '',
        locale: typeof navigator !== 'undefined' ? navigator.language : '',
        custom_id: this.options.customId ?? '',
        attrs: this.options.attrs ?? {},
        current_bundle: status.current?.id ?? '',
        embedded_at: embeddedTime(this.options.embeddedAt || identity.embeddedAt),
        quarantined: status.quarantined,
      });
    } catch (error) {
      // Offline is the normal case, not an error worth surfacing: the app
      // runs on what it has and asks again next time.
      this.log(`check failed: ${(error as Error).message}`);
      return idle;
    }

    this.log(`check -> ${response.reason}`);
    if (response.revert) {
      await Overair.reset();
      await this.emit('REVERTED');
      return {
        reason: response.reason, staged: false, deferred: null, reverted: true, update: null,
      };
    }

    const update = response.update;
    this.deferred = null;
    if (!update) return { ...idle, reason: response.reason };

    if (shouldDefer(update, this.acceptedId)) {
      this.log(`deferred ${update.version}: ${update.size} over ${update.auto_max_bytes}`);
      this.deferred = update;
      return {
        reason: response.reason, staged: false, deferred: update, reverted: false, update,
      };
    }

    // Already on disk and waiting for the next launch. The server keeps
    // OFFERING it until this device reports it as current, which only
    // happens after notifyReady - so without this check every launch in
    // between re-downloads a bundle we already have.
    if (status.next?.id === update.bundle_id) {
      this.log(`${update.version} is already staged; not downloading again`);
      return {
        reason: response.reason, staged: true, deferred: null, reverted: false, update,
      };
    }

    return this.stage(update, response.reason, identity.installId);
  }

  private async stage(update: Manifest, reason: Reason, installId: string): Promise<SyncResult> {
    await this.emit('DOWNLOAD_STARTED', update.bundle_id);
    try {
      await Overair.download({
        id: update.bundle_id,
        version: update.version,
        url: update.url,
        checksum: update.sha256,
      });
      await this.emit('DOWNLOADED', update.bundle_id);
      await Overair.next({ id: update.bundle_id });
      await this.emit('APPLIED', update.bundle_id);
      this.log(`staged ${update.version}; it runs on the next launch`);
      this.deferred = null;
      this.acceptedId = null;
      return { reason, staged: true, deferred: null, reverted: false, update };
    } catch (error) {
      const message = (error as Error).message;
      this.log(`staging failed: ${message}`);
      const detail = { message: message.slice(0, MAX_MESSAGE), installId };
      if (await this.unusable(update.bundle_id)) {
        // The same URL gives the same bytes: a digest mismatch or an archive
        // that cannot run here. Refused on this device and on the server.
        try {
          await Overair.quarantine({ id: update.bundle_id });
        } catch {
          // The server's quarantine still stops the offer.
        }
        await this.emit('FAILED', update.bundle_id, 'bad_bundle', detail);
      } else {
        // NOT quarantined: a download or disk failure, not a bundle that
        // cannot run. Refusing it forever would refuse bytes never tried.
        // Capped: the server refuses an event whose detail is over 4 KB.
        await this.emit('FAILED', update.bundle_id, 'stage_failed', detail);
      }
      return { reason, staged: false, deferred: null, reverted: false, update };
    }
  }

  private async unusable(id: string): Promise<boolean> {
    try {
      const { failure } = (await Overair.status()).download;
      return failure?.id === id && (failure.code === 'unpack' || failure.code === 'digest');
    } catch {
      return false;
    }
  }

  /** Telemetry never makes a device wait, and a failed report must never
   *  fail the update it was describing. */
  /** True once the server has the event; false when held or dropped. */
  private async emit(type: Reason, bundle?: string, errorCode?: string,
                     detail?: Record<string, unknown>): Promise<boolean> {
    try {
      const { installId } = await Overair.identity();
      const event: DeviceEvent = {
        install_id: installId,
        type,
        bundle: bundle ?? '',
        error_code: errorCode ?? '',
        detail: detail ?? {},
      };
      if (!this.api) {
        // Held, not dropped. Bounded, because a build with OTA switched off
        // never syncs and this would otherwise grow for the life of the app.
        if (this.queued.length < QUEUED_EVENT_LIMIT) this.queued.push(event);
        return false;
      }
      await this.api.report([event]);
      return true;
    } catch {
      // Dropped on purpose. The console being blind for one event is a
      // smaller problem than an update failing because reporting did.
      return false;
    }
  }

  /** Send whatever was raised before the endpoint was known. Same bargain as
   *  `emit`: reporting must never be why an update fails. */
  private async flushQueued(): Promise<void> {
    if (!this.api || this.queued.length === 0) return;
    const pending = this.queued;
    this.queued = [];
    try {
      await this.api.report(pending);
    } catch {
      // Same as emit.
    }
  }

  private log(message: string): void {
    if (this.options.debug) console.log(`[overair] ${message}`);
  }
}

/** One instance: two of these racing would be two answers to a question
 *  that has one, and both would download. */
export const OverairUpdater = new Updater();
