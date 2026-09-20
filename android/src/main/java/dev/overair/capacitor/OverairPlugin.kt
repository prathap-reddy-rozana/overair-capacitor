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
                // Clears Capacitor's own persisted path as well, so the next
                // cold start does not restore the bundle we just rejected.
                if (bridge.serverBasePath.isNotEmpty()) bridge.setServerBasePath("")
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
            .put("quarantined", JSArray(store.quarantined()))
            .put("rolledBack", store.rolledBackId != null)
            .put("rolledBackId", store.rolledBackId ?: JSObject.NULL)
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

        // Off the main thread: this streams tens of megabytes and must never
        // be the reason the UI stops responding.
        worker.execute {
            try {
                val (dir, size) = bundles.install(id, url, checksum)
                val record = BundleRecord(id, version, dir.absolutePath, checksum, size, nativeBuild())
                call.resolve(describe(record))
            } catch (error: Exception) {
                // Exception, not Throwable: an OutOfMemoryError is not a
                // failed download and must not be reported as one.
                call.reject(error.message ?: "download failed", error)
            }
        }
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
            store.active = staged
            store.next = null
            bundles.prune(setOf(staged.id))
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

    @PluginMethod
    fun reset(call: PluginCall) {
        store.forgetBundles()
        bundles.removeAll()
        bridge.setServerBasePath("")
        call.resolve()
    }

    @PluginMethod
    fun prune(call: PluginCall) {
        bundles.prune(setOfNotNull(store.active?.id, store.next?.id))
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
