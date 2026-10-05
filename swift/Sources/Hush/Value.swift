import Foundation

/// One prop value: a string, a number, a boolean or null, as the server takes
/// them. Props are one flat level; write them as literals:
///
///     Hush.track("workout_completed", ["minutes": 20, "kind": "run", "completed": true])
public enum HushValue: Sendable, Equatable, Codable,
    ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByNilLiteral {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null

    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(nilLiteral: ()) { self = .null }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int.self) { self = .int(i) }
        else if let d = try? c.decode(Double.self) { self = .double(d) }
        else { self = .string(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .int(let i): try c.encode(i)
        // JSON has no NaN or infinity: such a number goes as null rather than sink the batch.
        case .double(let d): d.isFinite ? try c.encode(d) : try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }
}

public typealias Props = [String: HushValue]

/// Where a session began. Any short snake_case string; these are the usual doors.
public struct Entry: RawRepresentable, Sendable, Hashable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { rawValue = value }

    public static let launch: Entry = "launch"
    public static let link: Entry = "link"
    public static let notification: Entry = "notification"
    public static let widget: Entry = "widget"
    public static let quickAction: Entry = "quick_action"
    public static let siri: Entry = "siri"
}

/// What the SDK writes to the console: nothing (the default), mistakes, or everything it does.
public enum LogLevel: Sendable { case silent, error, debug }

/// One send's outcome, for `onFlush`. `willRetry`: the batch stays queued and goes again later.
public struct FlushResult: Sendable, Equatable {
    /// The HTTP status, or nil when no answer came (offline).
    public let status: Int?
    public let accepted: Int
    public let duplicate: Int
    public let rejected: Int
    public let willRetry: Bool
}

/// Feedback, as the app shows it.
public struct Ticket: Sendable, Equatable, Identifiable, Decodable {
    public enum Kind: String, Sendable, Codable { case issue, feature, love }

    public struct Reply: Sendable, Equatable, Decodable {
        public let author: String
        public let body: String
        public let at: String
    }

    public let id: String
    public let kind: String
    public let subject: String?
    public let message: String
    /// `open`, `answered` or `closed`.
    public let status: String
    public let createdAt: String
    /// A reply from support this device has not shown yet.
    public let unread: Bool
    public let replies: [Reply]

    enum CodingKeys: String, CodingKey {
        case id, kind, subject, message, status, unread, replies
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A bigint from Postgres: a string from some servers, a number from others.
        if let s = try? c.decode(String.self, forKey: .id) { id = s } else { id = String(try c.decode(Int64.self, forKey: .id)) }
        kind = try c.decode(String.self, forKey: .kind)
        subject = try c.decodeIfPresent(String.self, forKey: .subject)
        message = try c.decode(String.self, forKey: .message)
        status = try c.decode(String.self, forKey: .status)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        replies = try c.decodeIfPresent([Reply].self, forKey: .replies) ?? []
    }
}

/// What can keep a call from reaching the server.
public enum HushFailure: String, Error, Sendable {
    /// No key or url: the SDK is off.
    case unavailable
    case offline
    /// Five tickets a day, or twenty replies.
    case tooMany = "too_many"
    /// A reply on a thread support closed.
    case closed
    case failed
}
