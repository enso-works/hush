// swift-tools-version: 5.9
import PackageDescription

// The package and product are named BavrkHushCapacitor because `npx cap sync`
// derives that name from "@bavrk/hush-capacitor" and refers to it so in the
// app's CapApp-SPM/Package.swift.
let package = Package(
    name: "BavrkHushCapacitor",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "BavrkHushCapacitor",
            targets: ["HushCapacitorPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "HushCapacitorPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/HushCapacitorPlugin")
    ]
)
