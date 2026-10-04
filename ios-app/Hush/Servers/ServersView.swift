import HushKit
import SwiftUI

/// The servers the app knows: open one, edit, remove, add.
struct ServersView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var editing: Server?

    var body: some View {
        List {
            Section {
                ForEach(model.servers) { server in
                    Button {
                        model.select(server)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(server.name).foregroundStyle(.primary)
                                Text(server.baseURL.absoluteString).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if server.id == model.current?.id {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                    }
                    .swipeActions {
                        Button("Remove", role: .destructive) { model.remove(server) }
                        if !server.isDemo {
                            Button("Edit") { editing = server }
                        }
                    }
                }
            } footer: {
                Text("Tokens stay in this device's Keychain. Removing a server forgets its token.")
            }
            Section {
                Button("Add server", systemImage: "plus") { adding = true }
                if !model.servers.contains(where: \.isDemo) {
                    Button("Add the demo", systemImage: "sparkles") { model.addDemo() }
                }
            }
        }
        .navigationTitle("Servers")
        .sheet(isPresented: $adding) {
            NavigationStack { ServerForm(editing: nil) }
        }
        .sheet(item: $editing) { server in
            NavigationStack { ServerForm(editing: server) }
        }
    }
}
