import Foundation

/// Plugin state, in UserDefaults under its own suite.
///
/// Native storage rather than anything the web layer can reach, and that is
/// the point: a bundle must not be able to edit the facts that decide whether
/// it is allowed to run.
public final class Store {

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private enum Key {
        static let installId = "overair.install_id"
        static let nativeBuild = "overair.native_build"
        static let active = "overair.active"
        static let next = "overair.next"
        static let previous = "overair.previous"
        static let pending = "overair.pending"
        static let bad = "overair.quarantined"
        static let rolledBack = "overair.rolled_back"
    }

    /// Generated once and kept forever. Deliberately not a device identifier:
    /// a reinstall is a new install, which is the correct behaviour.
    public var installId: String {
        if let existing = defaults.string(forKey: Key.installId) { return existing }
        let fresh = UUID().uuidString.lowercased()
        defaults.set(fresh, forKey: Key.installId)
        return fresh
    }

    public var storedBuild: String? {
        get { defaults.string(forKey: Key.nativeBuild) }
        set { defaults.set(newValue, forKey: Key.nativeBuild) }
    }

    public var active: BundleRecord? {
        get { record(Key.active) }
        set { put(newValue, at: Key.active) }
    }

    public var next: BundleRecord? {
        get { record(Key.next) }
        set { put(newValue, at: Key.next) }
    }

    /// What was active before the current one. A bundle that breaks costs the
    /// user one update, not every update they ever took.
    public var previous: BundleRecord? {
        get { record(Key.previous) }
        set { put(newValue, at: Key.previous) }
    }

    /// Set when a bundle is handed to the webview, cleared by `notifyReady()`.
    /// A launch that finds it still set knows the last one never came back.
    public var pending: Bool {
        get { defaults.bool(forKey: Key.pending) }
        set { defaults.set(newValue, forKey: Key.pending) }
    }

    /// Surfaced to the SDK once, so the console learns about a rollback that
    /// happened before any JavaScript existed to notice it.
    public var rolledBackId: String? {
        get { defaults.string(forKey: Key.rolledBack) }
        set { defaults.set(newValue, forKey: Key.rolledBack) }
    }

    public var quarantined: [String] {
        defaults.stringArray(forKey: Key.bad) ?? []
    }

    public func quarantine(_ id: String) {
        var current = quarantined
        guard !current.contains(id) else { return }
        current.append(id)
        // Bounded: this list travels in every check request, and a device
        // that keeps failing must not grow its own payload without limit.
        defaults.set(Array(current.suffix(20)), forKey: Key.bad)
    }

    /// Forget every bundle. Used when a store update lands.
    public func forgetBundles() {
        defaults.removeObject(forKey: Key.active)
        defaults.removeObject(forKey: Key.next)
        defaults.removeObject(forKey: Key.previous)
        defaults.set(false, forKey: Key.pending)
    }

    private func record(_ key: String) -> BundleRecord? {
        guard let data = defaults.data(forKey: key) else { return nil }
        // A corrupt record is the same as no record: the bundle it names is
        // unverifiable, so the safe reading is that we have nothing.
        return try? JSONDecoder().decode(BundleRecord.self, from: data)
    }

    private func put(_ value: BundleRecord?, at key: String) {
        guard let value, let data = try? JSONEncoder().encode(value) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }
}
