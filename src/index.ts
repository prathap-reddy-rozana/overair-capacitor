import { Capacitor, registerPlugin } from '@capacitor/core';

import { DeliveryApi } from './api';
import type { OverairPlugin } from './definitions';
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
class Updater {
  private api: DeliveryApi | null = null;
  private options: UpdaterOptions = {};
  private inFlight: Promise<SyncResult> | null = null;

  /**
   * Ask the server, and act on the answer.
   *
   * Safe to call whenever - launch, resume, a button. A second call while
   * one is running joins the first rather than starting a second download.
   */
  async sync(options: UpdaterOptions = {}): Promise<SyncResult> {
    this.options = { ...this.options, ...options };
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
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
    if (status.current) await this.emit('READY', status.current.id);
  }

  /** What the webview is serving, or null on the build in the binary. */
  async current() {
    return (await Overair.status()).current;
  }

  /** Back to the build compiled into the binary, forgetting the rest. */
  async reset(): Promise<void> {
    await Overair.reset();
    await this.emit('REVERTED');
  }

  private async run(): Promise<SyncResult> {
    const idle: SyncResult = { reason: 'CHECKED', staged: false, deferred: null, reverted: false };
    const identity = await Overair.identity();
    const apiUrl = this.options.apiUrl ?? identity.apiUrl;
    const apiKey = this.options.apiKey ?? identity.apiKey;
    if (!apiUrl || !apiKey) {
      this.log('no apiUrl/apiKey in capacitor.config or options; nothing to do');
      return idle;
    }
    this.api = new DeliveryApi(apiUrl, apiKey);

    const status = await Overair.status();
    // A rollback happens natively, before any JavaScript exists to see it.
    // This is the first moment it can be reported, and reporting it is the
    // difference between a console that shows a failed release and one that
    // shows a release nobody ever took.
    if (status.rolledBack && status.rolledBackId) {
      this.log(`rolled back ${status.rolledBackId} before boot`);
      await this.emit('FAILED', status.rolledBackId, 'boot_failed');
    }

    let response: CheckResponse;
    try {
      response = await this.api.check({
        install_id: identity.installId,
        platform: Capacitor.getPlatform() as Platform,
        runtime: identity.runtime,
        channel: identity.channel,
        app_version: identity.appVersion,
        build_number: identity.nativeBuild,
        os_version: '',
        locale: typeof navigator !== 'undefined' ? navigator.language : '',
        custom_id: this.options.customId ?? '',
        attrs: this.options.attrs ?? {},
        current_bundle: status.current?.id ?? '',
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
      return { reason: response.reason, staged: false, deferred: null, reverted: true };
    }

    const update = response.update;
    if (!update) return { ...idle, reason: response.reason };

    // The ceiling is the device's call because it is the only thing that
    // knows it is on somebody's data plan. Mandatory overrides it: a build
    // that is actively broken is worth the megabytes.
    if (update.auto_max_bytes > 0 && update.size > update.auto_max_bytes && !update.mandatory) {
      this.log(`deferred ${update.version}: ${update.size} over ${update.auto_max_bytes}`);
      return { reason: response.reason, staged: false, deferred: update, reverted: false };
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
      return { reason, staged: true, deferred: null, reverted: false };
    } catch (error) {
      const message = (error as Error).message;
      this.log(`staging failed: ${message}`);
      // NOT quarantined: this is a download or disk failure, not a bundle
      // that cannot run. Refusing it forever would refuse bytes never tried.
      await this.emit('FAILED', update.bundle_id, 'stage_failed', { message, installId });
      return { reason, staged: false, deferred: null, reverted: false };
    }
  }

  /** Telemetry never makes a device wait, and a failed report must never
   *  fail the update it was describing. */
  private async emit(type: Reason, bundle?: string, errorCode?: string,
                     detail?: Record<string, unknown>): Promise<void> {
    try {
      const { installId } = await Overair.identity();
      const event: DeviceEvent = {
        install_id: installId,
        type,
        bundle: bundle ?? '',
        error_code: errorCode ?? '',
        detail: detail ?? {},
      };
      await this.api?.report([event]);
    } catch {
      // Dropped on purpose. The console being blind for one event is a
      // smaller problem than an update failing because reporting did.
    }
  }

  private log(message: string): void {
    if (this.options.debug) console.log(`[overair] ${message}`);
  }
}

/** One instance: two of these racing would be two answers to a question
 *  that has one, and both would download. */
export const OverairUpdater = new Updater();
