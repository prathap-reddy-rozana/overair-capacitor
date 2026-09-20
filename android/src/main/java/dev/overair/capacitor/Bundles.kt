package dev.overair.capacitor

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * Bytes onto the device and into a directory the local server can host.
 *
 * Everything here streams. The archive is hashed WHILE it downloads and
 * unzipped straight from disk, so a 60 MB bundle costs a buffer rather than
 * 60 MB of heap - which is the main thing native buys over doing this in the
 * webview.
 */
class Bundles(private val root: File) {

    class VerifyError(message: String) : IOException(message)

    fun dirFor(id: String): File = File(root, id)

    /**
     * Download, verify, unpack.
     *
     * The digest is checked before a single file is written, so a bundle
     * that does not match never touches a directory the webview might later
     * serve and a failed download cannot leave a half-applied tree behind.
     */
    fun install(id: String, url: String, expected: String): Pair<File, Long> {
        root.mkdirs()
        val archive = File(root, "$id.zip.part")
        val target = dirFor(id)

        try {
            val digest = download(url, archive)
            if (!digest.equals(expected, ignoreCase = true)) {
                throw VerifyError("digest mismatch: expected $expected, got $digest")
            }
            // A previous half-written attempt is rubbish, not a head start:
            // the tree must be exactly what the archive says.
            target.deleteRecursively()
            target.mkdirs()
            val size = unzip(archive, target)
            return target to size
        } catch (error: Throwable) {
            target.deleteRecursively()
            throw error
        } finally {
            archive.delete()
        }
    }

    /** Streams to disk and hashes in the same pass. Returns the hex digest. */
    private fun download(url: String, into: File): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 60_000
            instanceFollowRedirects = true
        }
        try {
            if (connection.responseCode !in 200..299) {
                throw IOException("download failed: HTTP ${connection.responseCode}")
            }
            val md = MessageDigest.getInstance("SHA-256")
            DigestInputStream(connection.inputStream, md).use { input ->
                into.outputStream().use { output -> input.copyTo(output, DEFAULT_BUFFER_SIZE) }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        } finally {
            connection.disconnect()
        }
    }

    /** Returns the unpacked size in bytes. */
    private fun unzip(archive: File, target: File): Long {
        var total = 0L
        ZipInputStream(archive.inputStream().buffered()).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                val destination = resolve(target, entry.name)
                if (entry.isDirectory) {
                    destination.mkdirs()
                } else {
                    destination.parentFile?.mkdirs()
                    destination.outputStream().use { out -> total += zip.copyTo(out) }
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
        return total
    }

    /**
     * An archive is untrusted input even after its digest matches: the digest
     * proves it is the bundle the server named, not that the bundle is sane.
     * An entry called `../../databases/app.db` would otherwise be written
     * exactly there - the Zip Slip vulnerability.
     */
    private fun resolve(target: File, name: String): File {
        val destination = File(target, name)
        val canonicalTarget = target.canonicalPath + File.separator
        if (!destination.canonicalPath.startsWith(canonicalTarget)) {
            throw VerifyError("refusing archive entry outside the bundle: $name")
        }
        return destination
    }

    /** Delete every bundle except the ones named. Keeping the previous one is
     *  not sentiment: it is what a failed boot falls back to. */
    fun prune(keep: Set<String>) {
        root.listFiles()?.forEach { entry ->
            if (entry.isDirectory && entry.name !in keep) entry.deleteRecursively()
        }
    }

    fun removeAll() {
        root.deleteRecursively()
    }
}
