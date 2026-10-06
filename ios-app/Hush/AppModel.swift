import HushKit
import Observation
import SwiftUI

/// The servers the app knows and which one is open, for every screen.
@Observable
final class AppModel {
    private let store: ServerStore
    private(set) var state: ServerStore.State
    /// A pairing link waiting to be confirmed: opened from the camera, or scanned in the app.
    var pairing: PairingLink?
    /// The tab shown, so a screen can send the user to another.
    var tab = AppTab.overview
    /// The open server's feedback, kept while the tab changes, so the tab's
    /// badge has its count and a thread left open is still there.
    private(set) var inbox: Inbox?

    init(store: ServerStore) {
        self.store = store
        state = store.load()
        openInbox()
    }

    var servers: [Server] { state.servers }
    var current: Server? { state.current }

    /// A client for the server, with its secrets. A Keychain that cannot be
    /// read (it can, briefly, after a restart) gives one without them, which
    /// the server answers with 401, shown as such.
    func client(for server: Server) -> AdminClient {
        do {
            return AdminClient(try store.connection(for: server))
        } catch {
            log.error("Keychain unreadable for a server: \(error, privacy: .public)")
            return AdminClient(Connection(baseURL: server.baseURL))
        }
    }

    var client: AdminClient? { current.map(client(for:)) }

    func select(_ server: Server) {
        state.selected = server.id
        persist()
        openInbox()
    }

    /// Adds the server, or replaces the one with its id, and opens it.
    /// A nil token or header value leaves the stored one as it is.
    func save(_ server: Server, token: String?, headerValue: String?) throws {
        try store.setSecrets(
            for: server,
            token: token ?? store.token(for: server),
            headerValue: server.headerName == nil ? nil : (headerValue ?? store.headerValue(for: server))
        )
        if let i = state.servers.firstIndex(where: { $0.id == server.id }) {
            state.servers[i] = server
        } else {
            state.servers.append(server)
        }
        state.selected = server.id
        persist()
        // The token may have changed: a new inbox, with a client that has it.
        openInbox(fresh: true)
    }

    func remove(_ server: Server) {
        Telemetry.track("server_removed", ["paired": server.deviceID == nil ? "no" : "yes"])
        // A paired phone signs itself out on the server too, while it still has its token.
        if let device = server.deviceID {
            let client = client(for: server)
            Task {
                do {
                    try await client.revokeDevice(device)
                } catch {
                    log.error("Could not revoke this phone on its server: \(String(describing: error), privacy: .public)")
                }
            }
        }
        do {
            try store.removeSecrets(for: server)
        } catch {
            log.error("Could not forget a server's secrets: \(error, privacy: .public)")
        }
        state.servers.removeAll { $0.id == server.id }
        if state.selected == server.id { state.selected = state.servers.first?.id }
        persist()
        openInbox()
    }

    /// Feedback with a filter, from another screen: an app's open messages.
    func showFeedback(app: String? = nil, status: TicketStatus? = .open) {
        inbox?.query = TicketQuery(status: status, app: app)
        tab = .feedback
    }

    private func openInbox(fresh: Bool = false) {
        guard let server = current else { inbox = nil; return }
        if !fresh, inbox?.serverID == server.id { return }
        inbox = Inbox(serverID: server.id, client: client(for: server))
    }

    func addDemo() {
        if let demo = state.servers.first(where: \.isDemo) { return select(demo) }
        do {
            try save(.demo(), token: nil, headerValue: nil)
        } catch {
            log.error("Could not add the demo: \(error, privacy: .public)")
        }
    }

    private func persist() {
        do {
            try store.save(state)
        } catch {
            log.error("Could not save the server list: \(error, privacy: .public)")
        }
    }
}

enum AppTab: Hashable {
    case overview, feedback, settings
}
