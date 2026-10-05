import Foundation
import Hush

/// The app's own anonymous usage and feedback, sent to bavrk's hush with the
/// Swift SDK. The only file that imports it: its Ticket and HushKit's would
/// collide. Nothing sent names a server, an app on it, or anything from it.
enum Telemetry {
    /// Whether this build has a key: a fork, or a build without one, sends nothing and hides the feedback screens.
    static var available: Bool { !key.isEmpty && !uiTesting }

    /// UI tests send nothing, except the one that tests feedback against a local server (`-with-telemetry`).
    private static var uiTesting: Bool {
        let args = ProcessInfo.processInfo.arguments
        return args.contains("-ui-testing") && !args.contains("-with-telemetry")
    }
    private static var key: String { Bundle.main.object(forInfoDictionaryKey: "HushKey") as? String ?? "" }

    static func start() {
        guard available else { return }
        Hush.configure(url: Bundle.main.object(forInfoDictionaryKey: "HushURL") as? String ?? "", key: key)
        Hush.start()
    }

    static func screen(_ name: String) { if available { Hush.screen(name) } }

    static func track(_ name: String, _ props: [String: String] = [:]) {
        guard available else { return }
        Hush.track(name, props.mapValues { .string($0) })
    }

    /// A pairing link opened the app: only campaign tags would be kept from it, and it has none, so this records the door, not the link.
    static func openedFromLink() { if available { Hush.entry(.link) } }
}

extension Telemetry {
    /// "Share anonymous usage", the user's switch.
    static var sharesUsage: Bool {
        get { !Hush.isOptedOut }
        set { newValue ? Hush.optIn() : Hush.optOut() }
    }

    /// "Delete my usage data": everything this install sent, and its feedback. True when done.
    static func forget() async -> Bool {
        if case .success = await Hush.forget() { return true }
        return false
    }
}
