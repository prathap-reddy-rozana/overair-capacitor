# The Overair Capacitor plugin

> **Native owns the device; TypeScript owns the protocol.** Everything that has
> to survive a web bundle which cannot execute - the boot decision, the
> rollback, the identity this binary subscribes to - runs in Kotlin and Swift
> before any JavaScript does. Asking `/v1/check` is ordinary HTTP and stays in
> TypeScript.

Design and decision record. Written before the code, corrected where building
and shipping it proved the design wrong - each correction marked, because a
design doc that quietly disagrees with the code is worse than none.

---

## 1 · How this got here

The first design was a **pure TypeScript library, no native code**, and the
reasoning was measured rather than assumed. Everything an OTA updater needs is
already native inside Capacitor:

| The SDK must | Provided by | Where |
|---|---|---|
| Download a bundle | `Filesystem.downloadFile` | `@capacitor/filesystem` `definitions.d.ts:626` |
| Point the webview at it | `WebView.setServerBasePath` - a **core** plugin | `@capacitor/core` `core-plugins.d.ts:6` |
| Verify `sha256` | WebCrypto | webview builtin |
| **Unzip** | **nothing** | the only gap |

A spike measured that one gap against a real 292-file, 7.26 MB Capacitor build
on an iPhone 16 Pro simulator:

| Phase | Time |
|---|---:|
| fetch the archive | 4 ms |
| `sha256` verify | 3 ms |
| unzip (`fflate`) | 102 ms |
| base64-encode 292 entries | 43 ms |
| `Filesystem.writeFile` x292 | 237 ms - **0.81 ms/file** |
| **archive to disk** | **382 ms** |

That number stands and it is not why the design changed.

> [!IMPORTANT]
> **D1 was reversed.** The measurement settled *speed*, which was never the
> real question. The question was what happens to a bundle that cannot
> execute, and only native code can answer it: `load()` runs while the bridge
> is being built, **before the webview is told to load anything**. That is the
> single place a white-screening bundle can be rolled back - by the time any
> JavaScript could notice, the broken bundle is already what is running. A
> pure-TS design could only approximate this by never persisting a base path
> and paying a boot hop on every launch.

What the reversal cost, and it is real: consumers need `cap sync` and a native
build, the package is pinned to a Capacitor major, and **a bug in the updater
now needs a store release to fix**. That last one is a genuinely strange
property for the thing whose job is to avoid store releases, and it is the
price of being able to recover from a bundle that will not start.

---

## 2 · The boot decision  *(the decision table)*

`native` = the current build number · `stored` = the build recorded when the
bundles were unpacked · `pending` = the last launch served a bundle that never
called `notifyReady()`

| # | `stored == native` | on disk | `pending` | -> serves | -> and |
|:-:|---|---|:-:|---|---|
| 1 | n/a | nothing | n/a | embedded | check for an update |
| 2 | **no** | anything | n/a | embedded | **discard every bundle** - they were unpacked for a binary that is gone |
| 3 | yes | staged | no | **the staged bundle** | mark PENDING; it gets one launch to prove itself |
| 4 | yes | active | no | the active bundle | check for an update |
| 5 | yes | staged + active | **yes** | the **active** one | quarantine the staged bundle, report `FAILED` |
| 6 | yes | active + previous | **yes** | the **previous** one | quarantine the active bundle; the previous **becomes** the active one |
| 7 | yes | active only | **yes** | embedded | quarantine it; nothing left to fall back to |

Rows 2, 5, 6 and 7 are the ones that earn the table.

**The invariant across every row: a bundle that has already had its one launch
and did not confirm is never served again.** Asserted directly, over every
combination of facts, in both `BootDecisionTest.kt` and `BootDecisionTests.swift`.

> [!NOTE]
> **Row 6 was added after the first version.** A failed bundle originally sent
> the user all the way back to the build in their binary, losing every update
> they had ever taken. Stepping back one costs them the broken update instead.
> Embedded is the floor, not the first resort - which is why the store keeps a
> predecessor and `prune()` keeps its files. A fallback whose files were
> deleted is not a fallback.
>
> **Corrected.** Row 6 first served the predecessor without promoting it: the
> active record was cleared and the predecessor left where it was, so the
> launch after found nothing active and served embedded anyway. The decision
> now also returns what the store holds afterwards, and both test files follow
> it one launch further.

<details open>
<summary>Diagram 1 — the boot path</summary>

