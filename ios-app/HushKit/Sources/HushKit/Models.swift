import Foundation

// The /admin answers the app reads, as the server sends them
// (dashboard/src/lib/api.ts has the same shapes for the web dashboard).
// Fields an older server leaves out are optional.

/// `GET /admin/session`: answered without a token. A 200 means the server is
/// a demo, or a proxy in front adds the token; a 401 means sign in.
public struct SessionInfo: Decodable, Sendable {
    public let demo: Bool
}

/// Which keys' data to show: release builds (`prod`) or development (`dev`).
public enum Env: String, Codable, Sendable, CaseIterable {
    case prod, dev
}

/// `GET /admin/apps`.
public struct AppsAnswer: Decodable, Sendable {
    public let apps: [AppSummary]
    /// How long an install row outlives its last batch, or nil when rows are kept.
    public let installRetentionDays: Int?

    enum CodingKeys: String, CodingKey {
        case apps
        case installRetentionDays = "install_retention_days"
    }
}

public struct AppSummary: Decodable, Sendable, Identifiable, Hashable {
    public var id: String { app }
    public let app: String
    public let name: String
    public let newInstalls: Int
    public let totalInstalls: Int
    public let dau: Int
    public let wau: Int
    public let mau: Int
    public let sessions: Int
    public let events: Int
    public let openTickets: Int
    public let lastEvent: Date?
    /// Installs Apple attributed to an ad this period.
    public let adInstalls: Int?
    /// Active installs per day over the period (servers from 2026-09 on).
    public let trend: [Int]?

    enum CodingKeys: String, CodingKey {
        case app, name, dau, wau, mau, sessions, events, trend
        case newInstalls = "new_installs"
        case totalInstalls = "total_installs"
        case openTickets = "open_tickets"
        case lastEvent = "last_event"
        case adInstalls = "ad_installs"
    }
}

/// `GET /admin/apps/:app`: one app over the period, against the period before.
public struct AppDetail: Decodable, Sendable {
    public struct Period: Decodable, Sendable, Hashable {
        public let newInstalls: Int
        public let sessions: Int
        public let active: Int
        public let highlight: Int
        public let highlightDone: Int

        enum CodingKeys: String, CodingKey {
            case sessions, active, highlight
            case newInstalls = "new_installs"
            case highlightDone = "highlight_done"
        }
    }

    public struct Day: Decodable, Sendable, Hashable {
        /// `YYYY-MM-DD`, in the server's time zone.
        public let day: String
        public let newInstalls: Int
        public let active: Int
        public let sessions: Int

        enum CodingKeys: String, CodingKey {
            case day, active, sessions
            case newInstalls = "new_installs"
        }
    }

    public struct Highlight: Decodable, Sendable, Hashable {
        public let event: String
        public let doneProp: String?

        enum CodingKeys: String, CodingKey {
            case event
            case doneProp = "done_prop"
        }
    }

    public struct Retained: Decodable, Sendable, Hashable {
        public let cohort: Int
        public let retained: Int
        /// Nil when no install is old enough to tell.
        public var rate: Double? { cohort > 0 ? Double(retained) / Double(cohort) : nil }
    }

    public struct Retention: Decodable, Sendable, Hashable {
        public let d1: Retained
        public let d7: Retained
        public let d30: Retained
    }

    public struct Engagement: Decodable, Sendable, Hashable {
        public let measured: Int
        public let medianSeconds: Int?
        public let p75Seconds: Int?
        public let sessionsPerInstall: Double?
        /// Installs by sessions this period: 1, 2, 3-5, 6-10, more than 10.
        public let sessionsHistogram: [Int]

        enum CodingKeys: String, CodingKey {
            case measured
            case medianSeconds = "median_s"
            case p75Seconds = "p75_s"
            case sessionsPerInstall = "sessions_per_install"
            case sessionsHistogram = "sessions_histogram"
        }
    }

    public struct Event: Decodable, Sendable, Hashable {
        public let name: String
        /// False for a name the catalog does not list: usually a typo.
        public let known: Bool
        public let n: Int
        public let installs: Int
    }

    public let app: String
    public let name: String?
    /// The channel this detail is filtered to, or nil for all.
    public let channel: String?
    public let channels: [Channel]?
    public let highlight: Highlight?
    public let current: Period
    public let prior: Period
    public let retention: Retention
    public let engagement: Engagement?
    public let todayActive: Int
    public let daily: [Day]
    public let versions: [Version]
    public let events: [Event]
    public let countries: [Country]
    public let tickets: Int
    public let lastEvent: Date?

