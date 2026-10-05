import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Where the SDK keeps its state between launches. UserDefaults by default,
/// which goes with the app when it is deleted, as the install id should.
public protocol HushStorage: Sendable {
    func string(_ key: String) -> String?
    /// Stores the value, or removes it when nil.
    func set(_ value: String?, _ key: String)
}

struct DefaultsStorage: HushStorage, @unchecked Sendable {
    // UserDefaults is documented thread-safe; it is just not marked Sendable.
    let defaults: UserDefaults
    func string(_ key: String) -> String? { defaults.string(forKey: key) }
    func set(_ value: String?, _ key: String) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

/// How requests reach the server: URLSession, or a stand-in in tests.
public protocol HushTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct SessionTransport: HushTransport {
    let session: URLSession
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// What a batch says about where it came from, as the React Native SDK says it,
/// so an install looks the same on the dashboard whichever SDK sent it.
struct DeviceInfo: Sendable, Equatable {
    var version: String
    var build: String
    var platform: String
    var os: String
    var device: String
    var locale: String

    static func current() -> DeviceInfo {
        let info = Bundle.main.infoDictionary ?? [:]
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let osVersion = v.patchVersion > 0 ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)" : "\(v.majorVersion).\(v.minorVersion)"
        #if os(iOS)
        let platform = "ios"
        #elseif os(macOS)
        let platform = "macos"
        #else
        let platform = "apple"
        #endif
        return DeviceInfo(
            version: info["CFBundleShortVersionString"] as? String ?? "",
            build: info["CFBundleVersion"] as? String ?? "",
            platform: platform,
            os: "\(platform) \(osVersion)",
            device: modelIdentifier(),
            locale: Locale.preferredLanguages.first ?? Locale.current.identifier
        )
    }

    /// `iPhone15,2`, not a marketing name: what the other SDKs send.
    static func modelIdentifier() -> String {
        #if targetEnvironment(simulator)
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        #endif
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}

/// Where this build came from: the App Store or TestFlight (a sandbox
/// receipt), a development or ad hoc build (it carries its provisioning
/// profile), or the simulator. The same test as `@bavrk/hush-expo`.
public enum Distribution: String, Sendable {
    case appStore = "app_store"
    case testflight
    case development
    case simulator

    public static var current: Distribution {
        #if targetEnvironment(simulator)
        return .simulator
        #else
        if Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") != nil { return .development }
        if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" { return .testflight }
        return .appStore
        #endif
    }

    /// The channel it means on the dashboard, or nil for builds that should say so themselves.
    var channel: String? {
        switch self {
        case .appStore: "app_store"
        case .testflight: "testflight"
        case .development, .simulator: nil
        }
    }
}

/// The app coming to the foreground and leaving it. UIKit's notifications on
/// iOS; tests drive it by hand.
enum Lifecycle {
    case active, background
}

final class LifecycleObserver: @unchecked Sendable {
    // Written once in start(), on the main thread, before any notification can call it.
    private var tokens: [NSObjectProtocol] = []

    func start(_ handler: @escaping @Sendable (Lifecycle) -> Void) {
        #if canImport(UIKit) && !os(watchOS)
        let center = NotificationCenter.default
        // Leaving is the deadline, so an interruption (a call, Control Center) counts as leaving too.
        tokens.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in handler(.background) })
        tokens.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in handler(.active) })
        #endif
    }

    deinit {
        tokens.forEach(NotificationCenter.default.removeObserver)
    }
}

/// Background runway for the send as the app leaves, so it is not cut off by suspension.
enum BackgroundTask {
    static func run(_ work: @escaping @Sendable () async -> Void) {
        #if canImport(UIKit) && !os(watchOS)
        Task { @MainActor in
            var id = UIBackgroundTaskIdentifier.invalid
            id = UIApplication.shared.beginBackgroundTask(withName: "hush-flush") {
                UIApplication.shared.endBackgroundTask(id)
                id = .invalid
            }
            await work()
            if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
        }
        #else
        Task { await work() }
        #endif
    }
}
