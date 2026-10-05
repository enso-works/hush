import HushKit
import SwiftUI

/// Adds a server, or edits one. Nothing is saved until the server has
/// answered the way the app will talk to it.
struct ServerForm: View {
    let editing: Server?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var name = ""
    @State private var token = ""
    @State private var headerName = ""
    @State private var headerValue = ""
    @State private var checking = false
    @State private var problem: String?
    @State private var connected = false

    var body: some View {
        Form {
            Section {
                TextField("hush.example.com", text: $address)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Name (optional)", text: $name)
            } header: {
                Text("Server")
            } footer: {
                Text("The address you open the dashboard at. If /admin is only reachable on a VPN, connect the phone to it first.")
            }
            Section {
                SecureField(editing == nil ? "ADMIN_TOKEN" : "Unchanged", text: $token)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Admin token")
            } footer: {
                Text("Kept in this device's Keychain. Not needed when a proxy in front signs the dashboard in.")
            }
            Section {
                TextField("Header name", text: $headerName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField(editing?.headerName == nil ? "Value" : "Unchanged", text: $headerValue)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Proxy header")
            } footer: {
                Text("Only if a proxy in front of hush wants one, such as ADMIN_PROXY_HEADER.")
            }
            if let problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(editing == nil ? "Add server" : "Edit server")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                if checking { ProgressView() } else {
                    Button("Connect") { Task { await connect() } }
                        .disabled(Connection.normalize(address) == nil)
                }
            }
        }
        .onAppear {
            guard let editing else { return }
            address = editing.baseURL.absoluteString
            name = editing.name
            headerName = editing.headerName ?? ""
        }
        .interactiveDismissDisabled(checking)
        .sensoryFeedback(.success, trigger: connected)
        .sensoryFeedback(trigger: problem) { _, new in new == nil ? nil : .error }
    }

    private func connect() async {
        guard let url = Connection.normalize(address) else { return }
        checking = true
        problem = nil
        defer { checking = false }

        let header = headerName.trimmingCharacters(in: .whitespaces)
        var server = editing ?? Server(name: "", baseURL: url)
        server.baseURL = url
        server.isDemo = false
        server.headerName = header.isEmpty ? nil : header
        server.name = name.trimmingCharacters(in: .whitespaces).isEmpty ? (url.host() ?? url.absoluteString) : name

        // What the app will send: the typed values, or the stored ones when editing leaves a field blank.
        let stored = editing.map { model.client(for: $0).connection }
        let tokenToUse = token.isEmpty ? stored?.token : token
        var headers: [String: String] = [:]
        if let name = server.headerName, let value = headerValue.isEmpty ? stored?.headers[editing?.headerName ?? ""] : headerValue {
            headers[name] = value
        }

        do {
            let access = try await AdminClient(Connection(baseURL: url, token: tokenToUse, headers: headers)).check()
            server.isDemo = access == .demo
            try model.save(server, token: token.isEmpty ? nil : token, headerValue: headerValue.isEmpty ? nil : headerValue)
            connected = true
            dismiss()
        } catch HushError.unauthorized {
            problem = tokenToUse == nil ? "This server wants its admin token." : "The server refused this token."
        } catch let e as HushError {
            problem = e.message
        } catch {
            problem = error.localizedDescription
        }
    }
}