```mermaid
flowchart TD
  A["cold start<br/>load() runs"] --> B{"native build<br/>changed?"}
  B -->|"Yes"| C["discard everything"]
  B -->|"No"| D{"last boot<br/>confirmed?"}
  D -->|"No"| E["quarantine it<br/>step back one"]
  D -->|"Yes"| F{"a bundle<br/>to serve?"}
  C --> G["serve embedded"]
  E --> F
  F -->|"No"| G
  F -->|"Yes"| H["serve it<br/>mark pending"]
  G --> I["check for an update"]
  H --> J["app calls notifyReady"]
  J --> I

  classDef roz  fill:#eaedfb,stroke:#3a52c8,color:#2438a0;
  classDef ok   fill:#e5f3ec,stroke:#1c7a4a,color:#1c7a4a;
  classDef warn fill:#fdf3e3,stroke:#b5761f,color:#8a5a13;
  class A,B,D,F roz;
  class H,I,J ok;
  class C,E,G warn;
```

</details>

---

## 3 · Identity comes from the binary

`channel` is what a binary subscribes to at build time, forever
(`releases/models.py:25`). It is read from the **native plugin config** in
`capacitor.config.ts`, along with `runtime`, `apiUrl` and `apiKey`.

If it lived in the web layer, a bundle mis-published to the wrong channel would
move every device that took it onto that channel **permanently** - no later,
correct publish on the old channel could ever reach them again, because they
are no longer asking for it.

> [!NOTE]
> **Corrected.** The pure-TS design captured these into Preferences on the
> first launch from the embedded bundle and refused to overwrite them. That
> worked, but it was a workaround for not having native config. Reading
> `capacitor.config.ts` natively is the same guarantee without the ceremony:
> the file is compiled into the binary and an update cannot rewrite it.

---

## 4 · Integration

```ts
// capacitor.config.ts - in the binary, not in app code
plugins: {
  Overair: {
    apiUrl: 'https://overair.example.com',
    apiKey: 'oa_client_...',    // a client key is public by design
    channel: 'production',
    runtime: 'fp_a91c4e2d1fb',  // this native build's fingerprint
  },
}
```

```ts
// main.ts - BEFORE the app bootstraps
await startOta();               // confirm this boot, then check
bootstrapApplication(AppComponent, appConfig);
```

> [!IMPORTANT]
> **Do not put the check behind the app's own initialisation.** An update is
> most needed exactly when the app cannot finish starting. Wired into a
> component, it never ran at all while the host app's initializer was hanging -
> the update mechanism sitting behind the thing it exists to repair.

> [!NOTE]
> **Corrected.** This section previously specified a separate `overair-boot.js`
> owning `index.html`'s entry point. Two things were wrong with it: the native
> `load()` already decides before the webview loads, so nothing in the web
> layer needs to run first; and a second script would have meant **two
> implementations of the boot decision**, exactly what `DELIVERY_MODEL.md` §8
> S4 rules out for the rule matcher.

**Confirmation must precede the check.** `notifyReady()` is what promotes a
staged bundle to current; a check that overtakes it reports the device as
running nothing, and the server dutifully offers back the bundle it is already
running.

---

## 5 · The update lifecycle

| State | Meaning |
|---|---|
| `DOWNLOADING` | streaming to disk; Android hashes as it goes |
| `VERIFYING` | digest checked before a single file is written; iOS hashes the landed file here |
| `UNPACKING` | expanding; entries that escape the directory are refused |
| `READY` | on disk and verified |
| `FAILED` | with a `code` and whether a retry is worth offering |
| `CANCELLED` | somebody stopped it - honoured in every phase, including before the request exists; partial output deleted |

Verifying and unpacking are separate states because they are separately slow
and separately able to fail: a digest mismatch and a corrupt archive are
different problems, and only one of them is worth retrying.

From `READY` there are two ways in:

- **Next launch** - the default. Nothing is interrupted.
- **`applyNow()`** - reloads the webview into the new bundle immediately.

**The reload is the restart.** An iOS app cannot relaunch itself: `exit()`
reads as a crash and is rejected in review, and killing the process drops the
user on a home screen with no explanation. A reload replaces the entire web
layer, which is the part an OTA update replaces anyway. `applyNow()` sets
`pending` exactly as a launch-time swap does, so a bundle that breaks this way
is caught by the same watchdog and needs no separate path.

**Retry re-checks; it does not replay.** Download URLs are presigned and
short-lived. Replaying the attempt that failed re-uses a link that may have
expired - a button that cannot work however many times it is pressed.
`retryable` is still honoured: a digest mismatch means the bytes on the server
are wrong, and a fresh link fetches the same wrong bytes.

---

## 6 · Force update

`mandatory` is set by the **server**, on the release. A client that could
decide this for itself would be a client that can lock out its own user.

