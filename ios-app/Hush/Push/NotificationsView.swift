import HushKit
import SwiftUI
import UserNotifications

/// Whether this phone hears about a server's new feedback and replies, and
/// for which apps.
struct NotificationsView: View {
    let server: Server

    @Environment(AppModel.self) private var model
    @Environment(PushCenter.self) private var push
    @Environment(\.openURL) private var openURL
    @State private var on = false
    @State private var tickets = true
    @State private var replies = true
    /// Nil: every app.
    @State private var apps: Set<String>?
    @State private var names: [AppSummary] = []
    @State private var configured: Bool?
    /// `apns` or `relay`: how the server's pushes leave.
    @State private var via: String?
    @State private var working = false
    @State private var problem: String?
    @State private var tested = 0

    var body: some View {
        Form {
            if server.isDemo {
                Section {
                    Text("The demo sends no notifications: it takes no feedback.").foregroundStyle(.secondary)
                }
            } else {
                Section {
                    Toggle(isOn: Binding(get: { on }, set: { new in Task { await toggle(new) } })) {
                        Label("Notify This Phone", systemImage: "bell.badge")
                    }
                    .disabled(working)
                } footer: {
                    Text(footer)
                }
                if on {
                    Section("About") {
                        Toggle("New feedback", isOn: $tickets)
                        Toggle("Replies from users", isOn: $replies)
                    }
                    Section {
                        Toggle("Every app", isOn: Binding(get: { apps == nil }, set: { apps = $0 ? nil : Set(names.map(\.app)) }))
                        if apps != nil {
                            ForEach(names) { app in
                                Button {
                                    if apps?.contains(app.app) == true { apps?.remove(app.app) } else { apps?.insert(app.app) }
                                } label: {
                                    HStack {
                                        AppMark(slug: app.app, name: app.name, size: 28)
                                        Text(app.name).foregroundStyle(.primary)
                                        Spacer()
                                        if apps?.contains(app.app) == true { Image(systemName: "checkmark").foregroundStyle(.tint) }
                                    }
                                }
                                .accessibilityAddTraits(apps?.contains(app.app) == true ? .isSelected : [])
                            }
                        }
                    } header: {
                        Text("Apps")
                    }
                    Section {
                        Button("Send a Test Notification", systemImage: "paperplane") { Task { await test() } }
                            .disabled(working || configured == false)
                    }
                }
                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                        if push.authorization == .denied, let url = URL(string: UIApplication.openSettingsURLString) {
                            Button("Open Settings") { openURL(url) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Notifications")
        .task { await load() }
        .onChange(of: Prefs(tickets: tickets, replies: replies, apps: apps)) { old, new in
            guard on, old != new else { return }
            Task { await save() }
        }
        .sensoryFeedback(.success, trigger: tested)
        .onAppear { Telemetry.screen("notifications") }
    }

    private struct Prefs: Equatable { let tickets: Bool; let replies: Bool; let apps: Set<String>? }

    private var footer: String {
        if configured == false {
            return "This server sends no notifications: its operator turned the push relay off (PUSH_RELAY=off) and gave it no APNs key."
        }
        let what = "A notification names the app and shows the first line of the message; answer or close it from there. Never the user's email."
        if via == "relay" {
            return what + " They come through bavrk's push relay, sealed on the server with a key only this phone has: the relay never sees what was written."
        }
        return what
    }

    private func load() async {
        if let s = push.signup(server) {
            on = true
            tickets = s.tickets
            replies = s.replies
            apps = s.apps.map(Set.init)
        }
        await push.refreshAuthorization()
        let client = model.client(for: server)
        let status = try? await client.pushStatus(token: push.signup(server)?.token)
        configured = status?.configured
        via = status?.via
        names = (try? await client.apps(days: 1).apps) ?? []
    }

    private func toggle(_ new: Bool) async {
        working = true
        defer { working = false }
        do {
            if new {
                let status = try await push.signUp(server, tickets: tickets, replies: replies, apps: apps.map { $0.sorted() })
                configured = status?.configured
                via = status?.via
                Telemetry.track("push_on", ["via": status?.via ?? "none"])
            } else {
                try await push.signOff(server)
                Telemetry.track("push_off")
            }
            on = new
            problem = nil
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? HushError(error).message
        }
    }

    private func save() async {
        do {
            let status = try await push.signUp(server, tickets: tickets, replies: replies, apps: apps.map { $0.sorted() })
            configured = status?.configured
            via = status?.via
            problem = nil
        } catch {
            problem = HushError(error).message
        }
    }

    private func test() async {
        working = true
        defer { working = false }
        do {
            try await push.test(server)
            tested += 1
            problem = nil
        } catch {
            problem = HushError(error).message
        }
    }
}
