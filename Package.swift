// swift-tools-version: 6.0
// The hush SDK for native Swift apps (swift/). At the root of the repository
// because that is where Swift Package Manager looks:
//   .package(url: "https://github.com/enso-works/hush", from: "0.1.0")
// Versions are the plain semver tags (0.1.0); the npm packages' tags carry a
// prefix (sdk-v2.4.0), so the two never collide. Nothing else here is Swift's.
import PackageDescription

let package = Package(
    name: "Hush",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "Hush", targets: ["Hush"])],
    targets: [
        // The privacy manifest Apple asks of SDKs that use UserDefaults.
        .target(name: "Hush", path: "swift/Sources/Hush", resources: [.copy("PrivacyInfo.xcprivacy")]),
        .testTarget(name: "HushTests", dependencies: ["Hush"], path: "swift/Tests/HushTests"),
    ]
)
