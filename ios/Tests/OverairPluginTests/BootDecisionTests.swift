import XCTest
@testable import OverairPlugin

/// The decision table from docs/DESIGN.md §2, row by row.
///
/// These are the tests that matter most in the package: every other failure
/// costs an update, and a failure here costs the app. The Kotlin twin in
/// `BootDecisionTest.kt` asserts the same rows - if the two ever disagree,
/// one platform is rolling back when the other is not.
final class BootDecisionTests: XCTestCase {

    private func record(_ id: String, build: String = "42") -> BundleRecord {
        BundleRecord(id: id, version: "1.0.0", path: "/tmp/\(id)",
                     checksum: "abc", size: 1, nativeBuild: build)
    }

    private func facts(stored: String? = "42", active: BundleRecord? = nil,
                       next: BundleRecord? = nil, pending: Bool = false) -> BootFacts {
        BootFacts(nativeBuild: "42", storedBuild: stored,
                  active: active, next: next, pending: pending)
    }

    /// Row 1 - a fresh install has nothing to run but the binary.
    func testNothingOnDiskRunsEmbedded() {
        let decision = Boot.decide(facts(stored: nil))
        XCTAssertEqual(decision.run, .embedded)
        XCTAssertEqual(decision.because, .noBundle)
        XCTAssertNil(decision.markBad)
        XCTAssertFalse(decision.forget)
    }

    /// Row 2 - a store update landed. Everything on disk was unpacked for a
    /// binary that no longer exists, so none of it may run.
    func testStoreUpdateForgetsEverything() {
        let decision = Boot.decide(
            facts(stored: "41", active: record("a"), next: record("b")))
        XCTAssertEqual(decision.run, .embedded)
        XCTAssertEqual(decision.because, .storeUpdate)
        XCTAssertTrue(decision.forget)
        // Nothing is blamed: neither bundle was given a chance on this binary.
        XCTAssertNil(decision.markBad)
    }

    /// A store update outranks a pending boot: the pending flag was written
    /// by the previous binary and says nothing about this one.
    func testStoreUpdateOutranksPending() {
        let decision = Boot.decide(
            facts(stored: "41", active: record("a"), next: record("b"), pending: true))
        XCTAssertEqual(decision.because, .storeUpdate)
        XCTAssertNil(decision.markBad)
    }

    /// Row 3 - a newly staged bundle gets exactly one launch to prove itself.
    func testStagedBundleRunsFirst() {
        let decision = Boot.decide(facts(active: record("a"), next: record("b")))
        XCTAssertEqual(decision.run, .bundle)
        XCTAssertEqual(decision.record?.id, "b")
        XCTAssertTrue(decision.isFirstBoot)
    }

    /// Row 4 - a confirmed bundle runs again without re-proving anything.
    func testConfirmedBundleRunsAgain() {
        let decision = Boot.decide(facts(active: record("a")))
        XCTAssertEqual(decision.run, .bundle)
        XCTAssertEqual(decision.record?.id, "a")
        XCTAssertFalse(decision.isFirstBoot)
    }

    /// Row 5 - the staged bundle was served and never confirmed. It is
    /// refused forever, and the last WORKING bundle takes over rather than
    /// the user losing every update they ever received.
    func testFailedStagedBootFallsBackToActive() {
        let decision = Boot.decide(
            facts(active: record("a"), next: record("b"), pending: true))
        XCTAssertEqual(decision.markBad, "b")
        XCTAssertEqual(decision.run, .bundle)
        XCTAssertEqual(decision.record?.id, "a")
        XCTAssertFalse(decision.isFirstBoot)
    }

    /// Row 5, with nothing to fall back to: all the way to the binary.
    func testFailedBootWithNoFallbackRunsEmbedded() {
        let decision = Boot.decide(facts(active: record("a"), pending: true))
        XCTAssertEqual(decision.markBad, "a")
        XCTAssertEqual(decision.run, .embedded)
        XCTAssertEqual(decision.because, .failedBoot)
    }

    /// The invariant that makes the whole design safe: no combination of
    /// facts can leave a bundle running that was never confirmed and has
    /// already had its one launch.
    func testAPendingBundleIsNeverServedTwice() {
        for active in [nil, record("a")] {
            for next in [nil, record("b")] {
                let decision = Boot.decide(facts(active: active, next: next, pending: true))
                if let bad = decision.markBad {
                    XCTAssertNotEqual(decision.record?.id, bad,
                                      "served \(bad) again after it failed to confirm")
                }
            }
        }
    }
}
