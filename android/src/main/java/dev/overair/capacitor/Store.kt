package dev.overair.capacitor

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A bundle this device holds on disk. */
data class BundleRecord(
    val id: String,
    val version: String,
    val path: String,
    val checksum: String,
    val size: Long,
    /** The native build it was unpacked for. */
    val nativeBuild: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("version", version).put("path", path)
        .put("checksum", checksum).put("size", size).put("nativeBuild", nativeBuild)

    companion object {
        fun from(json: JSONObject): BundleRecord = BundleRecord(
            id = json.getString("id"),
            version = json.optString("version"),
            path = json.getString("path"),
            checksum = json.optString("checksum"),
            size = json.optLong("size"),
            nativeBuild = json.optString("nativeBuild"),
        )
    }
}

/**
 * Plugin state, in native SharedPreferences.
 *
 * Native storage rather than anything the web layer can reach, and that is
 * the point: a bundle must not be able to edit the facts that decide whether
 * it is allowed to run.
 */
class Store(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("OverairState", Context.MODE_PRIVATE)

    /** Generated once and kept forever. Deliberately not a device identifier:
     *  a reinstall is a new install, which is the correct behaviour. */
    val installId: String
        get() {
            prefs.getString(INSTALL_ID, null)?.let { return it }
            val fresh = UUID.randomUUID().toString()
            prefs.edit().putString(INSTALL_ID, fresh).apply()
            return fresh
        }

    var storedBuild: String?
        get() = prefs.getString(NATIVE_BUILD, null)
        set(value) = prefs.edit().putString(NATIVE_BUILD, value).apply()

    var active: BundleRecord?
        get() = record(ACTIVE)
        set(value) = put(ACTIVE, value)

    var next: BundleRecord?
        get() = record(NEXT)
        set(value) = put(NEXT, value)

    /** Set when a bundle is handed to the webview, cleared by notifyReady().
     *  A launch that finds it still set knows the last one never came back. */
    var pending: Boolean
        get() = prefs.getBoolean(PENDING, false)
        set(value) = prefs.edit().putBoolean(PENDING, value).apply()

    /** Reported to the caller once, so the SDK can send a FAILED event for a
     *  rollback that happened before any JavaScript existed to notice it. */
    var rolledBackId: String?
        get() = prefs.getString(ROLLED_BACK, null)
        set(value) = prefs.edit().putString(ROLLED_BACK, value).apply()

    fun quarantined(): List<String> {
        val raw = prefs.getString(BAD, null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            (0 until array.length()).map { array.getString(it) }
        }.getOrDefault(emptyList())
    }

    fun quarantine(id: String) {
        val current = quarantined()
        if (current.contains(id)) return
        // Bounded: this list travels in every check request, and a device
        // that keeps failing must not grow its own payload without limit.
        val next = (current + id).takeLast(20)
        prefs.edit().putString(BAD, JSONArray(next).toString()).apply()
    }

    /** Forget every bundle. Used when a store update lands. */
    fun forgetBundles() {
        prefs.edit().remove(ACTIVE).remove(NEXT).putBoolean(PENDING, false).apply()
    }

    private fun record(key: String): BundleRecord? {
        val raw = prefs.getString(key, null) ?: return null
        // A corrupt record is the same as no record: the bundle it names is
        // unverifiable, so the safe reading is that we have nothing.
        return runCatching { BundleRecord.from(JSONObject(raw)) }.getOrNull()
    }

    private fun put(key: String, value: BundleRecord?) {
        val editor = prefs.edit()
        if (value == null) editor.remove(key) else editor.putString(key, value.toJson().toString())
        editor.apply()
    }

    private companion object {
        const val INSTALL_ID = "install_id"
        const val NATIVE_BUILD = "native_build"
        const val ACTIVE = "active"
        const val NEXT = "next"
        const val PENDING = "pending"
        const val BAD = "quarantined"
        const val ROLLED_BACK = "rolled_back"
    }
}
