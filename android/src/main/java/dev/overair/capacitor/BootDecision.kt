package dev.overair.capacitor

/**
 * Which web root this launch should serve, and what to remember about the
 * last one.
 *
 * Deliberately a pure function over plain data: the whole safety argument of
 * this plugin lives here, so it is unit-testable without a device, an
 * Activity or a Bridge. Nothing in this file touches Android.
 */

enum class Run { EMBEDDED, BUNDLE }

enum class Because { NO_BUNDLE, STORE_UPDATE, FAILED_BOOT, CONFIRMED, FIRST_BOOT }

data class BootFacts(
    val nativeBuild: String,
    val storedBuild: String?,
    /** The bundle the last launch confirmed. */
    val active: BundleRecord?,
    /** Unpacked and waiting for its one chance to start. */
    val next: BundleRecord?,
    /** The bundle that was active before the current one. Kept so a bundle
     *  that breaks does not cost the user every update they ever took. */
    val previous: BundleRecord?,
    /** True when the previous launch handed over a bundle that never
     *  called notifyReady(). */
    val pending: Boolean,
)

data class BootDecision(
    val run: Run,
    val because: Because,
    val record: BundleRecord?,
    /** Drop every bundle: they were unpacked for a binary that is gone. */
    val forget: Boolean,
    /** Refuse this bundle forever - it was given a launch and never came back. */
    val markBad: String?,
) {
    val isFirstBoot: Boolean get() = because == Because.FIRST_BOOT
}

object Boot {

    fun decide(facts: BootFacts): BootDecision {
        // A store update landed. Everything on disk was unpacked for the
        // previous binary, and serving it would be exactly the runtime
        // mismatch the platform exists to prevent.
        if (facts.storedBuild != null && facts.storedBuild != facts.nativeBuild) {
            return BootDecision(Run.EMBEDDED, Because.STORE_UPDATE, null, forget = true, markBad = null)
        }

        var active = facts.active
        var next = facts.next
        var markBad: String? = null

        // Pending means the previous launch served a bundle and that bundle
        // never confirmed. No timer could catch this: the failure being
        // defended against is "no JavaScript ran at all", and a timer is
        // JavaScript.
        if (facts.pending) {
            markBad = next?.id ?: active?.id
            next = null
            // The bundle that failed WAS the active one, so step back to its
            // predecessor rather than throwing away every update this device
            // ever took. Embedded is the floor, not the first resort.
            if (markBad != null && active?.id == markBad) active = facts.previous
        }

        // A bundle that has never started goes first. One launch is what it
        // gets to prove itself.
        next?.let {
            return BootDecision(Run.BUNDLE, Because.FIRST_BOOT, it, forget = false, markBad = markBad)
        }

        // Falling back to the last CONFIRMED bundle rather than all the way
        // to embedded: it has already proved it starts, so the user keeps
        // their most recent working update instead of losing every one.
        active?.let {
            return BootDecision(Run.BUNDLE, Because.CONFIRMED, it, forget = false, markBad = markBad)
        }

        return BootDecision(
            Run.EMBEDDED,
            if (markBad != null) Because.FAILED_BOOT else Because.NO_BUNDLE,
            null,
            forget = false,
            markBad = markBad,
        )
    }
}
