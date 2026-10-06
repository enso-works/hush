import Foundation

/// What an app's numbers count over: the period, which keys' data, and one
/// build channel or all. Every `/admin/apps/:app/...` read takes it.
public struct Scope: Sendable, Hashable {
    public var days: Int
    public var env: Env
    /// A build channel (`app_store`, `testflight`...), or nil for all.
    public var channel: String?

    public init(days: Int = 30, env: Env = .prod, channel: String? = nil) {
        self.days = days
        self.env = env
        self.channel = channel
    }

    var items: [String: String] {
        var q = ["days": String(days), "env": env.rawValue]
        q["channel"] = channel
        return q
    }
}

/// One step of a funnel: how many installs reached it, in order, within the window.
public struct FunnelStep: Decodable, Sendable, Hashable {
    public let event: String
    /// A prop the event had to carry, `["plan": "yearly"]`.
    public let `where`: [String: String]?
    public let label: String
    public let installs: Int
    /// The median time from the step before, nil for the first.
    public let medianSeconds: Int?

    enum CodingKeys: String, CodingKey {
        case event, `where`, label, installs
        case medianSeconds = "median_s"
    }
}

/// A funnel from the catalog (or the default paywall one), run over the scope.
public struct Funnel: Decodable, Sendable, Hashable {
    public let name: String
    public let windowDays: Int
    public let steps: [FunnelStep]

    enum CodingKeys: String, CodingKey {
        case name, steps
        case windowDays = "window_days"
    }
}

/// `GET /admin/apps/:app/funnels`.
public struct FunnelsAnswer: Decodable, Sendable {
    public let funnels: [Funnel]
}

/// `GET /admin/apps/:app/funnel`: a funnel built in the app.
public struct BuiltFunnel: Decodable, Sendable, Hashable {
    public let windowDays: Int
    public let steps: [FunnelStep]

    enum CodingKeys: String, CodingKey {
        case steps
        case windowDays = "window_days"
    }
}

/// A step of a funnel to build: an event, and optionally one prop it must carry.
public struct StepQuery: Sendable, Hashable, Codable {
    public var event: String
    public var prop: String?
    public var value: String?

    public init(_ event: String, prop: String? = nil, value: String? = nil) {
        self.event = event
        self.prop = prop
        self.value = value
    }

    /// `event` or `event:prop=value`, as the server reads `step=`.
    var query: String {
        guard let prop = prop?.nilIfEmpty, let value = value?.nilIfEmpty else { return event }
        return "\(event):\(prop)=\(value)"
    }
}

/// Installs by the week they first opened the app, and how many were still
/// around in each week after.
public struct Cohort: Decodable, Sendable, Hashable {
    /// The Monday the week starts, `YYYY-MM-DD` (UTC).
    public let week: String
    public let installs: Int
    /// `active[k]`: installs that sent anything k weeks later; nil for a week still to come.
    public let active: [Int?]
}

/// `GET /admin/apps/:app/cohorts`.
public struct CohortsAnswer: Decodable, Sendable {
    public let weeks: Int
    public let cohorts: [Cohort]
}

/// A prop an event carried this period, and on how many of them.
public struct PropKey: Decodable, Sendable, Hashable {
    public let key: String
    public let n: Int
}

struct PropsAnswer: Decodable { let keys: [PropKey] }

/// One value of a prop: how many events carried it, from how many installs.
/// `unset` is the events without the prop.
public struct BreakdownRow: Decodable, Sendable, Hashable {
    public let value: String
    public let n: Int
    public let installs: Int
}

struct BreakdownAnswer: Decodable { let rows: [BreakdownRow] }

/// `GET /admin/installs/:id`: one install, its latest events and its tickets.
/// Never a ticket with an email: those are not linked to an install.
public struct InstallDetail: Decodable, Sendable {
    public struct Install: Decodable, Sendable, Hashable {
        public let id: String
        public let app: String
        public let env: String
        public let firstSeen: Date
        public let lastSeen: Date
        public let platform: String?
        public let os: String?
        public let device: String?
        public let locale: String?
        public let country: String?
        public let version: String?
        public let build: String?
        public let rcId: String?
        public let pro: Bool
        public let channel: String?
        public let sdk: String?