When set, the host app is expected to block: no dismiss, nothing else
reachable, one action. The SDK also ignores `auto_max_bytes` for a mandatory
release - a build that is actively broken is worth the megabytes.

---

## 7 · Cases matrix — input / state -> expected outcome

| Input / state | Expected outcome |
|---|---|
| First ever launch | `install_id` generated once, never regenerated |
| Check returns `update: null` | nothing downloaded, `reason` recorded |
| Digest mismatch | discarded, `FAILED` with code `digest`, **not** retryable |
| HTTP or network failure | `FAILED`, retryable, retry performs a fresh check |
| Size over `auto_max_bytes`, not mandatory | not downloaded; reported as deferred |
| Size over `auto_max_bytes`, mandatory | downloaded anyway |
| Bundle already staged, offered again | **not** re-downloaded |
| Staged bundle confirms | becomes current, predecessor retained |
| Staged bundle never confirms | quarantined; previous serves; `FAILED` reported |
| A quarantined bundle is offered again | sent in `quarantined`; server answers `HELD_QUARANTINE` |
| Native build changed | every bundle discarded, embedded serves |
| `applyNow()` with nothing staged | rejects |
| `rollback()` with no predecessor | lands on embedded |
| Archive entry containing `..` or a symlink | refused, and everything already unpacked deleted - never served |
| Airplane mode | check fails silently, app runs on what it has |

---

## 8 · Decisions — signed off

| # | Decision | Ruling |
|:-:|---|---|
| **D1** | ~~Pure TS library~~ Native plugin? | **REVERSED to native.** Speed was never the question; recovering a bundle that will not execute was, and only `load()` can. Cost: `cap sync`, a Capacitor major pin, and a store release to fix the updater itself. |
| **D2** | Call `persistServerBasePath`? | **No.** The plugin decides on every launch in `load()`. Persisting would let Capacitor restore a path the decision has not seen. |
| **D3** | Where do `channel` and `runtime` live? | **Native plugin config.** In the web layer they are editable by the very thing they constrain. |
| **D4** | Timer watchdog, or next-launch? | **Next launch.** The failure defended against is "no JavaScript ran at all", and a timer is JavaScript. |
| **D5** | Fall back to embedded, or to the predecessor? | **The predecessor.** Embedded is the floor. A broken bundle should cost one update, not all of them. |
| **D6** | Kill the process to apply, or reload the webview? | **Reload.** iOS cannot relaunch itself, and the web layer is the whole of what an update replaces. |
| **D7** | Retry by replaying, or by re-checking? | **Re-check.** A presigned URL that failed may simply have expired. |
| **D8** | Who decides an update is mandatory? | **The server.** A client that could decide it could lock out its own user. |
| **D9** | Deltas in v1? | **No.** The full `url` is always offered beside a delta, so this defers at no cost to correctness. |
| **D10** | Publish to npm? | **Not yet - a git dependency.** `dist/` is committed, because npm does not reliably run `prepare` for one. |

---

## 9 · What integrating it into a real app found

Every one of these passed unit tests, compiled, and was wrong. They are
recorded because the pattern is the point: **the bugs were all in the seam
between the plugin and its host**, which is the one place a unit test cannot
reach.

