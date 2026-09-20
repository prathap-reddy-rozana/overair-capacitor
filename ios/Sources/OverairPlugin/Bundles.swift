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
public final class Bundles {

    public enum Failure: LocalizedError {
        case http(Int)
        case digest(expected: String, got: String)
        case unsafeEntry(String)

        public var errorDescription: String? {
            switch self {
            case .http(let code):
                return "download failed: HTTP \(code)"
            case .digest(let expected, let got):
                return "digest mismatch: expected \(expected), got \(got)"
            case .unsafeEntry(let name):
                return "refusing archive entry outside the bundle: \(name)"
            }
        }
    }

    private let root: URL
    private let session: URLSession

    public init(root: URL, session: URLSession = .shared) {
        self.root = root
        self.session = session
    }

    public func directory(for id: String) -> URL {
        root.appendingPathComponent(id, isDirectory: true)
    }

    /// Download, verify, unpack.
    ///
    /// The digest is checked before a single file is written, so a bundle
    /// that does not match never touches a directory the webview might later
    /// serve, and a failed download cannot leave a half-applied tree behind.
    public func install(id: String, url: URL, expected: String) async throws -> (URL, Int64) {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        // download(from:) streams to a temporary file; the bytes never sit in
        // memory in one piece.
        let (temporary, response) = try await session.download(from: url)
        defer { try? FileManager.default.removeItem(at: temporary) }

        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw Failure.http(http.statusCode)
        }

        let digest = try sha256(of: temporary)
        guard digest.caseInsensitiveCompare(expected) == .orderedSame else {
            throw Failure.digest(expected: expected, got: digest)
        }

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
}
