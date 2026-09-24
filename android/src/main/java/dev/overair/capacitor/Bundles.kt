package dev.overair.capacitor

import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
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
    class Cancelled : IOException("cancelled")

    /** Reported as bytes arrive, and again at each phase change. */
    fun interface Progress {
        fun report(state: String, bytes: Long, total: Long)
    }

    fun dirFor(id: String): File = File(root, id)

    /**
     * Download, verify, unpack.
     *
     * The digest is checked before a single file is written, so a bundle
     * that does not match never touches a directory the webview might later
     * serve and a failed download cannot leave a half-applied tree behind.
     *
     * `cancelled` is polled rather than interrupting the thread: a half-torn
     * stream leaves a partial file that looks like a resumable download and
     * is not one.
     */
    fun install(
        id: String,
        url: String,
        expected: String,
        cancelled: () -> Boolean = { false },
        progress: Progress = Progress { _, _, _ -> },
    ): Pair<File, Long> {
        root.mkdirs()
        val archive = File(root, "$id.zip.part")
        val target = dirFor(id)

        try {
            val digest = download(url, archive, cancelled, progress)

            progress.report("VERIFYING", archive.length(), archive.length())
            if (!digest.equals(expected, ignoreCase = true)) {
                throw VerifyError("digest mismatch: expected $expected, got $digest")
            }
            if (cancelled()) throw Cancelled()

            progress.report("UNPACKING", archive.length(), archive.length())
            // A previous half-written attempt is rubbish, not a head start:
            // the tree must be exactly what the archive says.
            target.deleteRecursively()
            target.mkdirs()
            val size = unzip(archive, target, cancelled)
            // The web root is the top of the archive. A zipped www folder puts
            // index.html one level down and opens to "Webpage not available".
            if (!File(target, "index.html").isFile) {
                throw VerifyError("no index.html at the top of the bundle; zip the folder's contents, not the folder")
            }
            return target to size
        } catch (error: Throwable) {
            target.deleteRecursively()
            throw error
        } finally {
            archive.delete()
        }
    }

    /** Streams to disk and hashes in the same pass. Returns the hex digest. */
    private fun download(
        url: String,
        into: File,
        cancelled: () -> Boolean,
        progress: Progress,
    ): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 60_000
            instanceFollowRedirects = true
        }
        try {
            if (connection.responseCode !in 200..299) {
                throw IOException("download failed: HTTP ${connection.responseCode}")
            }
            // -1 when the server sends no length, which a presigned URL for a
            // streamed object legitimately may not.
            val total = connection.contentLengthLong.coerceAtLeast(0L)
            val md = MessageDigest.getInstance("SHA-256")
            var read = 0L
            // Ten a second at most: a progress bar cannot show more, and each
            // one crosses the bridge.
            var lastReport = 0L

            connection.inputStream.use { input ->
                into.outputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        if (cancelled()) throw Cancelled()
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        md.update(buffer, 0, count)
                        read += count
                        val now = System.currentTimeMillis()
                        if (now - lastReport >= 100) {
                            progress.report("DOWNLOADING", read, total)
                            lastReport = now
                        }
                    }
                }
            }
            progress.report("DOWNLOADING", read, total)
            return md.digest().joinToString("") { "%02x".format(it) }
        } catch (error: InterruptedIOException) {
            throw if (cancelled()) Cancelled() else error
        } finally {
            connection.disconnect()
        }
    }

    /** Returns the unpacked size in bytes. */
    private fun unzip(archive: File, target: File, cancelled: () -> Boolean): Long {
        var total = 0L
        ZipInputStream(archive.inputStream().buffered()).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                if (cancelled()) throw Cancelled()
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
