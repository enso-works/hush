import Foundation

// Remote config (/admin/apps/:app/config): keys live in the app's catalog;
// the dashboard (and this app) override a key's default, its rules or both.

public enum ConfigType: OpenEnum {
    case bool, number, string, json, other(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "bool": self = .bool
        case "number": self = .number
        case "string": self = .string
        case "json": self = .json
        default: return nil
        }
    }

    public var rawValue: String {
        switch self {
        case .bool: "bool"
        case .number: "number"
        case .string: "string"
        case .json: "json"
        case .other(let raw): raw
        }
    }
}

/// Which devices a rule is for. Every field it has must match; none is every device.
public struct ConfigWhen: Codable, Sendable, Hashable {
    public var platform: [String]?
    /// A range: `>=2.1.0 <3`.
    public var version: String?
    public var channel: [String]?
    public var language: [String]?
    public var pro: Bool?

    public init(platform: [String]? = nil, version: String? = nil, channel: [String]? = nil, language: [String]? = nil, pro: Bool? = nil) {
        self.platform = platform
        self.version = version
        self.channel = channel
        self.language = language
        self.pro = pro
    }

    public var isEmpty: Bool { platform == nil && version == nil && channel == nil && language == nil && pro == nil }
}

/// A rule: devices matching `when`, `rollout` percent of them, get `value`.
public struct ConfigRule: Codable, Sendable, Hashable {
    public var when: ConfigWhen
    /// 0 to 100.
    public var rollout: Int
    public var value: JSONValue
    public var note: String?

    public init(when: ConfigWhen = ConfigWhen(), rollout: Int = 100, value: JSONValue, note: String? = nil) {
        self.when = when
        self.rollout = rollout
        self.value = value
        self.note = note
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        when = try c.decodeIfPresent(ConfigWhen.self, forKey: .when) ?? ConfigWhen()
        rollout = try c.decodeIfPresent(Int.self, forKey: .rollout) ?? 100
        value = try c.decode(JSONValue.self, forKey: .value)
        note = try c.decodeIfPresent(String.self, forKey: .note)
    }
}

/// A key's default and rules.
public struct ConfigParts: Decodable, Sendable, Hashable {
    public let `default`: JSONValue
    public let rules: [ConfigRule]
}

/// What the dashboard stored for a key: `default` only when it overrides the
/// default, `rules` only when it overrides the rules.
public struct ConfigOverride: Decodable, Sendable, Hashable {
    public let `default`: JSONValue?
    public let rules: [ConfigRule]?
    public let note: String?
    public let updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case `default`, rules, note
        case updatedAt = "updated_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Present and null would be a null default; absent is no override of it.
        `default` = c.contains(.default) ? try c.decode(JSONValue.self, forKey: .default) : nil
        rules = try c.decodeIfPresent([ConfigRule].self, forKey: .rules)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt)
    }
}

public struct ConfigKey: Decodable, Sendable, Hashable, Identifiable {
    public struct Source: Decodable, Sendable, Hashable {
        /// `catalog` or `override`.
        public let `default`: String
        public let rules: String
    }

    public var id: String { key }
    public let key: String
    public let type: ConfigType
    public let description: String?
    public let catalog: ConfigParts
    public let override: ConfigOverride?
    /// What `/v1/config` serves for it.
    public let effective: ConfigParts
    public let source: Source
    /// Why a stored override is not served, or nil.
    public let problem: String?
    /// False only when the stored override no longer fits the key's type.
    public let fits: Bool
    /// The latest change's id, 0 for none: what a write names as its base.
    public let change: Int

    public var overridden: Bool { override != nil }
}

public struct ConfigLimits: Decodable, Sendable, Hashable {
    public let keys: Int
    public let rules: Int
    public let stringChars: Int
    public let jsonBytes: Int
    public let totalBytes: Int
    public let noteChars: Int

    enum CodingKeys: String, CodingKey {
        case keys, rules
        case stringChars = "string_chars"
        case jsonBytes = "json_bytes"
        case totalBytes = "total_bytes"
        case noteChars = "note_chars"
    }
}

/// `GET /admin/apps/:app/config`.
public struct ConfigAnswer: Decodable, Sendable {
    public struct Orphan: Decodable, Sendable, Hashable {
        public let key: String
        public let override: ConfigOverride
        public let change: Int
    }

    public let app: String
    public let revision: String
    public let sizeBytes: Int
    public let limits: ConfigLimits
    public let keys: [ConfigKey]
    /// Overrides for keys the catalog no longer has. Never served.
    public let orphans: [Orphan]

    enum CodingKeys: String, CodingKey {
        case app, revision, limits, keys, orphans
        case sizeBytes = "size_bytes"
    }
}

/// One write to a key, newest first in the history.
public struct ConfigChange: Decodable, Sendable, Hashable, Identifiable {
    public struct Parts: Decodable, Sendable, Hashable {
        public let `default`: JSONValue?
        public let rules: [ConfigRule]?

        enum CodingKeys: String, CodingKey { case `default`, rules }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            `default` = c.contains(.default) ? try c.decode(JSONValue.self, forKey: .default) : nil
            rules = try c.decodeIfPresent([ConfigRule].self, forKey: .rules)
        }
    }

    public let id: ServerID
    public let key: String
    public let at: Date
    /// `set` or `revert`.
    public let action: String
    public let overrideBefore: Parts?
    public let overrideAfter: Parts?
    public let effectiveBefore: ConfigParts?
    public let effectiveAfter: ConfigParts?
    public let note: String?

    enum CodingKeys: String, CodingKey {
        case id, key, at, action, note
        case overrideBefore = "override_before"
        case overrideAfter = "override_after"
        case effectiveBefore = "effective_before"
        case effectiveAfter = "effective_after"
    }
}

