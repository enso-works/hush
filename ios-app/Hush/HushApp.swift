import HushKit
import SwiftUI

@main
struct HushApp: App {
    @State private var model = AppModel(store: Self.store())

    init() {
        Telemetry.start()
    }

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
        @Bindable var model = model
        content
            .onOpenURL { url in
                if let link = PairingLink(url) {
                    Telemetry.openedFromLink()
                    model.pairing = link
                }
            }
            .sheet(isPresented: Binding(get: { model.pairing != nil }, set: { if !$0 { model.pairing = nil } })) {
                if let link = model.pairing { PairingSheet(link: link) }
            }
    }

    @ViewBuilder private var content: some View {
        if let server = model.current {
            TabView {
                Tab("Overview", systemImage: "square.grid.2x2") {
                    NavigationStack {
                        OverviewView(server: server)
                    }
                }
                Tab("Settings", systemImage: "gearshape") {
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
