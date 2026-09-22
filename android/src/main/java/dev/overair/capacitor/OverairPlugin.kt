package dev.overair.capacitor

import android.content.Context
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Over-the-air updates for Capacitor.
 *
 * The reason this is native rather than a TypeScript library: `load()` runs
 * while the Bridge is being built, BEFORE the webview is told to load
 * anything. That is the only place a bundle which cannot execute can be
 * rolled back - by the time any JavaScript could notice, the broken bundle
 * is already what is running.
 */
@CapacitorPlugin(name = "Overair")
class OverairPlugin : Plugin() {

    private lateinit var store: Store
    private lateinit var bundles: Bundles
    private val worker = Executors.newSingleThreadExecutor()

    /** The live download. Held natively so a web reload - which happens on
     *  every bundle swap - does not lose track of one already in flight. */
    private val cancelled = AtomicBoolean(false)
    private var downloading: DownloadOptions? = null
    private var lastFailed: DownloadOptions? = null
    private var state = "IDLE"
    private var bytes = 0L
    private var total = 0L
    private var failure: JSObject? = null

    private data class DownloadOptions(
        val id: String,
        val version: String,
        val url: String,
        val checksum: String,
    )

    override fun load() {
        val context: Context = context
        store = Store(context)
        bundles = Bundles(File(context.filesDir, "overair/bundles"))

        val decision = Boot.decide(
            BootFacts(
                nativeBuild = nativeBuild(),
                storedBuild = store.storedBuild,
                active = store.active,
                next = store.next,
                previous = store.previous,
                pending = store.pending,
            ),
        )

        decision.markBad?.let { id ->
            // It was handed a launch and never came back. Recorded so the
            // server stops offering it, and surfaced to the SDK so the
            // console learns about a failure no JavaScript was alive to see.
            store.quarantine(id)
            store.rolledBackId = id
            store.next = null
            if (store.active?.id == id) store.active = null
        }

        if (decision.forget) {
            store.forgetBundles()
            bundles.removeAll()
        }
        store.storedBuild = nativeBuild()

        when (decision.run) {
            Run.EMBEDDED -> {
                store.pending = false
                // Nothing to do. We never persist a base path, so a cold start
                // is ALREADY serving the assets in the binary. Setting it to ""
                // does not mean "use the built-in assets" - it points the local
                // server at nothing and the webview renders a blank page.
            }
            Run.BUNDLE -> {
                val record = decision.record!!
                if (!File(record.path).exists()) {
                    // The record outlived its files. Treat it as no bundle
                    // rather than handing the local server a dead path.
                    store.forgetBundles()
                    return
                }
                store.pending = decision.isFirstBoot
                bridge.setServerBasePath(record.path)
            }
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val result = JSObject()
            .put("current", store.active?.let(::describe) ?: JSObject.NULL)
            .put("next", store.next?.let(::describe) ?: JSObject.NULL)
            .put("previous", store.previous?.let(::describe) ?: JSObject.NULL)
            .put("quarantined", JSArray(store.quarantined()))
            .put("rolledBack", store.rolledBackId != null)
            .put("rolledBackId", store.rolledBackId ?: JSObject.NULL)
            .put("download", downloadStatus())
        // Reported once. A rollback is news exactly one time; after that it
        // is just the state the device is in.
        store.rolledBackId = null
        call.resolve(result)
    }

    @PluginMethod
    fun identity(call: PluginCall) {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        call.resolve(
            JSObject()
                .put("installId", store.installId)
                // From capacitor.config, which lives in the BINARY - not in
                // the web bundle an update replaces.
                .put("channel", config.getString("channel", "") ?: "")
                .put("runtime", config.getString("runtime", "") ?: "")
                .put("apiUrl", config.getString("apiUrl", "") ?: "")
                .put("apiKey", config.getString("apiKey", "") ?: "")
                .put("nativeBuild", nativeBuild())
                .put("appVersion", info.versionName ?: ""),
        )
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id is required")
        val url = call.getString("url") ?: return call.reject("url is required")
        val checksum = call.getString("checksum") ?: return call.reject("checksum is required")
        val version = call.getString("version") ?: ""
        start(DownloadOptions(id, version, url, checksum), call)
    }

    /**
     * Stop whatever is in flight.
     *
     * Resolves either way, so a cancel button never has to ask first. The
     * partial file is deleted by the installer: a half-written archive is
     * not a head start, it is rubbish that would fail its digest anyway.
     */
    @PluginMethod
    fun cancel(call: PluginCall) {
        cancelled.set(true)
        call.resolve()
    }

    /**
     * Try the last failed download again.
     *
     * Refused when the failure was not retryable - a digest mismatch means
     * the same URL produces the same wrong bytes, and retrying forever is
     * how a device burns a data plan on nothing.
     */
    @PluginMethod
    fun retry(call: PluginCall) {
        val previous = lastFailed ?: return call.reject("nothing to retry")
        if (failure?.optBoolean("retryable") == false) {
            return call.reject("the last failure is not retryable: " +
                (failure?.optString("message") ?: ""))
        }
        start(previous, call)
    }

    private fun start(options: DownloadOptions, call: PluginCall) {
        if (downloading != null) return call.reject("a download is already running")
        downloading = options
        cancelled.set(false)
        failure = null
        bytes = 0
        total = 0
        emitState("DOWNLOADING", options.id)

        // Off the main thread: this streams tens of megabytes and must never
        // be the reason the UI stops responding.
        worker.execute {
            try {
                val (dir, size) = bundles.install(
                    options.id, options.url, options.checksum,
                    cancelled = { cancelled.get() },
                    progress = { phase, read, length ->
                        bytes = read
                        total = length
                        if (phase != state) emitState(phase, options.id) else emitProgress(options.id)
                    },
                )
                val record = BundleRecord(
                    options.id, options.version, dir.absolutePath,
                    options.checksum, size, nativeBuild(),
                )
                downloading = null
                lastFailed = null
                emitState("READY", options.id)
                call.resolve(describe(record))
            } catch (error: Exception) {
                // Exception, not Throwable: an OutOfMemoryError is not a
                // failed download and must not be reported as one.
                downloading = null
                lastFailed = options
                val cancelledByUs = error is Bundles.Cancelled
                failure = JSObject()
                    .put("id", options.id)
                    .put("code", codeFor(error))
                    .put("message", error.message ?: "download failed")
                    // A digest mismatch is deterministic: the same URL will
                    // produce the same wrong bytes.
                    .put("retryable", !cancelledByUs && error !is Bundles.VerifyError)
                emitState(if (cancelledByUs) "CANCELLED" else "FAILED", options.id)
                call.reject(error.message ?: "download failed", error)
            }
        }
    }

    private fun codeFor(error: Exception): String = when {
        error is Bundles.Cancelled -> "cancelled"
        error is Bundles.VerifyError && error.message?.contains("digest") == true -> "digest"
        error is Bundles.VerifyError -> "unpack"
        error.message?.contains("HTTP") == true -> "http"
        error is java.io.IOException -> "network"
        else -> "unknown"
    }

    private fun downloadStatus(): JSObject = JSObject()
        .put("id", downloading?.id ?: lastFailed?.id ?: "")
        .put("state", state)
        .put("bytes", bytes)
        .put("total", total)
        .put("fraction", fraction())
        .put("failure", failure ?: JSObject.NULL)

    /** -1, not 0, when the length is unknown: a caller has to be able to tell
     *  "no progress yet" from "cannot know". */
    private fun fraction(): Double =
        if (total > 0) (bytes.toDouble() / total).coerceIn(0.0, 1.0) else -1.0

    private fun emitState(next: String, id: String) {
        state = next
        notifyListeners("downloadStateChanged", downloadStatus())
        if (next == "DOWNLOADING") emitProgress(id)
    }

    private fun emitProgress(id: String) {
        notifyListeners(
            "downloadProgress",
            JSObject().put("id", id).put("state", state)
                .put("bytes", bytes).put("total", total).put("fraction", fraction()),
        )
    }

    /**
     * Serve the staged bundle NOW, reloading the webview into it.
     *
     * The webview reload IS the restart: on iOS an app cannot relaunch itself
     * (calling exit reads as a crash and is rejected by review), and killing
     * the process would drop the user on a home screen with no explanation.
     * Reloading swaps the entire web layer in place, which is the part an
     * over-the-air update actually replaces.
     *
     * `pending` is set exactly as it is on a launch-time swap, so a bundle
     * that fails to start here is rolled back on the next launch by the same
     * watchdog and needs no separate path.
     */
    @PluginMethod
    fun applyNow(call: PluginCall) {
        val staged = store.next ?: return call.reject("nothing staged to apply")
        if (!File(staged.path).exists()) return call.reject("staged bundle is missing on disk")
        store.pending = true
        call.resolve()
        bridge.setServerBasePath(staged.path)
    }

    /** Make a downloaded bundle the one the next launch serves. */
    @PluginMethod
    fun next(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id is required")
        val dir = bundles.dirFor(id)
        if (!dir.exists()) return call.reject("no such bundle on disk: $id")
        store.next = BundleRecord(
            id = id,
            version = call.getString("version", "") ?: "",
            path = dir.absolutePath,
            checksum = call.getString("checksum", "") ?: "",
            size = call.getInt("size", 0)?.toLong() ?: 0L,
            nativeBuild = nativeBuild(),
        )
        call.resolve()
    }

    @PluginMethod
    fun notifyReady(call: PluginCall) {
        // The watchdog's one job. Until this lands, `pending` is true and the
        // next launch will roll the bundle back before the webview loads.
        store.next?.let { staged ->
            // The one being replaced becomes the fallback, and both are kept
            // on disk - a predecessor that has been deleted is not a fallback.
            store.previous = store.active
            store.active = staged
            store.next = null
            bundles.prune(setOfNotNull(staged.id, store.previous?.id))
        }
        store.pending = false
        call.resolve()
    }

    @PluginMethod
    fun quarantine(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id is required")
        store.quarantine(id)
        if (store.next?.id == id) store.next = null
        if (store.active?.id == id) store.active = null
        call.resolve()
    }

    /**
     * Step back one bundle, rather than all the way to the binary.
     *
     * For a failure the app itself detects - a screen that will not load,
     * an error it cannot recover from. The current bundle is refused forever
     * and its predecessor takes over on the next launch; with no predecessor
     * that is the embedded build.
     */
    @PluginMethod
    fun rollback(call: PluginCall) {
        val current = store.active
        if (current == null) return call.reject("nothing to roll back")
        store.quarantine(current.id)
        store.active = store.previous
        store.previous = null
        store.next = null
        store.pending = false
        val target = store.active
        if (target != null) bridge.setServerBasePath(target.path)
        else bridge.setServerAssetPath("public")
        call.resolve(JSObject().put("rolledBackTo", target?.version ?: "embedded"))
    }

    @PluginMethod
    fun reset(call: PluginCall) {
        store.forgetBundles()
        bundles.removeAll()
        // Mid-session, the webview IS serving a bundle, so going back needs an
        // explicit pointer at the assets in the binary - "" would serve nothing.
        bridge.setServerAssetPath("public")
        call.resolve()
    }

    @PluginMethod
    fun prune(call: PluginCall) {
        bundles.prune(setOfNotNull(store.active?.id, store.next?.id, store.previous?.id))
        call.resolve()
    }

    private fun describe(record: BundleRecord): JSObject = JSObject()
        .put("id", record.id)
        .put("version", record.version)
        .put("size", record.size)
        .put("checksum", record.checksum)
        .put(
            "status",
            when {
                store.active?.id == record.id -> "ACTIVE"
                store.next?.id == record.id -> "PENDING"
                else -> "DOWNLOADED"
            },
        )

    /** versionCode, not versionName: two builds ship the same version name
     *  all the time, and this has to change on every store release. */
    private fun nativeBuild(): String {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        return info.longVersionCode.toString()
    }
}
