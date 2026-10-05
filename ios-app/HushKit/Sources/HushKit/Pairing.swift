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

extension AdminClient {
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
