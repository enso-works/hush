import HushKit
import SwiftUI

/// The servers the app knows: open one, edit, remove, add.
struct ServersView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var editing: Server?
    @State private var removing: Server?
    @State private var scanning = false
    @State private var scanned: PairingLink?
    @State private var sharesUsage = Telemetry.sharesUsage
    @State private var forgetting = false
    @State private var forgetResult: Bool?

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
            if let current = model.current {
                Section {
                    NavigationLink {
                        NotificationsView(server: current)
                    } label: {
                        Label("Notifications", systemImage: "bell.badge")
                    }
                    NavigationLink {
                        PhonesView(server: current)
                    } label: {
                        Label("Phones", systemImage: "iphone")
                    }
                } header: {
                    Text(current.name)
                } footer: {
                    Text("New feedback on this phone, the phones signed in to this server, and a code to sign in another.")
                }
            }
            Section {
                Button("Scan the dashboard's QR code", systemImage: "qrcode.viewfinder") { scanning = true }
                Button("Add server", systemImage: "plus") { adding = true }
                if !model.servers.contains(where: \.isDemo) {
                    Button("Add the demo", systemImage: "sparkles") {
                        model.addDemo()
                        Telemetry.track("server_added", ["method": "demo"])
                    }
                }
            }
            if Telemetry.available {
                Section {
                    NavigationLink {
                        FeedbackView()
                    } label: {
                        Label("Feedback to the hush team", systemImage: "bubble.left.and.text.bubble.right")
                    }
                } header: {
                    Text("hush")
                } footer: {
                    Text("A problem, an idea, or kind words: they reach the people who make this app, and the answer shows there.")
                }
                Section {
                    Toggle("Share anonymous usage", isOn: $sharesUsage)
                        .onChange(of: sharesUsage) { _, on in Telemetry.sharesUsage = on }
                    Button("Delete my usage data", role: .destructive) { forgetting = true }
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("This app tells its makers which screens are used and how, with a random id and nothing about you or your servers. Turning it off stops that; deleting removes what was sent, and your feedback.")
                }
            }
        }
        .navigationTitle("Settings")
        .onAppear { Telemetry.screen("settings") }
        .confirmationDialog("Delete your usage data?", isPresented: $forgetting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task { forgetResult = await Telemetry.forget() }
            }
        } message: {
            Text("Everything this app sent about how it is used, and your feedback, is deleted from the hush team's server.")
        }
        .alert(forgetResult == true ? "Deleted" : "Not deleted yet", isPresented: Binding(get: { forgetResult != nil }, set: { if !$0 { forgetResult = nil } })) {
            Button("OK") {}
        } message: {
            Text(forgetResult == true ? "Your usage data and feedback are gone." : "The server could not be reached. Try again when you are online.")
        }
        .sheet(isPresented: $adding) {
            NavigationStack { ServerForm(editing: nil) }
        }
        .sheet(isPresented: $scanning, onDismiss: {
            if let scanned { model.pairing = scanned }
            scanned = nil
        }) {
            ScannerSheet { link in
                scanned = link
                scanning = false
            }
        }
        .sheet(item: $editing) { server in
            NavigationStack { ServerForm(editing: server) }
        }
        // The token goes with the server and cannot be shown again: worth one question.
        .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { server in
            Button("Remove", role: .destructive) { model.remove(server) }
        } message: { server in
            Text(server.isDemo ? "You can add the demo again from here."
                 : server.deviceID != nil ? "This phone is signed out on the server too. Connecting again needs a new code from the dashboard."
                 : "Its admin token is forgotten on this device. Adding the server again needs it.")
        }
    }
}
