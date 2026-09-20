/**
 * The delivery plane's wire contract, mirroring the server's serializers.
 *
 * Plain types rather than generated from the OpenAPI schema: this is four
 * shapes, and generating them would put a build step between a contract
 * change and noticing it.
 */

export type Platform = 'android' | 'ios' | 'web';

/** Every outcome the server can report, including every refusal. */
export type Reason =
  | 'CHECKED' | 'OFFERED' | 'UP_TO_DATE' | 'CONFIG_ERROR'
  | 'HELD_RUNTIME' | 'HELD_TARGETING' | 'HELD_ROLLOUT'
  | 'HELD_QUARANTINE' | 'HELD_CHANNEL'
  | 'DOWNLOAD_STARTED' | 'DOWNLOADED' | 'APPLIED' | 'READY'
  | 'FAILED' | 'REVERTED' | 'REVERT_TO_EMBEDDED';

export interface CheckRequest {
  install_id: string;
  platform: Platform;
  runtime: string;
  os_version?: string;
  app_version?: string;
  build_number?: string;
  channel?: string;
  locale?: string;
  custom_id?: string;
  attrs?: Record<string, unknown>;
  current_bundle?: string;
  /** Bundles this device already refused. It knows, so it says. */
  quarantined?: string[];
}

/** A shortcut from the bundle this device has. Always optional: the full
 *  `url` is offered beside it, so failing to apply one costs nothing. */
export interface Delta {
  url: string;
  sha256: string;
  size: number;
  from_bundle: string;
}

export interface Manifest {
  bundle_id: string;
  version: string;
  sha256: string;
  size: number;
  url: string;
  signature: string | null;
  mandatory: boolean;
  /** Above this, ask before spending somebody's data plan. Zero means no
   *  ceiling. The device is the only thing that knows it is on cellular. */
  auto_max_bytes: number;
  tree_sha256: string;
  delta: Delta | null;
}

export interface CheckResponse {
  update: Manifest | null;
  reason: Reason;
  /** Only on REVERT_TO_EMBEDDED. The kill switch is an instruction to act
   *  on, not an absence to interpret. */
  revert?: boolean;
}

export interface DeviceEvent {
  install_id: string;
  type: Reason;
  bundle?: string;
  error_code?: string;
  detail?: Record<string, unknown>;
}
