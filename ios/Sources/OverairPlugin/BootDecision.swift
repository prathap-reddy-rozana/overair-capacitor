import Foundation

/// Which web root this launch should serve, and what to remember about the
/// last one.
///
/// Deliberately pure and free of UIKit, Capacitor and Foundation's file APIs:
/// the whole safety argument of this plugin lives here, so it is testable
/// without a simulator. The Kotlin twin in `BootDecision.kt` is the same
/// function; the two must be changed together.

public enum Run {
    case embedded
    case bundle
}

public enum Because {
    case noBundle
    case storeUpdate
    case failedBoot
    case confirmed
    case firstBoot
}

public struct BundleRecord: Codable, Equatable {
    public let id: String
    public let version: String
    public let path: String
    public let checksum: String
    public let size: Int64
    /// The native build it was unpacked for.
    public let nativeBuild: String

    public init(id: String, version: String, path: String,
                checksum: String, size: Int64, nativeBuild: String) {
        self.id = id
        self.version = version
        self.path = path
        self.checksum = checksum
        self.size = size
        self.nativeBuild = nativeBuild
    }
}

public struct BootFacts {
    public let nativeBuild: String
    public let storedBuild: String?
    /// The bundle the last launch confirmed.
    public let active: BundleRecord?
    /// Unpacked and waiting for its one chance to start.
    public let next: BundleRecord?
    /// The bundle that was active before the current one. Kept so a bundle
    /// that breaks does not cost the user every update they ever took.
    public let previous: BundleRecord?
    /// True when the previous launch served a bundle that never called
    /// `notifyReady()`.
    public let pending: Bool

    public init(nativeBuild: String, storedBuild: String?, active: BundleRecord?,
                next: BundleRecord?, previous: BundleRecord? = nil, pending: Bool) {
        self.nativeBuild = nativeBuild
        self.storedBuild = storedBuild
        self.active = active
        self.next = next
        self.previous = previous
        self.pending = pending
    }
}

public struct BootDecision {
    public let run: Run
    public let because: Because
    public let record: BundleRecord?
    /// Drop every bundle: they were unpacked for a binary that is gone.
    public let forget: Bool
    /// Refuse this bundle forever - it was given a launch and never returned.
    public let markBad: String?

    public var isFirstBoot: Bool { because == .firstBoot }
}

public enum Boot {

    public static func decide(_ facts: BootFacts) -> BootDecision {
        // A store update landed. Everything on disk was unpacked for the
        // previous binary, and serving it would be exactly the runtime
        // mismatch the platform exists to prevent.
        if let stored = facts.storedBuild, stored != facts.nativeBuild {
            return BootDecision(run: .embedded, because: .storeUpdate,
                                record: nil, forget: true, markBad: nil)
        }

        var active = facts.active
        var next = facts.next
        var markBad: String?

        // Pending means the previous launch served a bundle and it never
        // confirmed. No timer could catch this: the failure being defended
        // against is "no JavaScript ran at all", and a timer is JavaScript.
        if facts.pending {
            markBad = next?.id ?? active?.id
            next = nil
            // The bundle that failed WAS the active one, so step back to its
            // predecessor rather than throwing away every update this device
            // ever took. Embedded is the floor, not the first resort.
            if let bad = markBad, active?.id == bad { active = facts.previous }
        }

        // A bundle that has never started goes first. One launch is what it
        // gets to prove itself.
        if let staged = next {
            return BootDecision(run: .bundle, because: .firstBoot,
                                record: staged, forget: false, markBad: markBad)
        }

        // Falling back to the last CONFIRMED bundle rather than all the way
        // to embedded: it has already proved it starts, so the user keeps
        // their most recent working update instead of losing every one.
        if let current = active {
            return BootDecision(run: .bundle, because: .confirmed,
                                record: current, forget: false, markBad: markBad)
        }

        return BootDecision(run: .embedded,
                            because: markBad != nil ? .failedBoot : .noBundle,
                            record: nil, forget: false, markBad: markBad)
    }
}
