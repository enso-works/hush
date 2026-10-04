import Foundation
import Security

/// A hush server the app knows. Its token and a proxy header's value are
/// secrets, kept in the Keychain (`SecretStore`), never in this.
public struct Server: Codable, Identifiable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var baseURL: URL
    public var isDemo: Bool
    /// The header a proxy in front wants (`ADMIN_PROXY_HEADER`, an access proxy's), if any.
    public var headerName: String?

    public init(id: UUID = UUID(), name: String, baseURL: URL, isDemo: Bool = false, headerName: String? = nil) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.isDemo = isDemo
        self.headerName = headerName
    }

    public static func demo() -> Server {
        Server(name: "Demo", baseURL: Connection.demo.baseURL, isDemo: true)
    }
}

/// Where secrets live: the Keychain in the app, memory in tests.
public protocol SecretStore: Sendable {
    func read(_ account: String) throws -> String?
    /// Stores the value, or deletes it when nil.
    func write(_ value: String?, for account: String) throws
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

/// Generic passwords under one service, on this device only (never synced or
/// in a backup), readable once it has been unlocked after a restart.
public struct KeychainStore: SecretStore {
    public let service: String

    public init(service: String = "com.bavrk.hush") {
        self.service = service
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func read(_ account: String) throws -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw KeychainError(status: status) }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ value: String?, for account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
        guard let value, !value.isEmpty else { return }
        var q = query(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(q as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added) }
    }
}

public final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func read(_ account: String) throws -> String? {
        lock.withLock { values[account] }
    }

    public func write(_ value: String?, for account: String) throws {
        lock.withLock { values[account] = value?.isEmpty == false ? value : nil }
    }
}

/// The servers the app knows and which one is open. The list is a JSON file;
/// the secrets go to the `SecretStore`.
public struct ServerStore: Sendable {
    public struct State: Codable, Equatable, Sendable {
        public var servers: [Server] = []
        public var selected: UUID?

        public init(servers: [Server] = [], selected: UUID? = nil) {
            self.servers = servers
            self.selected = selected
        }

        public var current: Server? { servers.first { $0.id == selected } ?? servers.first }
    }

    let file: URL
    let secrets: any SecretStore

    public init(file: URL, secrets: any SecretStore) {
        self.file = file
        self.secrets = secrets
    }

    /// In the app's Application Support, with the Keychain.
    public static func standard() throws -> ServerStore {
        let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return ServerStore(file: dir.appending(component: "servers.json"), secrets: KeychainStore())
    }

    /// An unreadable file starts over rather than locking the app out; the secrets stay until their servers are added again or removed.
    public func load() -> State {
        guard let data = try? Data(contentsOf: file) else { return State() }
        return (try? JSONDecoder().decode(State.self, from: data)) ?? State()
    }

    public func save(_ state: State) throws {
        try JSONEncoder().encode(state).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func token(for server: Server) throws -> String? {
        try secrets.read("\(server.id.uuidString).token")
    }

    public func headerValue(for server: Server) throws -> String? {
        try secrets.read("\(server.id.uuidString).header")
    }

    public func setSecrets(for server: Server, token: String?, headerValue: String?) throws {
        try secrets.write(token, for: "\(server.id.uuidString).token")
        try secrets.write(headerValue, for: "\(server.id.uuidString).header")
    }

    /// Forgets a server's secrets; take it out of the list with `save`.
    public func removeSecrets(for server: Server) throws {
        try setSecrets(for: server, token: nil, headerValue: nil)
    }

    /// How to reach the server: its address with its secrets.
    public func connection(for server: Server) throws -> Connection {
        var headers: [String: String] = [:]
        if let name = server.headerName, !name.isEmpty, let value = try headerValue(for: server) {
            headers[name] = value
        }
        return Connection(baseURL: server.baseURL, token: try token(for: server), headers: headers)
    }
}
