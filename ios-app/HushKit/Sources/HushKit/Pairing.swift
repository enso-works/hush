import Foundation

/// What the dashboard's QR code holds (its Phones page):
/// `hush://pair?url=<server>&code=<pairing code>`. The demo's has no code.
public struct PairingLink: Equatable, Sendable {
    public let server: URL
    /// Single use, ten minutes; nil for a server that needs none (the demo).
    public let code: String?

    public init?(_ link: URL) {
        guard let c = URLComponents(url: link, resolvingAgainstBaseURL: false),
              c.scheme?.lowercased() == "hush", c.host?.lowercased() == "pair",
              let raw = c.queryItems?.first(where: { $0.name == "url" })?.value,
              let server = Connection.normalize(raw) else { return nil }
        self.server = server
        let code = c.queryItems?.first(where: { $0.name == "code" })?.value
        self.code = code?.isEmpty == false ? code : nil
    }

    public init(server: URL, code: String?) {
        self.server = server
        self.code = code
    }

    /// The link, as the dashboard's QR code holds it.
    public var url: URL {
        var c = URLComponents()
        c.scheme = "hush"
        c.host = "pair"
        c.queryItems = [URLQueryItem(name: "url", value: server.absoluteString)] + (code.map { [URLQueryItem(name: "code", value: $0)] } ?? [])
        return c.url!
    }

    public init?(_ text: String) {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(url)
    }
}

/// `POST /admin/pair`: the device's own token, shown this once, and its id, for revoking it.
public struct Paired: Decodable, Sendable {
    public struct Device: Decodable, Sendable {
        public let id: String
        public let name: String
    }

    public let token: String
    public let device: Device
}

/// A phone signed in with a token of its own.
public struct Device: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let createdAt: Date
    public let lastSeenAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, name
        case createdAt = "created_at"
        case lastSeenAt = "last_seen_at"
    }
}

/// `POST /admin/pairing`: a single-use code for another phone, good for ten minutes.
public struct Pairing: Decodable, Sendable, Hashable {
    public let code: String
    public let expiresAt: Date

    enum CodingKeys: String, CodingKey {
        case code
        case expiresAt = "expires_at"
    }
}

extension AdminClient {
    /// The phones signed in to the server.
    public func devices() async throws -> [Device] {
        struct Answer: Decodable { let devices: [Device] }
        let answer: Answer = try await send("GET", ["admin", "devices"])
        return answer.devices
    }

    /// A code another phone signs in with: `PairingLink(server:code:)` makes its link.
    public func createPairing() async throws -> Pairing {
        try await send("POST", ["admin", "pairing"], body: Empty())
    }

    /// Trades a pairing code for a device token. Sent without a token: the code is the credential.
    public func pair(code: String, name: String) async throws -> Paired {
        struct Body: Encodable { let code: String; let name: String }
        return try await send("POST", ["admin", "pair"], body: Body(code: code, name: name), withToken: false)
    }

    /// Revokes a device; the app revokes its own when its server is removed.
    public func revokeDevice(_ id: String) async throws {
        let _: OK = try await send("DELETE", ["admin", "devices", id], body: Empty())
    }
}