/// `GET /admin/apps/:app/config/history`.
public struct ConfigHistory: Decodable, Sendable {
    public let changes: [ConfigChange]
    public let more: Bool
}

/// The device to preview for: what it reports, or an install whose last report fills the gaps.
public struct PreviewContext: Sendable, Hashable, Codable {
    public var platform: String?
    public var version: String?
    public var channel: String?
    public var language: String?
    public var pro: Bool?
    public var install: String?

    public init(platform: String? = nil, version: String? = nil, channel: String? = nil, language: String? = nil, pro: Bool? = nil, install: String? = nil) {
        self.platform = platform
        self.version = version
        self.channel = channel
        self.language = language
        self.pro = pro
        self.install = install
    }

    var items: [String: String] {
        var q: [String: String] = [:]
        q["platform"] = platform?.trimmingCharacters(in: .whitespaces).nilIfEmpty
        q["version"] = version?.trimmingCharacters(in: .whitespaces).nilIfEmpty
        q["channel"] = channel?.trimmingCharacters(in: .whitespaces).nilIfEmpty
        q["language"] = language?.trimmingCharacters(in: .whitespaces).nilIfEmpty
        q["pro"] = pro.map { $0 ? "true" : "false" }
        q["install"] = install?.trimmingCharacters(in: .whitespaces).lowercased().nilIfEmpty
        return q
    }
}

/// `GET /admin/apps/:app/config/preview`: what such a device gets, key by key.
public struct ConfigPreview: Decodable, Sendable {
    /// One way a key can come out: a rule's value (`rule` -1 is the default) for `share` percent of such devices.
    public struct Outcome: Decodable, Sendable, Hashable {
        public let rule: Int
        public let value: JSONValue?
        public let share: Double
    }

    public struct Key: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { key }
        public let key: String
        public let type: ConfigType
        /// Whether this is the unsaved edit, not what is served.
        public let draft: Bool
        public let outcomes: [Outcome]
    }

    public struct Context: Decodable, Sendable, Hashable {
        public let platform: String?
        public let version: String?
        public let channel: String?
        public let language: String?
        public let pro: Bool?
    }

    public let install: String?
    public let context: Context
    /// Which of the context's fields came from the install's last report.
    public let fromInstall: [String]
    public let warnings: [String]
    public let keys: [Key]

    enum CodingKeys: String, CodingKey {
        case install, context, warnings, keys
        case fromInstall = "from_install"
    }
}

/// A write to a key: a new default, new rules, or both, on top of change `base`.
public struct ConfigWrite: Encodable, Sendable, Hashable {
    public var base: Int
    public var `default`: JSONValue?
    public var rules: [ConfigRule]?
    public var note: String?

    public init(base: Int, default: JSONValue? = nil, rules: [ConfigRule]? = nil, note: String? = nil) {
        self.base = base
        self.default = `default`
        self.rules = rules
        self.note = note
    }

    enum CodingKeys: String, CodingKey { case base, `default`, rules, note }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(base, forKey: .base)
        // Absent, not null: the server reads a missing default as "keep the catalog's".
        try c.encodeIfPresent(`default`, forKey: .default)
        try c.encodeIfPresent(rules, forKey: .rules)
        try c.encodeIfPresent(note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, forKey: .note)
    }
}

/// The answer to a write: the key as it is now.
public struct ConfigWritten: Decodable, Sendable {
    public let revision: String
    public let key: ConfigKey
}

extension AdminClient {
    public func config(_ slug: String) async throws -> ConfigAnswer {
        try await send("GET", ["admin", "apps", slug, "config"])
    }

    /// Changes, newest first: one key's, or every key's; `before` a change id for the next page.
    public func configHistory(_ slug: String, key: String? = nil, before: ServerID? = nil, limit: Int = 20) async throws -> ConfigHistory {
        var q = ["limit": String(limit)]
        q["key"] = key
        q["before"] = before?.value
        return try await send("GET", ["admin", "apps", slug, "config", "history"], query: q)
    }

    /// What a device would get. With `key` and `draft`, that key as it would be after the edit.
    public func configPreview(_ slug: String, _ context: PreviewContext, key: String? = nil, draft: ConfigWrite? = nil) async throws -> ConfigPreview {
        var q = context.items
        q["key"] = key
        if let draft {
            struct Draft: Encodable { let `default`: JSONValue?; let rules: [ConfigRule]? }
            q["draft"] = String(decoding: try HushJSON.encoder.encode(Draft(default: draft.default, rules: draft.rules)), as: UTF8.self)
        }
        return try await send("GET", ["admin", "apps", slug, "config", "preview"], query: q)
    }

    /// Overrides a key. `.conflict` when it changed after change `write.base`.
    public func setConfig(_ slug: String, key: String, _ write: ConfigWrite) async throws -> ConfigWritten {
        try await send("POST", ["admin", "apps", slug, "config", key], body: write)
    }

    /// Back to the catalog's default and rules.
    public func revertConfig(_ slug: String, key: String, base: Int, note: String? = nil) async throws -> ConfigWritten {
        try await send("DELETE", ["admin", "apps", slug, "config", key], body: ConfigWrite(base: base, note: note))
    }
}
