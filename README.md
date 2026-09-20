# @overair/capacitor

Over-the-air updates for Capacitor apps. A real plugin: Kotlin on Android,
Swift on iOS, TypeScript for the protocol.

> [!IMPORTANT]
> **Call `notifyReady()` after your app renders.** An app that never calls it
> is treated as never having booted, and the next launch rolls the update back
> before the webview loads. That is the watchdog, and it is the whole reason a
> broken bundle cannot brick the app.

---

## Why it is native

Everything that has to survive a web bundle which cannot execute lives in
Kotlin and Swift, because it must run **before any JavaScript does**:

| Capability | Where | Why not TypeScript |
|---|---|---|
| The boot decision | `BootDecision.kt` / `.swift` | Runs in `load()`, before the webview is told to load anything |
| Rollback | same | A bundle that white-screens has no JavaScript left to roll itself back |
| Identity (`channel`, `runtime`) | plugin config | In the web layer, an update could change which channel its own device subscribes to |
| Download + `sha256` | `Bundles.kt` / `.swift` | Streams to disk and hashes in chunks, so a 60 MB bundle costs a buffer rather than 60 MB of heap |
| Unzip | same | Android has `java.util.zip`; iOS has no public zip reader, hence ZIPFoundation |

The protocol half - asking `/v1/check` and reporting to `/v1/events` - is
ordinary HTTP and stays in TypeScript.

## Install

```bash
npm install github:rozana-dev/overair-capacitor
npx cap sync
```

Then configure the binary in `capacitor.config.ts`. These belong here, not in
your app code: this file is compiled into the binary and an update cannot
rewrite it.

```ts
const config: CapacitorConfig = {
  plugins: {
    Overair: {
      apiUrl: 'https://overair.example.com',
      apiKey: 'oa_client_...',   // a client key is public by design
      channel: 'production',     // what this binary subscribes to, forever
      runtime: 'fp_a91c4e2d1fb', // this native build's fingerprint
    },
  },
};
```

## Use

```ts
import { OverairUpdater } from '@overair/capacitor';

// Anywhere after startup. Safe to call on launch and on resume.
await OverairUpdater.sync();

// After your first meaningful render.
await OverairUpdater.notifyReady();
```

`sync()` checks, downloads, verifies and stages. The update runs on the **next
launch** - never mid-session, because swapping the web root under a running app
means reloading it under the user.

```ts
const result = await OverairUpdater.sync();
result.staged     // downloaded and verified; runs next launch
result.deferred   // offered but over auto_max_bytes - your call
result.reverted   // the server asked this device back to its embedded build
result.reason     // why, including every refusal
```

A bundle larger than the server's `auto_max_bytes` is **not** downloaded
automatically, because the device is the only thing that knows it is on
somebody's data plan. Prompt, then call `sync()` again when the user agrees.

For direct control, the plugin itself is exported as `Overair`: `status()`,
`download()`, `next()`, `quarantine()`, `reset()`, `prune()`.

## What happens on a launch

1. Native `load()` runs before the webview loads anything.
2. If the native build changed, every staged bundle is dropped - they were
   unpacked for a binary that no longer exists.
3. If the last launch served a bundle that never confirmed, that bundle is
   quarantined and the last **working** one takes over.
4. Otherwise the newest verified bundle is served.
5. Your app calls `notifyReady()`, which promotes it and stops the watchdog.

The full table is in [`docs/DESIGN.md`](docs/DESIGN.md) §2, and it is what
`BootDecisionTest.kt` and `BootDecisionTests.swift` assert row by row. The two
files are the same function in two languages; if they ever disagree, one
platform is rolling back when the other is not.

## Develop

```bash
npm install && npm run build          # TypeScript
npm test                              # TypeScript tests
xcodebuild -scheme OverairCapacitor \
  -destination 'generic/platform=iOS Simulator' build   # iOS
```

Swift tests need a simulator destination, and the Kotlin ones need a host app
providing `capacitor-android` - `./gradlew :overair-capacitor:testDebugUnitTest`
from an app that has this plugin installed.

`swift build` alone will not work: it targets macOS, and Capacitor's
xcframework is iOS-only.

## Not yet

- **Deltas.** The server offers them; this downloads the full bundle. Safe to
  defer because the full URL is always offered beside a delta.
- **Background download.** Updates land on launch and resume.
- **A bundle that confirms and later crashes** is not caught. The watchdog
  proves the app reached first render, not that it works.
