import Foundation

/// The decoder for every /admin answer. Timestamps come from Postgres in two
/// shapes (`2026-10-04T14:09:17.300Z` and `2026-10-03T19:09:17.3+00:00`), with
/// or without fractional seconds, so dates are parsed by hand.
enum HushJSON {
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            guard let date = parseDate(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "not an ISO 8601 date: \(s)")
            }
            return date
        }
        return d
    }()

    static let encoder = JSONEncoder()

    // Value types, so one each serves every decode on any thread.
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let withoutFraction = Date.ISO8601FormatStyle()

    static func parseDate(_ s: String) -> Date? {
        (try? withFraction.parse(s)) ?? (try? withoutFraction.parse(s))
    }
}

/// An id the server sends as a string or a number: Postgres bigints arrive
/// as strings (ticket ids), smaller ones as numbers (reply ids).
public struct ServerID: Hashable, Sendable, Codable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let value: String
    public init(_ value: String) { self.value = value }
    public init(stringLiteral value: String) { self.value = value }
    public var description: String { value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else { value = String(try c.decode(Int64.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}

/// A string-valued enum that keeps a value it does not know (from a newer
/// server) instead of failing the whole answer.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
    static func other(_ raw: String) -> Self
}

extension OpenEnum {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .other(raw)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}
