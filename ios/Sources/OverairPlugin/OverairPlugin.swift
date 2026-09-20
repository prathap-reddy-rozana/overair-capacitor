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
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "quarantine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prune", returnType: CAPPluginReturnPromise),
    ]

    private let store = Store()
    private lazy var bundles = Bundles(root: Self.bundleRoot())

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
            bridge?.setServerBasePath("")
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
        ]
        result["current"] = store.active.map(describe) as Any
        result["next"] = store.next.map(describe) as Any
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
        let version = call.getString("version") ?? ""

        Task {
            do {
                let (directory, size) = try await bundles.install(id: id, url: url, expected: checksum)
                let record = BundleRecord(id: id, version: version, path: directory.path,
                                          checksum: checksum, size: size,
                                          nativeBuild: Self.nativeBuild())
                call.resolve(describe(record))
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
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
            store.active = staged
            store.next = nil
            bundles.prune(keep: [staged.id])
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

    @objc func reset(_ call: CAPPluginCall) {
        store.forgetBundles()
        bundles.removeAll()
        bridge?.setServerBasePath("")
        call.resolve()
    }

    @objc func prune(_ call: CAPPluginCall) {
        var keep = Set<String>()
        if let active = store.active { keep.insert(active.id) }
        if let next = store.next { keep.insert(next.id) }
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
