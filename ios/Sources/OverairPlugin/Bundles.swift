import CryptoKit
import Foundation
import ZIPFoundation

/// Bytes onto the device and into a directory the local server can host.
///
/// The archive streams to a temporary file and is hashed in chunks, so a
/// 60 MB bundle costs a buffer rather than 60 MB of heap. That, and being
/// able to run before the webview exists, is what native buys here.
///
/// Unzipping needs ZIPFoundation: iOS ships no public zip API. Foundation's
/// archive support writes zips (NSFileCoordinator `.forUploading`) but cannot
/// read one, and Apple Archive is a different container format.
public final class Bundles: NSObject {

    public enum Failure: LocalizedError {
        case http(Int)
        case digest(expected: String, got: String)
        case unsafeEntry(String)
        case cancelled

        public var errorDescription: String? {
            switch self {
            case .http(let code):
                return "download failed: HTTP \(code)"
            case .digest(let expected, let got):
                return "digest mismatch: expected \(expected), got \(got)"
            case .unsafeEntry(let name):
                return "refusing archive entry outside the bundle: \(name)"
            case .cancelled:
                return "cancelled"
            }
        }
    }

    /// Reported as bytes arrive, and again at each phase change.
    public typealias Progress = (_ state: String, _ bytes: Int64, _ total: Int64) -> Void

    private let root: URL
    private var session: URLSession!
    private var task: URLSessionDownloadTask?
    private var onProgress: Progress?
    private var completion: ((Result<URL, Error>) -> Void)?
    /// Serialises the delegate callbacks against cancel() and install().
    private let lock = NSLock()

    public init(root: URL) {
        self.root = root
        super.init()
        // A delegate session, not the async one-shot: `download(from:)` gives
        // no byte counts and no handle to cancel. Both are requirements, not
        // conveniences, for a 40 MB bundle on a phone.
        self.session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    public func directory(for id: String) -> URL {
        root.appendingPathComponent(id, isDirectory: true)
    }

    public var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return task != nil
    }

    /// Download, verify, unpack.
    ///
    /// The digest is checked before a single file is written, so a bundle
    /// that does not match never touches a directory the webview might later
    /// serve, and a failed download cannot leave a half-applied tree behind.
    public func install(id: String, url: URL, expected: String,
                        progress: @escaping Progress) async throws -> (URL, Int64) {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let temporary = try await fetch(url, progress: progress)
        defer { try? FileManager.default.removeItem(at: temporary) }

        progress("VERIFYING", 0, 0)
        let digest = try sha256(of: temporary)
        guard digest.caseInsensitiveCompare(expected) == .orderedSame else {
            throw Failure.digest(expected: expected, got: digest)
        }

        progress("UNPACKING", 0, 0)
        let target = directory(for: id)
        // A previous half-written attempt is rubbish, not a head start: the
        // tree must be exactly what the archive says.
        try? FileManager.default.removeItem(at: target)
        do {
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            try FileManager.default.unzipItem(at: temporary, to: target)
            try rejectEscapes(in: target)
            return (target, try size(of: target))
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
    }

    /// Wraps the delegate callbacks back into async/await. The file the
    /// delegate hands over is moved out of the system's temporary directory
    /// before this returns - it is deleted the moment the callback ends.
    private func fetch(_ url: URL, progress: @escaping Progress) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            onProgress = progress
            completion = { continuation.resume(with: $0) }
            let download = session.downloadTask(with: url)
            task = download
            lock.unlock()
            download.resume()
        }
    }

    /// Stop whatever is in flight. Safe when nothing is.
    public func cancel() {
        lock.lock()
        let running = task
        lock.unlock()
        running?.cancel()
    }

    /// Hashes in 1 MB chunks, so the archive never has to fit in memory.
    public func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// An archive is untrusted input even after its digest matches: the digest
    /// proves it is the bundle the server named, not that the bundle is sane.
    /// A symlink or a `..` entry could otherwise reach outside the directory.
    private func rejectEscapes(in directory: URL) throws {
        let base = directory.standardizedFileURL.path
        guard let walker = FileManager.default.enumerator(
            at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey]) else { return }
        for case let url as URL in walker {
            let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey])
            if values.isSymbolicLink == true {
                throw Failure.unsafeEntry(url.lastPathComponent)
            }
            if !url.standardizedFileURL.path.hasPrefix(base) {
                throw Failure.unsafeEntry(url.lastPathComponent)
            }
        }
    }

    private func size(of directory: URL) throws -> Int64 {
        var total: Int64 = 0
        guard let walker = FileManager.default.enumerator(
            at: directory, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: [.fileSizeKey])
            total += Int64(values?.fileSize ?? 0)
        }
        return total
    }

    /// Delete every bundle except the ones named. Keeping the previous one is
    /// not sentiment: it is what a failed boot falls back to.
    public func prune(keep: Set<String>) {
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: nil)) ?? []
        for entry in entries where !keep.contains(entry.lastPathComponent) {
            try? FileManager.default.removeItem(at: entry)
        }
    }

    public func removeAll() {
        try? FileManager.default.removeItem(at: root)
    }

    private func finish(_ result: Result<URL, Error>) {
        lock.lock()
        let callback = completion
        completion = nil
        task = nil
        onProgress = nil
        lock.unlock()
        callback?(result)
    }
}

extension Bundles: URLSessionDownloadDelegate {

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didWriteData bytesWritten: Int64,
                           totalBytesWritten: Int64,
                           totalBytesExpectedToWrite: Int64) {
        lock.lock()
        let report = onProgress
        lock.unlock()
        // NSURLSessionTransferSizeUnknown is -1; report 0 so "unknown" is a
        // single value everywhere rather than two.
        let total = max(totalBytesExpectedToWrite, 0)
        report?("DOWNLOADING", totalBytesWritten, total)
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didFinishDownloadingTo location: URL) {
        if let response = downloadTask.response as? HTTPURLResponse,
           !(200...299).contains(response.statusCode) {
            finish(.failure(Failure.http(response.statusCode)))
            return
        }
        // The delegate's file is deleted as soon as this returns, so it has
        // to be moved now rather than handed onward as-is.
        let kept = root.appendingPathComponent("download-\(UUID().uuidString).zip")
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: location, to: kept)
            finish(.success(kept))
        } catch {
            finish(.failure(error))
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           didCompleteWithError error: Error?) {
        guard let error else { return }
        let cancelled = (error as NSError).code == NSURLErrorCancelled
        finish(.failure(cancelled ? Failure.cancelled : error))
    }
}
