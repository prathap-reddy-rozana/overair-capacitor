import Capacitor
import Foundation
import UIKit

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
        CAPPluginMethod(name: "acknowledgeRollback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "identity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyNow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "quarantine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rollback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prune", returnType: CAPPluginReturnPromise),
    ]

    private let store = Store()
    // Not lazy: a lazy var first touched from two queues can make two, and a
    // cancel sent to one never reaches the download running in the other.
    private let bundles = Bundles(root: OverairPlugin.bundleRoot())

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
    /// Guards the six fields above: the download Task and URLSession's
    /// delegate queue write them, Capacitor's plugin queue reads them.
    private let lock = NSLock()

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    private static func bundleRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
        return base.appendingPathComponent("overair/bundles", isDirectory: true)
    }

    override public func load() {
        // Back from the background. Announced, not acted on: the SDK decides
        // whether a check is due. Not didBecomeActive, which a permission
        // alert closing also fires.
        NotificationCenter.default.addObserver(
            self, selector: #selector(enteredForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)

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
            // What is left, as the decision says: a failed active bundle's
            // predecessor is now the current one, so the next launch keeps it.
            store.active = decision.active
            store.next = decision.next
            store.previous = decision.previous
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
            "readyReportedId": store.readyReportedId as Any,
            "download": downloadStatus(),
        ]
        result["current"] = store.active.map(describe) as Any
        result["next"] = store.next.map(describe) as Any
        result["previous"] = store.previous.map(describe) as Any
        // Kept until acknowledged. Cleared here, the first reader - notifyReady,
        // which runs before sync - swallowed it and no rollback was ever reported.
        call.resolve(result)
    }

    @objc private func enteredForeground() {
        notifyListeners("resume", data: [:])
    }

    @objc func acknowledgeRollback(_ call: CAPPluginCall) {
        store.rolledBackId = nil
        call.resolve()
    }

    @objc func acknowledgeReady(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        store.readyReportedId = id
        call.resolve()
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
            "embeddedAt": getConfig().getString("embeddedAt", "") ?? "",
            "nativeBuild": Self.nativeBuild(),
            "appVersion": info?["CFBundleShortVersionString"] as? String ?? "",
            "osVersion": Self.osVersion(),
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
        let (last, lastFailure) = locked { (lastFailed, failure) }
        guard let previous = last else { return call.reject("nothing to retry") }
        if let lastFailure, lastFailure["retryable"] as? Bool == false {
            return call.reject("the last failure is not retryable: "
                               + (lastFailure["message"] as? String ?? ""))
        }
        start(previous, call)
    }

    private func start(_ pending: Pending, _ call: CAPPluginCall) {
        let started: Bool = locked {
            guard downloading == nil else { return false }
            downloading = pending
            failure = nil
            bytes = 0
            total = 0
            // Armed here, not in the Task: a cancel from now on is honoured
            // even before the request exists.
            bundles.begin()
            return true
        }
        guard started else { return call.reject("a download is already running") }
        emit(state: "DOWNLOADING", id: pending.id)

        Task {
            do {
                let (directory, size) = try await bundles.install(
                    id: pending.id, url: pending.url, expected: pending.checksum,
                    progress: { [weak self] phase, read, length in
                        guard let self else { return }
                        let changed: Bool = self.locked {
                            self.bytes = read
                            self.total = length
                            return phase != self.state
                        }
                        if changed {
                            self.emit(state: phase, id: pending.id)
                        } else {
                            self.emitProgress(pending.id)
                        }
                    }
                )
                let record = BundleRecord(id: pending.id, version: pending.version,
                                          path: directory.path, checksum: pending.checksum,
                                          size: size, nativeBuild: Self.nativeBuild())
                locked {
                    downloading = nil
                    lastFailed = nil
                }
                emit(state: "READY", id: pending.id)
                call.resolve(describe(record))
            } catch {
                let wasCancelled = (error as? Bundles.Failure).map(Self.isCancelled) ?? false
                locked {
                    downloading = nil
                    lastFailed = pending
                    failure = [
                        "id": pending.id,
                        "code": Self.code(for: error),
                        "message": error.localizedDescription,
                        // A digest mismatch or an unusable archive is deterministic:
                        // the same URL will produce the same bytes. Matches Android.
                        "retryable": !wasCancelled && !["digest", "unpack"].contains(Self.code(for: error)),
                    ]
                }
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
            case .unsafeEntry, .noEntryPoint: return "unpack"
            case .http: return "http"
            }
        }
        if (error as NSError).domain == NSURLErrorDomain { return "network" }
        return "unknown"
    }

    private func downloadStatus() -> [String: Any] {
        locked { statusFields() }
    }

    /// The caller holds the lock.
    private func statusFields() -> [String: Any] {
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
        let status: [String: Any] = locked {
            state = next
            return statusFields()
        }
        notifyListeners("downloadStateChanged", data: status)
        if next == "DOWNLOADING" { emitProgress(id) }
    }

    private func emitProgress(_ id: String) {
        let progress: [String: Any] = locked {
            ["id": id, "state": state, "bytes": bytes, "total": total, "fraction": fraction()]
        }
        notifyListeners("downloadProgress", data: progress)
    }

    /// Serve the staged bundle NOW, reloading the webview into it.
    ///
    /// The webview reload IS the restart: an iOS app cannot relaunch itself
    /// (calling exit reads as a crash and is rejected by review), and killing
    /// the process would drop the user on a home screen with no explanation.
    /// Reloading swaps the entire web layer in place, which is the part an
    /// over-the-air update actually replaces.
    ///
    /// `pending` is set exactly as on a launch-time swap, so a bundle that
    /// fails to start here is rolled back on the next launch by the same
    /// watchdog and needs no separate path.
    @objc func applyNow(_ call: CAPPluginCall) {
        guard let staged = store.next else { return call.reject("nothing staged to apply") }
        guard FileManager.default.fileExists(atPath: staged.path) else {
            return call.reject("staged bundle is missing on disk")
        }
        store.pending = true
        call.resolve()
        DispatchQueue.main.async { [weak self] in
            self?.serve(staged.path)
        }
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
        // The update has landed. Without this the state machine still reads
        // READY after the swap, and the app offers an update it just applied.
        let status: [String: Any] = locked {
            state = "IDLE"
            bytes = 0
            total = 0
            failure = nil
            return statusFields()
        }
        notifyListeners("downloadStateChanged", data: status)
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
        let target = store.active
        // A record staged before next() carried the version names itself by id.
        let name = target.map { $0.version.isEmpty ? $0.id : $0.version } ?? "embedded"
        call.resolve(["rolledBackTo": name])
        DispatchQueue.main.async { [weak self] in
            self?.serve(target?.path ?? Self.embeddedPath())
        }
    }

    @objc func reset(_ call: CAPPluginCall) {
        store.forgetBundles()
        bundles.removeAll()
        call.resolve()
        // Mid-session, the webview IS serving a bundle, so going back needs an
        // explicit path to the assets in the binary - "" would serve nothing.
        DispatchQueue.main.async { [weak self] in
            self?.serve(Self.embeddedPath())
        }
    }

    @objc func prune(_ call: CAPPluginCall) {
        var keep = Set<String>()
        if let active = store.active { keep.insert(active.id) }
        if let next = store.next { keep.insert(next.id) }
        if let previous = store.previous { keep.insert(previous.id) }
        bundles.prune(keep: keep)
        call.resolve()
    }

    /**
     * Point the webview at a directory and actually load it.
     *
     * iOS and Android differ here and the difference is silent. Android's
     * `setServerBasePath` posts a `loadUrl` of its own; the iOS one only
     * repoints the asset handler (CapacitorBridge.swift) and returns, so
     * without the reload the path changes and the page does not. Every
     * launch-time swap hid this, because `load()` runs before the webview has
     * loaded anything at all.
     *
     * Main thread only: Capacitor runs plugin methods off it, and a webview
     * touched from the background queue does nothing and says nothing.
     */
    private func serve(_ path: String) {
        guard !path.isEmpty else { return }
        bridge?.setServerBasePath(path)
        bridge?.webView?.reload()
    }

    /// The build compiled into the binary.
    private static func embeddedPath() -> String {
        Bundle.main.url(forResource: "public", withExtension: nil)?.path ?? ""
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

    /// What UIDevice.systemVersion says ("17.5.1", "18.0"), read from
    /// ProcessInfo because UIDevice belongs to the main thread and this does not.
    private static func osVersion() -> String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let base = "\(version.majorVersion).\(version.minorVersion)"
        return version.patchVersion > 0 ? "\(base).\(version.patchVersion)" : base
    }

    /// CFBundleVersion, not the marketing version: two builds ship the same
    /// version name all the time, and this has to change on every release.
    private static func nativeBuild() -> String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    }
}
