import Foundation

/// Where a hush server is, and how to sign in to it.
public struct Connection: Sendable, Hashable {
    /// The server's address, with any prefix a proxy mounts it under
    /// (`https://hush.example.com`, `https://example.com/hush`).
    public var baseURL: URL
    /// The server's `ADMIN_TOKEN`, or nil for a demo, or a server whose proxy adds it.
    public var token: String?
    /// Headers a proxy in front wants (`ADMIN_PROXY_HEADER`, an access proxy's), sent with every request.
    public var headers: [String: String]

    public init(baseURL: URL, token: String? = nil, headers: [String: String] = [:]) {
        self.baseURL = baseURL
        self.token = token
        self.headers = headers
    }

    /// The public demo: invented data, read-only, no token.
    public static let demo = Connection(baseURL: URL(string: "https://hush.bavrk.com/demo")!)

    /// A server address as someone types or pastes it: `https://` when no
    /// scheme is given, and the dashboard's own path (`/dashboard/...`,
    /// what a browser shows) dropped, since the API lives beside it.
    public static func normalize(_ input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard var c = URLComponents(string: s), let scheme = c.scheme?.lowercased(),
              scheme == "https" || scheme == "http", let host = c.host, !host.isEmpty else { return nil }
        let parts = c.path.split(separator: "/", omittingEmptySubsequences: false)
        if let i = parts.firstIndex(of: "dashboard") { c.path = parts[..<i].joined(separator: "/") }
        while c.path.hasSuffix("/") { c.path.removeLast() }
        c.query = nil
        c.fragment = nil
        return c.url
    }
}

/// What can go wrong talking to a server, in the terms the app shows.
public enum HushError: Error, Equatable, Sendable {
    /// 401: the token is wrong, or the server wants one and none was given.
    case unauthorized
    /// 403 from a demo: it reads, and writes nothing.
    case readOnly
    /// 404: the ticket or app is gone.
    case notFound
    /// 409: someone changed it since it was read (a config key); read it again.
    case conflict
    /// Any other answer that is not a success, with the server's `error`.
    case server(status: Int, message: String)
    /// No answer: offline, the host unknown, TLS refused, a timeout.
    case unreachable(String)
    /// An answer that is not what this app expects: likely not a hush server, or a much older one.
    case unreadable(String)
}

/// The operator's API (`/admin/*`) of one hush server.
///
/// Writes are JSON with `Content-Type: application/json`, as the server
/// requires of every admin write.
public struct AdminClient: Sendable {
    public let connection: Connection
    let session: URLSession

    public init(_ connection: Connection, session: URLSession = .shared) {
        self.connection = connection
        self.session = session
    }

    /// Asked without the token: whether the server is a demo, or signs in
    /// through a proxy. `.unauthorized` means it wants the token.
    public func session() async throws -> SessionInfo {
        try await send("GET", ["admin", "session"], withToken: false)
    }

    public func apps(days: Int = 30, env: Env = .prod) async throws -> AppsAnswer {
        try await send("GET", ["admin", "apps"], query: ["days": String(days), "env": env.rawValue])
    }

    public func app(_ slug: String, days: Int = 30, env: Env = .prod, channel: String? = nil) async throws -> AppDetail {
        var query = ["days": String(days), "env": env.rawValue]
        query["channel"] = channel
        return try await send("GET", ["admin", "apps", slug], query: query)
    }

    /// A page of tickets, open first, then newest. A server from before
    /// October 2026 reads only `status` and `kind`, and answers every match at
    /// once without `counts`: `TicketPage.filtered` is for that case.
    public func tickets(_ query: TicketQuery = TicketQuery()) async throws -> TicketPage {
        try await send("GET", ["admin", "tickets"], query: query.items)
    }

    public func ticket(_ id: ServerID) async throws -> Ticket {
        try await send("GET", ["admin", "tickets", id.value])
    }

    /// Answers the user: in the app, and by email when they left an address.
    /// `close` closes the thread with it.
    public func reply(to id: ServerID, body: String, close: Bool = false) async throws -> ReplyResult {
        try await send("POST", ["admin", "tickets", id.value, "reply"], body: ReplyBody(body: body, close: close))
    }

    public func setStatus(_ id: ServerID, _ status: TicketStatus) async throws {
        let _: OK = try await send("POST", ["admin", "tickets", id.value, "status"], body: StatusBody(status: status.rawValue))
    }

    /// Deletes the ticket and its replies, for a "delete my message" request.
    public func delete(_ id: ServerID) async throws {
        let _: OK = try await send("DELETE", ["admin", "tickets", id.value], body: Empty())
    }

    // MARK: - Requests

    struct ReplyBody: Encodable { let body: String; let close: Bool }
    struct StatusBody: Encodable { let status: String }
    struct Empty: Encodable {}
    struct OK: Decodable {}
    struct ErrorBody: Decodable { let error: String? }

    func request(_ method: String, _ path: [String], query: [String: String] = [:], body: (any Encodable)? = nil, withToken: Bool = true) throws -> URLRequest {
        // Each part is one path component, encoded: an app slug or id cannot add a segment.
        var url = path.reduce(connection.baseURL) { $0.appending(component: $1) }
        if !query.isEmpty {
            url.append(queryItems: query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) })
        }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in connection.headers { r.setValue(value, forHTTPHeaderField: name) }
        if withToken, let token = connection.token, !token.isEmpty {
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try HushJSON.encoder.encode(body)
        }
        return r
    }

    func send<T: Decodable>(_ method: String, _ path: [String], query: [String: String] = [:], body: (any Encodable)? = nil, withToken: Bool = true) async throws -> T {
        try await send(try request(method, path, query: query, body: body, withToken: withToken))
    }

    func send<T: Decodable>(_ r: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: r)
        } catch let e as URLError {
            throw HushError.unreachable(e.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw HushError.unreadable("not an HTTP answer") }
        switch http.statusCode {
        case 200..<300:
            do {
                return try HushJSON.decoder.decode(T.self, from: data)
            } catch {
                throw HushError.unreadable(String(describing: error))
            }
        case 401:
            throw HushError.unauthorized
        case 404:
            throw HushError.notFound
        default:
            let message = (try? HushJSON.decoder.decode(ErrorBody.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            if http.statusCode == 403, message == "read-only demo" { throw HushError.readOnly }
            if http.statusCode == 409, message == "changed since you opened it" { throw HushError.conflict }
            throw HushError.server(status: http.statusCode, message: message)
        }
    }
}

/// How a server lets the app in, found by `AdminClient.check`.
public enum Access: Equatable, Sendable {
    /// The public read-only showcase: no token.
    case demo
    /// A proxy in front adds the token itself.
    case proxy
    /// The server took the token given.
    case token
}

extension AdminClient {
    /// Checks an address, and the token or proxy header with it, before the
    /// app saves them: asks `/admin/session` without the token, then reads
    /// `/admin/apps` the way the app will. Throws what went wrong:
    /// `.unauthorized` when the server wants a token and none (or a wrong one)
    /// was given, `.unreadable` when the address is not a hush server.
    public func check() async throws -> Access {
        let access: Access
        do {
            access = try await session().demo ? .demo : .proxy
        } catch HushError.unauthorized {
            guard let token = connection.token, !token.isEmpty else { throw HushError.unauthorized }
            access = .token
        } catch HushError.notFound {
            // Every hush server answers /admin/session; a 404 is some other site.
            throw HushError.unreadable("no /admin/session at this address")
        }
        _ = try await apps(days: 1)
        return access
    }
}