        enum CodingKeys: String, CodingKey {
            case id, app, env, platform, os, device, locale, country, version, build, pro, channel, sdk
            case firstSeen = "first_seen"
            case lastSeen = "last_seen"
            case rcId = "rc_id"
        }
    }

    public struct Event: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let name: String
        public let known: Bool
        /// When the app says it happened.
        public let at: Date
        public let receivedAt: Date
        public let session: String?
        public let version: String?
        public let channel: String?
        public let props: [String: JSONValue]

        enum CodingKeys: String, CodingKey {
            case id, name, known, at, session, version, channel, props
            case receivedAt = "received_at"
        }
    }

    public struct TicketLine: Decodable, Sendable, Hashable, Identifiable {
        public let id: ServerID
        public let app: String
        public let kind: TicketKind
        public let subject: String?
        public let status: TicketStatus
        public let createdAt: Date

        enum CodingKeys: String, CodingKey {
            case id, app, kind, subject, status
            case createdAt = "created_at"
        }
    }

    public let id: String
    /// Nil when the install sent tickets but its row is gone (retention, or forgotten).
    public let install: Install?
    public let events: [Event]
    public let tickets: [TicketLine]
}

/// `POST /admin/installs/:id/forget`: what was deleted.
public struct Forgotten: Decodable, Sendable {
    public struct Counts: Decodable, Sendable { public let events: Int; public let tickets: Int }
    public let deleted: Counts
}

extension AdminClient {
    public func app(_ slug: String, _ scope: Scope) async throws -> AppDetail {
        try await send("GET", ["admin", "apps", slug], query: scope.items)
    }

    /// The catalog's funnels for the app, or the default paywall one.
    public func funnels(_ slug: String, _ scope: Scope) async throws -> [Funnel] {
        let answer: FunnelsAnswer = try await send("GET", ["admin", "apps", slug, "funnels"], query: scope.items)
        return answer.funnels
    }

    /// Any steps in order, each within `windowDays` of the first. Two to eight steps.
    public func funnel(_ slug: String, steps: [StepQuery], windowDays: Int = 7, _ scope: Scope) async throws -> BuiltFunnel {
        var r = try request("GET", ["admin", "apps", slug, "funnel"], query: scope.items.merging(["window": String(windowDays)]) { $1 })
        // `step` repeats, which the query dictionary cannot say.
        r.url?.append(queryItems: steps.map { URLQueryItem(name: "step", value: $0.query) })
        return try await send(r)
    }

    /// Weekly cohorts: `weeks` from 2 to 26. Counted over whole weeks, not the scope's days.
    public func cohorts(_ slug: String, weeks: Int = 8, _ scope: Scope) async throws -> CohortsAnswer {
        var q = scope.items
        q["days"] = nil
        q["weeks"] = String(weeks)
        return try await send("GET", ["admin", "apps", slug, "cohorts"], query: q)
    }

    /// The props an event carried this period, most used first.
    public func props(_ slug: String, event: String, _ scope: Scope) async throws -> [PropKey] {
        let answer: PropsAnswer = try await send("GET", ["admin", "apps", slug, "props"], query: scope.items.merging(["event": event]) { $1 })
        return answer.keys
    }

    /// An event counted by one of its props' values.
    public func breakdown(_ slug: String, event: String, prop: String, _ scope: Scope) async throws -> [BreakdownRow] {
        let answer: BreakdownAnswer = try await send("GET", ["admin", "apps", slug, "breakdown"],
                                                     query: scope.items.merging(["event": event, "prop": prop]) { $1 })
        return answer.rows
    }

    /// One install by its id, as the app shows it in a debug screen. `.notFound` for an id the server has nothing for.
    public func install(_ id: String, limit: Int = 100) async throws -> InstallDetail {
        try await send("GET", ["admin", "installs", id.lowercased()], query: ["limit": String(limit)])
    }

    /// Deletes the install, its events and its tickets: a "delete my data" request.
    public func forget(install id: String) async throws -> Forgotten {
        try await send("POST", ["admin", "installs", id.lowercased(), "forget"], body: Empty())
    }
}

extension String {
    /// Whether it is an install id: a UUID, any case.
    public var isInstallID: Bool { UUID(uuidString: trimmingCharacters(in: .whitespacesAndNewlines)) != nil }
}
