import HushKit
import Observation
import SwiftUI

/// The servers the app knows and which one is open, for every screen.
@Observable @MainActor
final class AppModel {
    private let store: ServerStore
    private(set) var state: ServerStore.State

    init(store: ServerStore) {
        self.store = store
        state = store.load()
    }

    var servers: [Server] { state.servers }
    var current: Server? { state.current }

    /// A client for the server, with its secrets. A Keychain that cannot be
    /// read (it can, briefly, after a restart) gives one without them, which
    /// the server answers with 401, shown as such.
    func client(for server: Server) -> AdminClient {
        AdminClient((try? store.connection(for: server)) ?? Connection(baseURL: server.baseURL))
    }

    var client: AdminClient? { current.map(client(for:)) }

    func select(_ server: Server) {
        state.selected = server.id
        persist()
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
    }

    func remove(_ server: Server) {
        try? store.removeSecrets(for: server)
        state.servers.removeAll { $0.id == server.id }
        if state.selected == server.id { state.selected = state.servers.first?.id }
        persist()
    }

    func addDemo() {
        if let demo = state.servers.first(where: \.isDemo) { return select(demo) }
        try? save(.demo(), token: nil, headerValue: nil)
    }

    private func persist() {
        try? store.save(state)
    }
}
