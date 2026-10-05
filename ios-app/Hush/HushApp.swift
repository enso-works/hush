import HushKit
import SwiftUI

@main
struct HushApp: App {
    @State private var model = AppModel(store: Self.store())

    /// UI tests start from nothing every launch, and leave the Keychain alone.
    private static func store() -> ServerStore {
        if ProcessInfo.processInfo.arguments.contains("-ui-testing") {
            let file = FileManager.default.temporaryDirectory.appending(component: "servers-\(UUID().uuidString).json")
            return ServerStore(file: file, secrets: MemorySecretStore())
        }
        do {
            return try ServerStore.standard()
        } catch {
            // No Application Support: the list lives for this launch only, the tokens in the Keychain still.
            log.fault("No Application Support directory: \(error, privacy: .public)")
            return ServerStore(file: FileManager.default.temporaryDirectory.appending(component: "servers.json"), secrets: KeychainStore())
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let server = model.current {
            TabView {
                Tab("Overview", systemImage: "square.grid.2x2") {
                    NavigationStack {
                        OverviewView(server: server)
                    }
                }
                Tab("Servers", systemImage: "server.rack") {
                    NavigationStack {
                        ServersView()
                    }
                }
            }
        } else {
            WelcomeView()
        }
    }
}
