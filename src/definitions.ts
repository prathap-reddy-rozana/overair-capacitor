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

export interface OverairStatus {
  /** What the webview is serving right now. Null on the embedded build. */
  current: BundleInfo | null;
  /** Unpacked and verified, waiting for the next launch. */
  next: BundleInfo | null;
  /** Ids this device tried and refused. Sent on every check so the server
   *  stops offering them rather than the device rediscovering the break. */
  quarantined: string[];
  /** True when the last launch rolled a bundle back. The SDK reports it. */
  rolledBack: boolean;
  /** The bundle that was rolled back, if any. */
  rolledBackId: string | null;
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
  /** What is running, what is waiting, and what was refused. */
  status(): Promise<OverairStatus>;

  /** Identity and configuration, from native config. */
  identity(): Promise<OverairIdentity>;

  /**
   * Download, verify and unpack a bundle. Native throughout: streamed to
   * disk, hashed while streaming, unzipped without holding the archive in
   * the webview's heap.
   */
  download(options: DownloadOptions): Promise<BundleInfo>;

  /** Make a downloaded bundle the one the next launch runs. */
  next(options: { id: string }): Promise<void>;

  /**
   * Confirm the running bundle started.
   *
   * An app that never calls this is treated as never having booted: the next
   * launch rolls back before the webview loads. That is the watchdog, and it
   * only works because the decision is native.
   */
  notifyReady(): Promise<void>;

  /** Refuse a bundle forever. Reported as `quarantined` on every check. */
  quarantine(options: { id: string }): Promise<void>;

  /** Drop to the build compiled into the binary and forget the rest. */
  reset(): Promise<void>;

  /** Delete everything except what is running and what is next. */
  prune(): Promise<void>;
}
