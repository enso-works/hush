// swift-tools-version: 6.0
// HushKit: the iOS app's talk with a hush server's /admin API, its models and
// (later) push decryption. A package of its own so `swift test` covers it on
// a Mac, without a simulator.
import PackageDescription

let package = Package(
    name: "HushKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "HushKit", targets: ["HushKit"])],
    targets: [
        .target(name: "HushKit"),
        .testTarget(name: "HushKitTests", dependencies: ["HushKit"], resources: [.copy("Fixtures")]),
    ]
)
