import HushKit
import SwiftUI

/// A scanned or opened pairing link, shown before anything happens: the
/// server it signs in to, and the name this phone will have on its Phones
/// page. Nothing is sent until Connect.
struct PairingSheet: View {
    let link: PairingLink

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = "iPhone"
    @State private var working = false
    @State private var problem: String?
    @State private var connected = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Server", value: link.server.host() ?? link.server.absoluteString)
                    if link.code != nil {
                        TextField("This phone's name", text: $name)
                    }
                } footer: {
                    Text(link.code == nil
                         ? "This server needs no code: it opens as it is."
                         : "The phone gets a token of its own, listed on the dashboard's Phones page, where you can revoke it. The code works once.")
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
            }
            .navigationTitle("Connect to hush")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working { ProgressView() } else { Button("Connect") { Task { await connect() } } }
                }
            }
            .interactiveDismissDisabled(working)
            .sensoryFeedback(.success, trigger: connected)
            .sensoryFeedback(trigger: problem) { _, new in new == nil ? nil : .error }
        }
    }

    private func connect() async {
        working = true
        problem = nil
        defer { working = false }
        let host = link.server.host() ?? link.server.absoluteString
        do {
            if let code = link.code {
                let paired = try await AdminClient(Connection(baseURL: link.server)).pair(code: code, name: name.trimmingCharacters(in: .whitespaces))
                try model.save(Server(name: host, baseURL: link.server, deviceID: paired.device.id), token: paired.token, headerValue: nil)
            } else {
                let access = try await AdminClient(Connection(baseURL: link.server)).check()
                try model.save(Server(name: access == .demo ? "Demo" : host, baseURL: link.server, isDemo: access == .demo), token: nil, headerValue: nil)
            }
            connected = true
            dismiss()
        } catch HushError.notFound {
            problem = "This code has been used or has expired. Show a new one on the dashboard."
        } catch HushError.unauthorized {
            problem = "This server wants its admin token: add it with Add server instead."
        } catch {
            problem = HushError(error).message
        }
    }
}
