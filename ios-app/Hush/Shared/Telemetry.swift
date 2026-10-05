import Foundation
import Hush

/// The app's own anonymous usage and feedback, sent to bavrk's hush with the
/// Swift SDK. The only file that imports it: its Ticket and HushKit's would
/// collide. Nothing sent names a server, an app on it, or anything from it.
enum Telemetry {
    /// Whether this build has a key: a fork, or a build without one, sends nothing and hides the feedback screens.
    static var available: Bool { !key.isEmpty && !uiTesting }

    private static var uiTesting: Bool { ProcessInfo.processInfo.arguments.contains("-ui-testing") }
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
