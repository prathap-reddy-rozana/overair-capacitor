import { describe, expect, it } from 'vitest';

import { shouldDefer } from './index';
import type { Manifest } from './types';

/** 2 MB against a 1 MB ceiling: the ordinary case that has to ask. */
function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    bundle_id: '26',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    size: 2_097_152,
    url: 'https://example.test/b.zip',
    signature: null,
    mandatory: false,
    auto_max_bytes: 1_048_576,
    tree_sha256: '',
    delta: null,
    ...over,
  };
}

describe('shouldDefer', () => {
  it('asks before spending somebody\'s data plan', () => {
    expect(shouldDefer(manifest(), null)).toBe(true);
  });

  it('does not ask when the bundle fits under the ceiling', () => {
    expect(shouldDefer(manifest({ size: 500_000 }), null)).toBe(false);
    // Zero means no ceiling at all, not a ceiling of nothing.
    expect(shouldDefer(manifest({ auto_max_bytes: 0 }), null)).toBe(false);
  });

  it('does not ask for a mandatory release', () => {
    expect(shouldDefer(manifest({ mandatory: true }), null)).toBe(false);
  });

  it('does not ask again for a bundle the user already accepted', () => {
    // The retry path. `retry` re-checks rather than replaying a presigned URL,
    // so without this the ceiling defers the very bundle the user agreed to
    // and the Try again button does nothing, however often it is pressed.
    expect(shouldDefer(manifest({ bundle_id: '26' }), '26')).toBe(false);
  });

  it('still asks for a DIFFERENT bundle after one was accepted', () => {
    // Agreeing to one large update is not agreeing to the next one.
    expect(shouldDefer(manifest({ bundle_id: '27' }), '26')).toBe(true);
  });
});
