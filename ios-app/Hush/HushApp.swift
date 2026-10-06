import HushKit
import SwiftUI

@main
struct HushApp: App {
    // The delegate holds the model: a notification's Reply or Close can wake
    // the app with no window, and still needs the servers and their tokens.
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate

    init() {
        Telemetry.start()
    }

    /// UI tests start from nothing every launch, and leave the Keychain alone.
    static func store() -> ServerStore {
        if ProcessInfo.processInfo.arguments.contains("-ui-testing") {
            // And from the default filters and orders, whatever the last run picked.
            if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
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
                .environment(delegate.model)
                .environment(delegate.push)
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
            @Bindable var model = model
            TabView(selection: $model.tab) {
                Tab("Overview", systemImage: "square.grid.2x2", value: .overview) {
                    NavigationStack {
                        OverviewView(server: server)
                    }
                }
                Tab("Feedback", systemImage: "bubble.left.and.bubble.right", value: .feedback) {
                    if let inbox = model.inbox { InboxView(server: server, inbox: inbox) }
                }
                .badge(model.inbox?.openTotal ?? 0)
                Tab("Settings", systemImage: "gearshape", value: .settings) {
                    NavigationStack {
                        ServersView()
                    }
                }
            }
            // The badge counts before the tab is first opened.
            .task(id: model.inbox.map(ObjectIdentifier.init)) { await model.inbox?.load() }
        } else {
            WelcomeView()
        }
    }
}
