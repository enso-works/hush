import HushKit
import SwiftUI

/// The servers the app knows: open one, edit, remove, add.
struct ServersView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var editing: Server?
    @State private var removing: Server?

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
                        Button("Remove", role: .destructive) { removing = server }
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
        // The token goes with the server and cannot be shown again: worth one question.
        .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { server in
            Button("Remove", role: .destructive) { model.remove(server) }
        } message: { server in
            Text(server.isDemo ? "You can add the demo again from here." : "Its admin token is forgotten on this device. Adding the server again needs it.")
        }
    }
}
