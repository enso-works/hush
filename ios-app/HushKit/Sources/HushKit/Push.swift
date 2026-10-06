import Foundation

/// What a phone asked a server to push: new feedback, users' replies, which apps.
public struct PushSignup: Codable, Sendable, Hashable {
    /// The APNs device token, hex.
    public var token: String
    /// A development build's token works only against Apple's sandbox.
    public var sandbox: Bool
    /// The app's name for the server, sent back in every push: its `Server.id`.
    public var label: String?
    public var tickets: Bool
    public var replies: Bool
    /// Slugs, or nil for every app.
    public var apps: [String]?

    public init(token: String, sandbox: Bool, label: String?, tickets: Bool = true, replies: Bool = true, apps: [String]? = nil) {
        self.token = token
        self.sandbox = sandbox
        self.label = label
        self.tickets = tickets
        self.replies = replies
        self.apps = apps
    }

    enum CodingKeys: String, CodingKey { case token, sandbox, label, tickets, replies, apps }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // GET /admin/push leaves the token out: the phone asked with it.
        token = try c.decodeIfPresent(String.self, forKey: .token) ?? ""
        sandbox = try c.decode(Bool.self, forKey: .sandbox)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        tickets = try c.decode(Bool.self, forKey: .tickets)
        replies = try c.decode(Bool.self, forKey: .replies)
        apps = try c.decodeIfPresent([String].self, forKey: .apps)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(token, forKey: .token)
        try c.encode(sandbox, forKey: .sandbox)
        try c.encodeIfPresent(label, forKey: .label)
        try c.encode(tickets, forKey: .tickets)
        try c.encode(replies, forKey: .replies)
        // Null, not absent: every app.
        try c.encode(apps, forKey: .apps)
    }
}

/// `GET` and `POST /admin/push`: whether the server can send, and this phone's sign-up.
public struct PushStatus: Decodable, Sendable {
    /// False when the server has no APNs key: a sign-up is kept, nothing arrives.
    public let configured: Bool
    public let signup: PushSignup?
}

/// What a push says, as the app reads it back from `userInfo`.
public struct PushTicket: Sendable, Hashable {
    public let ticket: ServerID
    public let app: String?
    /// The `label` the phone signed up with: which server it came from.
    public let server: String?

    public init?(_ userInfo: [AnyHashable: Any]) {
        guard let id = userInfo["ticket"] as? String, !id.isEmpty else { return nil }
        ticket = ServerID(id)
        app = userInfo["app"] as? String
        server = userInfo["server"] as? String
    }
}

extension AdminClient {
    /// Whether the server can push, and what this phone (by its token) signed up for.
    public func pushStatus(token: String?) async throws -> PushStatus {
        var q: [String: String] = [:]
        q["token"] = token
        return try await send("GET", ["admin", "push"], query: q)
    }

    /// Signs the phone up, or changes what it wants.
    public func signUpForPush(_ signup: PushSignup) async throws -> PushStatus {
        try await send("POST", ["admin", "push"], body: signup)
    }

    public func signOffPush(token: String) async throws {
        let _: OK = try await send("DELETE", ["admin", "push", token], body: Empty())
    }

    /// One push to this phone, to show it works.
    public func testPush(token: String) async throws {
        struct Body: Encodable { let token: String }
        let _: OK = try await send("POST", ["admin", "push", "test"], body: Body(token: token))
    }
}

extension Data {
    /// An APNs device token as the server stores it.
    public var hexToken: String { map { String(format: "%02x", $0) }.joined() }
}
