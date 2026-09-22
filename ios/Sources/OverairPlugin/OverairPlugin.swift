import Capacitor
import Foundation

/// Over-the-air updates for Capacitor.
///
/// The reason this is native rather than a TypeScript library: `load()` runs
/// while the bridge is being built, before the webview is told to load
/// anything. That is the only place a bundle which cannot execute can be
/// rolled back - by the time any JavaScript could notice, the broken bundle
/// is already what is running.
@objc(OverairPlugin)
public class OverairPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "OverairPlugin"
    public let jsName = "Overair"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "identity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "quarantine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rollback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prune", returnType: CAPPluginReturnPromise),
    ]

    private let store = Store()
    private lazy var bundles = Bundles(root: Self.bundleRoot())

    /// The live download. Held natively so a web reload - which happens on
    /// every bundle swap - does not lose track of one already in flight.
    private struct Pending {
        let id: String
        let version: String
        let url: URL
        let checksum: String
    }
    private var downloading: Pending?
    private var lastFailed: Pending?
    private var state = "IDLE"
    private var bytes: Int64 = 0
    private var total: Int64 = 0
    private var failure: [String: Any]?

    private static func bundleRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
        return base.appendingPathComponent("overair/bundles", isDirectory: true)
    }

    override public func load() {
        let decision = Boot.decide(
            BootFacts(
                nativeBuild: Self.nativeBuild(),
                storedBuild: store.storedBuild,
                active: store.active,
                next: store.next,
                previous: store.previous,
                pending: store.pending
            )
        )

        if let bad = decision.markBad {
            // It was handed a launch and never came back. Recorded so the
            // server stops offering it, and surfaced to the SDK so the
            // console learns about a failure no JavaScript was alive to see.
            store.quarantine(bad)
            store.rolledBackId = bad
            store.next = nil
            if store.active?.id == bad { store.active = nil }
        }

        if decision.forget {
            store.forgetBundles()
            bundles.removeAll()
        }
        store.storedBuild = Self.nativeBuild()

        switch decision.run {
        case .embedded:
            store.pending = false
            // Nothing to do. We never persist a base path, so a cold start is
            // ALREADY serving the assets in the binary. Setting it to "" here
            // does not mean "use the built-in assets" - it points the local
            // server at nothing and the webview renders a blank page.
        case .bundle:
            guard let record = decision.record,
                  FileManager.default.fileExists(atPath: record.path) else {
                // The record outlived its files. Treat it as no bundle rather
                // than handing the local server a dead path.
                store.forgetBundles()
                return
            }
            store.pending = decision.isFirstBoot
            bridge?.setServerBasePath(record.path)
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        var result: [String: Any] = [
            "quarantined": store.quarantined,
            "rolledBack": store.rolledBackId != nil,
            "rolledBackId": store.rolledBackId as Any,
            "download": downloadStatus(),
        ]
        result["current"] = store.active.map(describe) as Any
        result["next"] = store.next.map(describe) as Any
        result["previous"] = store.previous.map(describe) as Any
        // Reported once. A rollback is news exactly one time; after that it
        // is just the state the device is in.
        store.rolledBackId = nil
        call.resolve(result)
    }

    @objc func identity(_ call: CAPPluginCall) {
        let info = Bundle.main.infoDictionary
        call.resolve([
            "installId": store.installId,
            // From capacitor.config, which lives in the BINARY - not in the
            // web bundle an update replaces.
            "channel": getConfig().getString("channel", "") ?? "",
            "runtime": getConfig().getString("runtime", "") ?? "",
            "apiUrl": getConfig().getString("apiUrl", "") ?? "",
            "apiKey": getConfig().getString("apiKey", "") ?? "",
            "nativeBuild": Self.nativeBuild(),
            "appVersion": info?["CFBundleShortVersionString"] as? String ?? "",
        ])
    }

    @objc func download(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            return call.reject("url is required")
        }
        guard let checksum = call.getString("checksum") else {
            return call.reject("checksum is required")
        }
        start(Pending(id: id, version: call.getString("version") ?? "",
                      url: url, checksum: checksum), call)
    }

    /// Stop whatever is in flight.
    ///
    /// Resolves either way, so a cancel button never has to ask first. The
    /// partial file is discarded: a half-written archive is not a head start,
    /// it is rubbish that would fail its digest anyway.
    @objc func cancel(_ call: CAPPluginCall) {
        bundles.cancel()
        call.resolve()
    }

    /// Try the last failed download again.
    ///
    /// Refused when the failure was not retryable - a digest mismatch means
    /// the same URL produces the same wrong bytes, and retrying forever is
    /// how a device burns a data plan on nothing.
    @objc func retry(_ call: CAPPluginCall) {
        guard let previous = lastFailed else { return call.reject("nothing to retry") }
        if let failure, failure["retryable"] as? Bool == false {
            return call.reject("the last failure is not retryable: "
                               + (failure["message"] as? String ?? ""))
        }
        start(previous, call)
    }

    private func start(_ pending: Pending, _ call: CAPPluginCall) {
        guard downloading == nil else { return call.reject("a download is already running") }
        downloading = pending
        failure = nil
        bytes = 0
        total = 0
        emit(state: "DOWNLOADING", id: pending.id)

        Task {
            do {
                let (directory, size) = try await bundles.install(
                    id: pending.id, url: pending.url, expected: pending.checksum,
                    progress: { [weak self] phase, read, length in
                        guard let self else { return }
                        self.bytes = read
                        self.total = length
                        if phase != self.state {
                            self.emit(state: phase, id: pending.id)
                        } else {
                            self.emitProgress(pending.id)
                        }
                    }
                )
                let record = BundleRecord(id: pending.id, version: pending.version,
                                          path: directory.path, checksum: pending.checksum,
                                          size: size, nativeBuild: Self.nativeBuild())
                downloading = nil
                lastFailed = nil
                emit(state: "READY", id: pending.id)
                call.resolve(describe(record))
            } catch {
                downloading = nil
                lastFailed = pending
                let wasCancelled = (error as? Bundles.Failure).map(Self.isCancelled) ?? false
                failure = [
                    "id": pending.id,
                    "code": Self.code(for: error),
                    "message": error.localizedDescription,
                    // A digest mismatch is deterministic: the same URL will
                    // produce the same wrong bytes.
                    "retryable": !wasCancelled && Self.code(for: error) != "digest",
                ]
                emit(state: wasCancelled ? "CANCELLED" : "FAILED", id: pending.id)
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    private static func isCancelled(_ failure: Bundles.Failure) -> Bool {
        if case .cancelled = failure { return true }
        return false
    }

    private static func code(for error: Error) -> String {
        if let failure = error as? Bundles.Failure {
            switch failure {
            case .cancelled: return "cancelled"
            case .digest: return "digest"
            case .unsafeEntry: return "unpack"
            case .http: return "http"
            }
        }
        if (error as NSError).domain == NSURLErrorDomain { return "network" }
        return "unknown"
    }

    private func downloadStatus() -> [String: Any] {
        [
            "id": downloading?.id ?? lastFailed?.id ?? "",
            "state": state,
            "bytes": bytes,
            "total": total,
            "fraction": fraction(),
            "failure": failure as Any,
        ]
    }

    /// -1, not 0, when the length is unknown: a caller has to be able to tell
    /// "no progress yet" from "cannot know".
    private func fraction() -> Double {
        total > 0 ? min(max(Double(bytes) / Double(total), 0), 1) : -1
    }

    private func emit(state next: String, id: String) {
        state = next
        notifyListeners("downloadStateChanged", data: downloadStatus())
        if next == "DOWNLOADING" { emitProgress(id) }
    }

    private func emitProgress(_ id: String) {
        notifyListeners("downloadProgress", data: [
            "id": id, "state": state, "bytes": bytes,
            "total": total, "fraction": fraction(),
        ])
    }

    /// Make a downloaded bundle the one the next launch serves.
    @objc func next(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        let directory = bundles.directory(for: id)
        guard FileManager.default.fileExists(atPath: directory.path) else {
            return call.reject("no such bundle on disk: \(id)")
        }
        store.next = BundleRecord(
            id: id,
            version: call.getString("version") ?? "",
            path: directory.path,
            checksum: call.getString("checksum") ?? "",
            size: Int64(call.getInt("size") ?? 0),
            nativeBuild: Self.nativeBuild()
        )
        call.resolve()
    }

    @objc func notifyReady(_ call: CAPPluginCall) {
        // The watchdog's one job. Until this lands, `pending` is true and the
        // next launch rolls the bundle back before the webview loads.
        if let staged = store.next {
            // The one being replaced becomes the fallback, and both are kept
            // on disk - a predecessor that has been deleted is not a fallback.
            store.previous = store.active
            store.active = staged
            store.next = nil
            bundles.prune(keep: Set([staged.id, store.previous?.id].compactMap { $0 }))
        }
        store.pending = false
        call.resolve()
    }

    @objc func quarantine(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        store.quarantine(id)
        if store.next?.id == id { store.next = nil }
        if store.active?.id == id { store.active = nil }
        call.resolve()
    }

    /// Step back one bundle, rather than all the way to the binary.
    ///
    /// For a failure the app itself detects - a screen that will not load, an
    /// error it cannot recover from. The current bundle is refused forever and
    /// its predecessor takes over; with no predecessor that is the embedded
    /// build.
    @objc func rollback(_ call: CAPPluginCall) {
        guard let current = store.active else { return call.reject("nothing to roll back") }
        store.quarantine(current.id)
        store.active = store.previous
        store.previous = nil
        store.next = nil
        store.pending = false
        if let target = store.active {
            bridge?.setServerBasePath(target.path)
            call.resolve(["rolledBackTo": target.version])
        } else {
            if let embedded = Bundle.main.url(forResource: "public", withExtension: nil) {
                bridge?.setServerBasePath(embedded.path)
            }
            call.resolve(["rolledBackTo": "embedded"])
        }
    }

    @objc func reset(_ call: CAPPluginCall) {
        store.forgetBundles()
        bundles.removeAll()
        // Mid-session, the webview IS serving a bundle, so going back needs an
        // explicit path to the assets in the binary - "" would serve nothing.
        if let embedded = Bundle.main.url(forResource: "public", withExtension: nil) {
            bridge?.setServerBasePath(embedded.path)
        }
        call.resolve()
    }

    @objc func prune(_ call: CAPPluginCall) {
        var keep = Set<String>()
        if let active = store.active { keep.insert(active.id) }
        if let next = store.next { keep.insert(next.id) }
        if let previous = store.previous { keep.insert(previous.id) }
        bundles.prune(keep: keep)
        call.resolve()
    }

    private func describe(_ record: BundleRecord) -> [String: Any] {
        let status: String
        if store.active?.id == record.id {
            status = "ACTIVE"
        } else if store.next?.id == record.id {
            status = "PENDING"
        } else {
            status = "DOWNLOADED"
        }
        return [
            "id": record.id,
            "version": record.version,
            "size": record.size,
            "checksum": record.checksum,
            "status": status,
        ]
    }

    /// CFBundleVersion, not the marketing version: two builds ship the same
    /// version name all the time, and this has to change on every release.
    private static func nativeBuild() -> String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    }
}
