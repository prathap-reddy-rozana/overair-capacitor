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
npm install github:prathap-reddy-rozana/overair-capacitor
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

// main.ts, BEFORE the app bootstraps. Not behind your app's own
// initialisation: an update is most needed exactly when the app cannot
// finish starting.
await OverairUpdater.notifyReady();   // confirm this boot
await OverairUpdater.sync();          // then check
```

`notifyReady()` must come first. It is what promotes a staged bundle to
current; a check that overtakes it reports the device as running nothing, and
the server offers back the bundle it is already running.

`sync()` checks, downloads, verifies and unpacks. The update runs on the
**next launch** unless you apply it sooner.

```ts
const result = await OverairUpdater.sync();
result.staged     // downloaded and verified
result.deferred   // offered but over auto_max_bytes - your call
result.reverted   // the server sent this device back to its embedded build
result.update     // the manifest: version, size, and `mandatory`
result.reason     // why, including every refusal
```

**A deferred update needs `accept()`.** `auto_max_bytes` is the server saying
ASK, not refuse: anything over it is left alone so a 20 MB bundle does not
land on somebody's data plan unannounced. Show the version and size, and call
`accept()` when they agree. Without that call the deferred manifest is
something to display and nothing more.

```ts
const { deferred } = await OverairUpdater.sync();
if (deferred) showUpdateButton(deferred.version, deferred.size);

await OverairUpdater.accept();   // stages it, exactly as sync would have
```

A mandatory release ignores the ceiling and stages itself, so `accept()` is
only ever needed for an optional one.

## Overriding what the binary was built with

`sync()` takes `apiUrl`, `apiKey`, `channel` and `runtime`, each falling back
to `capacitor.config`. The first three are ordinary remote settings. The fourth
is not:

**`runtime` has nothing behind it — it IS the guard.** It is the assertion that
this binary can run bundles built for a given native surface, and the only
thing between a device and a bundle calling native code it does not have.
Nothing checks an override against the binary, because nothing can: a value
that disagrees will be believed, and the device will be offered a bundle it
cannot run. If that bundle fails to start the watchdog rolls it back, and the
server goes on offering it — a loop that repeats every launch.

Empty means "use the binary's own", which is the right value unless a store
release really did change the native surface. Two ways to supply it:

```ts
// Keyed on the build, so a config cannot claim a binary is one it is not.
const { nativeBuild } = await Overair.identity();
await OverairUpdater.sync({ runtime: runtimeByBuild[nativeBuild] ?? '' });

// Or plainly, if your config surface is trusted and change-controlled.
await OverairUpdater.sync({ runtime: remoteConfig.runtime });
```

The first cannot be wrong about which binary it is talking to. The second is
simpler and is fine where the people editing the config are the people
shipping the builds — just know that it carries the risk above.

## Progress, cancel, retry

```ts
await OverairUpdater.onProgress(({ fraction, bytes, total }) => {
  bar.value = fraction;   // -1 when the server sends no content length
});

await OverairUpdater.onStateChange(({ state, failure }) => {
  if (state === 'READY') showUpdateButton();
  if (state === 'FAILED' && failure?.retryable) showRetry();
});

await OverairUpdater.cancel();   // safe whether or not one is running
await OverairUpdater.retry();    // rejects when the failure is not retryable
```

States are `DOWNLOADING`, `VERIFYING`, `UNPACKING`, `READY`, `FAILED`,
`CANCELLED`. Verifying and unpacking are separate because they are separately
slow and separately able to fail.

**`retry()` re-checks rather than replaying.** Download URLs are presigned and
short-lived; replaying one re-uses a link that may have expired. It refuses a
`digest` failure outright - the bytes on the server are wrong, and a fresh link
fetches the same wrong bytes.

Re-checking means the size ceiling is applied again, so a bundle the user
accepted through `accept()` is remembered by id and not deferred a second
time. Without that the retry button would re-ask instead of retrying. A
different large bundle offered later still asks: agreeing to one update is
not agreeing to the next.

Listeners do not survive a bundle swap, which reloads the web layer. The
authoritative state is native and outlives it:

```ts
const { state, fraction, failure } = await OverairUpdater.downloadStatus();
```

## Applying an update

```ts
await OverairUpdater.applyNow();   // reloads the webview into the new bundle
```

**The reload is the restart.** An iOS app cannot relaunch itself - `exit()`
reads as a crash and is rejected in review - and killing the process drops the
user on a home screen with no explanation. A reload replaces the whole web
layer, which is the part an update replaces anyway.

Nothing runs after this call: the page that made it is gone. Ask the user
first, because anything unsaved on screen goes with it.

## Force update

`result.update?.mandatory` is set by the **server**, on the release. A client
that could decide this itself could lock out its own user.

When it is set, block: no dismiss, nothing else reachable, one action. The SDK
also ignores `auto_max_bytes` for a mandatory release - a build that is
actively broken is worth the megabytes.

## When something breaks

Two different failures, two different answers.

**A bundle that never starts** is caught with no help from you: it is
quarantined before the webview loads on the next launch, and its predecessor
takes over. Embedded is the floor, not the first resort.

**A bundle that starts and is then plainly broken** only the app can see:

```ts
const { rolledBackTo } = await OverairUpdater.rollback();
```

That refuses the current bundle forever and steps back one. `reset()` is the
blunt instrument that drops all the way to the binary; `rollback()` is almost
always what you want, because it costs the user one update rather than all of
them.

## What happens on a launch

1. Native `load()` runs before the webview loads anything.
2. If the native build changed, every staged bundle is dropped - they were
   unpacked for a binary that no longer exists.
3. If the last launch served a bundle that never confirmed, that bundle is
   quarantined and its predecessor takes over - one update lost, not all.
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

`dist/` is committed on purpose. This is consumed as a git dependency, and npm
does not reliably run `prepare` for one - without it a consumer installs a
package with no JavaScript in it. Rebuild it in the same commit as any
TypeScript change.

## Not yet

- **Android is unverified end to end.** It compiles and its unit tests pass,
  but no Android device has taken an update.
- **Deltas.** The server offers them; this downloads the full bundle. Safe to
  defer because the full URL is always offered beside a delta.
- **No resume.** A cancelled or dropped download restarts from zero.
- **Background download.** Updates land on launch and resume.
- **A bundle that confirms and later crashes** is not caught automatically.
  The watchdog proves the app reached first render, not that it works -
  `rollback()` is there for when the app knows better.
