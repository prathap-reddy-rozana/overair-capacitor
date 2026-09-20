import { WebPlugin } from '@capacitor/core';

import type {
  BundleInfo, DownloadOptions, DownloadStatus, OverairIdentity, OverairPlugin, OverairStatus,
} from './definitions';

/**
 * The web implementation, which deliberately does nothing.
 *
 * There is no over-the-air update in a browser: the page IS the latest
 * version, reloaded from the server every time. Every method resolves to an
 * empty, honest answer so a shared codebase can call the SDK during `ng
 * serve` without branching on the platform - and none of them pretends to
 * have applied anything.
 */
export class OverairWeb extends WebPlugin implements OverairPlugin {

  async status(): Promise<OverairStatus> {
    return {
      current: null, next: null, quarantined: [],
      rolledBack: false, rolledBackId: null,
      download: this.idle(),
    };
  }

  private idle(): DownloadStatus {
    return { id: '', state: 'IDLE', bytes: 0, total: 0, fraction: -1, failure: null };
  }

  async identity(): Promise<OverairIdentity> {
    return {
      installId: 'web',
      channel: '',
      runtime: '',
      nativeBuild: '',
      appVersion: '',
      apiUrl: '',
      apiKey: '',
    };
  }

  async download(_options: DownloadOptions): Promise<BundleInfo> {
    throw this.unavailable('Bundles are only downloaded on a device.');
  }

  async next(_options: { id: string }): Promise<void> {
    throw this.unavailable('Bundles are only applied on a device.');
  }

  async cancel(): Promise<void> {
    return;
  }

  async retry(): Promise<BundleInfo> {
    throw this.unavailable('Bundles are only downloaded on a device.');
  }

  /** The one method that succeeds on web: an app that calls it on every
   *  platform should not have to guard the call. */
  async notifyReady(): Promise<void> {
    return;
  }

  async quarantine(_options: { id: string }): Promise<void> {
    return;
  }

  async reset(): Promise<void> {
    return;
  }

  async prune(): Promise<void> {
    return;
  }
}
