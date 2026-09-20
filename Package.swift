// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OverairCapacitor",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "OverairCapacitor",
            targets: ["OverairPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // iOS ships no public API for READING a zip: Foundation can write one
        // (NSFileCoordinator .forUploading) but not expand one, and Apple
        // Archive is a different container format.
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.19")
    ],
    targets: [
        .target(
            name: "OverairPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "ZIPFoundation", package: "ZIPFoundation")
            ],
            path: "ios/Sources/OverairPlugin"),
        .testTarget(
            name: "OverairPluginTests",
            dependencies: ["OverairPlugin"],
            path: "ios/Tests/OverairPluginTests")
    ]
)