| Found | Why no test would have caught it |
|---|---|
| `setServerBasePath("")` served a blank page | The boot *decision* was right; what the plugin did with it was not. The app was dead on first launch. |
| Installed with no JavaScript in it | `dist/` was gitignored and npm did not run `prepare` for the git dependency. |
| Re-downloaded a bundle already on disk | The server keeps offering until the device reports it as current, which only happens after `notifyReady`. |
| `retry()` replayed a dead presigned URL | The object was restored on the server and the button still failed, forever. |
| **iOS `setServerBasePath` does not reload the webview** | Android's posts its own `loadUrl`; the iOS one only repoints the asset handler (`CapacitorBridge.swift:176`). Every launch-time swap hid it, because `load()` runs before the webview loads anything. |
| Plugin methods run off the main queue | A webview touched from the background queue does nothing and says nothing. |
| State still read `READY` after applying | A webview reload does not restart the process, so the native side outlives the web layer. |
| The check overtook the confirmation | The device reported itself as running nothing and was re-offered what it was running. |
| **A deferred update could not be accepted** | `SyncResult.deferred` was a manifest the app could display and nothing else: the `Updater` had no method to stage it. Every bundle over `auto_max_bytes` was a dead end, and no test noticed because the ceiling only bites on a real bundle's real size. |
| **Retry did nothing for a deferred bundle** | `retry()` re-checks rather than replaying, so the ceiling deferred the very bundle the user had just agreed to. Download state stayed FAILED and the button was inert however often it was pressed. Fixed by remembering the accepted bundle id - a flag would have auto-downloaded the NEXT large update too. |
| **A cancel hid the offer for the rest of the process** | The host gated its card on state `IDLE`, and only `notifyReady` returns the machine to IDLE. One tap on Stop and the user was never asked again until they force-quit. A host bug, but caused by the plugin having no state meaning "nothing in flight". |
| **Every launch crashed on Android 7 and 8** | `load()` read `PackageInfo.longVersionCode`, which exists only from API 28; the host's floor is 24. Below 28 it is a `NoSuchMethodError`, an Error that Capacitor's plugin loader (which catches `Exception`) lets out of `Bridge.<init>`. Lint reported it as `NewApi` and `abortOnError false` let the build pass anyway. Now read by SDK level, and lint fails the build on `NewApi`. |
| **Every bundle was recorded with no version** | `next()` was called with the id alone, and native filled the rest with "" and 0. The host's build details sheet showed a blank version for the bundle it was running, and `rollback()` reported going back to "". The mocks answered with whatever the test put in them. |
| **Stop was reported as the release failing** | A cancel rejected `download()`, and the SDK sent `FAILED`/`stage_failed`; the server quarantines an install's bundle after three of those, so three taps on Stop refused it for 30 days. The consent outlived the cancel while the offer did not: `accept()` threw "nothing deferred" and the next check downloaded the bundle the user had stopped. Now a cancel sends nothing, spends the consent and offers the manifest back, and the stopped bundle is deferred on later checks until accepted, whatever its size: a bundle under `auto_max_bytes` was otherwise downloaded again by the next resume check. A mandatory one still downloads. The quarantine rule lives on the server, where no plugin test looks. |
| **READY was sent on every launch** | `notifyReady()` reported the running bundle each time the app started, and the server keeps every event, so a device opened ten times a day counted ten times in the health gate's READY ratio. Now once per install per bundle: native keeps the last id the server accepted, written only after it did, so an offline launch still sends it later. Only a fleet makes the ratio visible. |
| **Rollback and reset reports were sent by a page already gone** | Native reloads the webview as `rollback()` and `reset()` resolve, and the SDK reported `FAILED`/`REVERTED` after they did - from a JavaScript context the reload was tearing down. Now sent first, waiting at most three seconds so a dead network cannot keep a broken bundle on screen. A mocked plugin does not reload anything. |
| **An oversized attribute switched updates off for good** | The server refuses the whole check with a 400 when `attrs` is over 4096 bytes or a string field is over its cap, and the SDK reads any failed check as offline. Nothing said so, and the next check was just as big. Now the strings are trimmed to their caps and oversized `attrs` dropped with a debug line; an event's `detail` is shortened to fit, measured as the server measures it, where a non-ASCII character is six bytes. Only the app's real data is that big. |

---

## 10 · Open points

- **~~Android is unverified end to end.~~** Done, 22 Sep 2026: an Android
  emulator took `1.0.0-android` over the deferred path - offered, accepted by
  tap, downloaded, verified, unpacked, applied - and reported itself running
  it on the next check. Both platforms are now proven against the live API.
- **~~`os_version` is sent empty.~~** Done: `identity()` carries `osVersion`
  beside `appVersion` - Android's `Build.VERSION.RELEASE`, iOS's
  `operatingSystemVersion` in `UIDevice.systemVersion`'s form (read from
  `ProcessInfo`, because UIDevice belongs to the main thread) - and the check
  sends it, capped at the server's 40 characters. A rule on OS version now
  matches devices that report one; a binary built before this still sends ''.
- **No resume.** A cancelled or dropped download restarts from zero. iOS gives
  resume data for free via `cancel(byProducingResumeData:)`; Android would need
  a `Range` header. Worth doing before large bundles ship over patchy links.
- **A bundle that confirms and only then crashes is not caught.** The watchdog
  proves the app reached first render, not that it works. `rollback()` exists
  for the app to call when it knows better; nothing detects it automatically.
- **Deltas.** The server builds them; this ignores them and takes the full
  bundle.
- **`tree_sha256` is stored but unused.** It is what a delta would be verified
  against. Keeping it from day one costs a field; retrofitting it means every
  device that updated before deltas shipped cannot use one until it takes a
  full bundle.

---

<sub>overair-capacitor. Verified: 12 Swift, 12 Kotlin and 65 TypeScript tests; end to end against a live server, an update applied on an iPhone 16 Pro simulator and (22 Sep 2026) an Android emulator - neither repeated since the 29 Sep fixes.</sub>
