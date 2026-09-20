package dev.overair.capacitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decision table from docs/DESIGN.md §2, row by row.
 *
 * These are the tests that matter most in the module: every other failure
 * costs an update, and a failure here costs the app. The Swift twin in
 * `BootDecisionTests.swift` asserts the same rows - if the two ever
 * disagree, one platform is rolling back when the other is not.
 */
class BootDecisionTest {

    private fun record(id: String, build: String = "42") =
        BundleRecord(id, "1.0.0", "/tmp/$id", "abc", 1, build)

    private fun facts(
        stored: String? = "42",
        active: BundleRecord? = null,
        next: BundleRecord? = null,
        pending: Boolean = false,
    ) = BootFacts("42", stored, active, next, pending)

    /** Row 1 - a fresh install has nothing to run but the binary. */
    @Test
    fun `nothing on disk runs embedded`() {
        val decision = Boot.decide(facts(stored = null))
        assertEquals(Run.EMBEDDED, decision.run)
        assertEquals(Because.NO_BUNDLE, decision.because)
        assertNull(decision.markBad)
        assertFalse(decision.forget)
    }

    /** Row 2 - a store update landed. Everything on disk was unpacked for a
     *  binary that no longer exists, so none of it may run. */
    @Test
    fun `store update forgets everything`() {
        val decision = Boot.decide(facts(stored = "41", active = record("a"), next = record("b")))
        assertEquals(Run.EMBEDDED, decision.run)
        assertEquals(Because.STORE_UPDATE, decision.because)
        assertTrue(decision.forget)
        // Nothing is blamed: neither bundle had a chance on this binary.
        assertNull(decision.markBad)
    }

    /** A store update outranks a pending boot: the pending flag was written
     *  by the previous binary and says nothing about this one. */
    @Test
    fun `store update outranks pending`() {
        val decision = Boot.decide(
            facts(stored = "41", active = record("a"), next = record("b"), pending = true),
        )
        assertEquals(Because.STORE_UPDATE, decision.because)
        assertNull(decision.markBad)
    }

    /** Row 3 - a newly staged bundle gets exactly one launch to prove itself. */
    @Test
    fun `staged bundle runs first`() {
        val decision = Boot.decide(facts(active = record("a"), next = record("b")))
        assertEquals(Run.BUNDLE, decision.run)
        assertEquals("b", decision.record?.id)
        assertTrue(decision.isFirstBoot)
    }

    /** Row 4 - a confirmed bundle runs again without re-proving anything. */
    @Test
    fun `confirmed bundle runs again`() {
        val decision = Boot.decide(facts(active = record("a")))
        assertEquals(Run.BUNDLE, decision.run)
        assertEquals("a", decision.record?.id)
        assertFalse(decision.isFirstBoot)
    }

    /** Row 5 - the staged bundle was served and never confirmed. It is
     *  refused forever, and the last WORKING bundle takes over rather than
     *  the user losing every update they ever received. */
    @Test
    fun `failed staged boot falls back to active`() {
        val decision = Boot.decide(facts(active = record("a"), next = record("b"), pending = true))
        assertEquals("b", decision.markBad)
        assertEquals(Run.BUNDLE, decision.run)
        assertEquals("a", decision.record?.id)
        assertFalse(decision.isFirstBoot)
    }

    /** Row 5, with nothing to fall back to: all the way to the binary. */
    @Test
    fun `failed boot with no fallback runs embedded`() {
        val decision = Boot.decide(facts(active = record("a"), pending = true))
        assertEquals("a", decision.markBad)
        assertEquals(Run.EMBEDDED, decision.run)
        assertEquals(Because.FAILED_BOOT, decision.because)
    }

    /** The invariant that makes the whole design safe: no combination of
     *  facts can leave a bundle running that was never confirmed and has
     *  already had its one launch. */
    @Test
    fun `a pending bundle is never served twice`() {
        for (active in listOf(null, record("a"))) {
            for (next in listOf(null, record("b"))) {
                val decision = Boot.decide(facts(active = active, next = next, pending = true))
                decision.markBad?.let { bad ->
                    assertNotEquals("served $bad again after it failed to confirm",
                        bad, decision.record?.id)
                }
            }
        }
    }
}