    public struct Channel: Decodable, Sendable, Hashable {
        public let channel: String
        public let installs: Int
    }

    public struct Version: Decodable, Sendable, Hashable {
        public let version: String
        public let installs: Int
    }

    public struct Country: Decodable, Sendable, Hashable {
        /// Two letters, or `other` for countries under ten installs.
        public let country: String
        public let installs: Int
    }
}

public enum TicketStatus: OpenEnum, CaseIterable {
    case open, answered, closed, other(String)

    public static let allCases: [TicketStatus] = [.open, .answered, .closed]

    public init?(rawValue: String) {
        switch rawValue {
        case "open": self = .open
        case "answered": self = .answered
        case "closed": self = .closed
        default: return nil
        }
    }

    public var rawValue: String {
        switch self {
        case .open: "open"
        case .answered: "answered"
        case .closed: "closed"
        case .other(let raw): raw
        }
    }
}

public enum TicketKind: OpenEnum, CaseIterable {
    case issue, feature, love, other(String)

    public static let allCases: [TicketKind] = [.issue, .feature, .love]

    public init?(rawValue: String) {
        switch rawValue {
        case "issue": self = .issue
        case "feature": self = .feature
        case "love": self = .love
        default: return nil
        }
    }

    public var rawValue: String {
        switch self {
        case .issue: "issue"
        case .feature: "feature"
        case .love: "love"
        case .other(let raw): raw
        }
    }
}

/// One line of `GET /admin/tickets`.
///
/// A ticket with an email is not linked to an install: `install` and `rcId`
/// are nil on it. Never show an install id next to an email.
public struct TicketSummary: Decodable, Sendable, Identifiable, Hashable {
    public let id: ServerID
    public let app: String
    public let kind: TicketKind
    public let install: String?
    public let rcId: String?
    public let email: String?
    public let subject: String?
    public let status: TicketStatus
    public let createdAt: Date
    public let updatedAt: Date
    public let preview: String
    public let replies: Int

    enum CodingKeys: String, CodingKey {
        case id, app, kind, install, email, subject, status, preview, replies
        case rcId = "rc_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct TicketsAnswer: Decodable {
    let tickets: [TicketSummary]
}

/// `GET /admin/tickets/:id`: the thread.
public struct Ticket: Decodable, Sendable, Identifiable, Hashable {
    public struct Reply: Decodable, Sendable, Identifiable, Hashable {
        public enum Author: OpenEnum {
            case user, support, other(String)

            public init?(rawValue: String) {
                switch rawValue {
                case "user": self = .user
                case "support": self = .support
                default: return nil
                }
            }

            public var rawValue: String {
                switch self {
                case .user: "user"
                case .support: "support"
                case .other(let raw): raw
                }
            }
        }

        public let id: ServerID
        public let author: Author
        public let body: String
        public let at: Date
        /// Whether a support reply also went out by email.
        public let emailed: Bool
    }

    public let id: ServerID
    public let app: String
    public let kind: TicketKind
    public let install: String?
    public let rcId: String?
    public let email: String?
    public let subject: String?
    public let message: String
    /// What the app sent about itself: version, OS, paid flag. Values of any JSON type.
    public let diag: [String: JSONValue]?
    public let status: TicketStatus
    public let createdAt: Date
    public let updatedAt: Date
    public let replies: [Reply]

    enum CodingKeys: String, CodingKey {
        case id, app, kind, install, email, subject, message, diag, status, replies
        case rcId = "rc_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// `POST /admin/tickets/:id/reply`.
public struct ReplyResult: Decodable, Sendable {
    /// Whether the reply also went out by email (the user left an address and mail is set up).
    public let emailed: Bool?
}

/// Any JSON value, for fields whose shape the server does not fix.
public enum JSONValue: Decodable, Sendable, Hashable, CustomStringConvertible {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public var description: String {
        switch self {
        case .string(let s): s
        case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .bool(let b): b ? "true" : "false"
        case .null: "null"
        case .array(let a): "[" + a.map(\.description).joined(separator: ", ") + "]"
        case .object(let o): "{" + o.keys.sorted().map { "\($0): \(o[$0]!.description)" }.joined(separator: ", ") + "}"
        }
    }
}
