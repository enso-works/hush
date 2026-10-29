import Foundation

/// What a campaign table splits by: a link's utm tag, or the site a visit
/// came from (SDK 2.5, websites).
public enum CampaignSplit: String, CaseIterable, Sendable, Hashable {
    case source = "utm_source"
    case campaign = "utm_campaign"
    case adSet = "utm_term"
    case ad = "utm_content"
    case referrer
}

/// `GET /admin/apps/:app/campaigns`: per tag value, the installs whose first
/// tagged session in the period carried it, and how many went on through the
/// funnel's steps.
public struct CampaignsAnswer: Decodable, Sendable, Hashable {
    public struct Step: Decodable, Sendable, Hashable {
        public let event: String
        public let label: String
    }

    public struct Row: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { value }
        public let value: String
        public let installs: Int
        /// The installs the link brought: their first open was in that session.
        public let new: Int
        /// Installs at each of `steps`, in order.
        public let steps: [Int]
    }

    public let by: String
    public let windowDays: Int
    public let steps: [Step]
    public let rows: [Row]

    enum CodingKeys: String, CodingKey {
        case by, steps, rows
        case windowDays = "window_days"
    }
}

/// `GET /admin/apps/:app/attribution`: what Apple reports, aggregate only.
/// Postback copies (verified ones; `env=dev` reads Apple's test ones), and
/// App Store Connect's campaign reports.
public struct AttributionAnswer: Decodable, Sendable {
    /// A conversion value the catalog defines, and the event that sets it.
    public struct Milestone: Decodable, Sendable, Hashable {
        public let value: Int
        /// `low`, `medium` or `high`.
        public let coarse: String
        public let event: String
        public let `where`: [String: String]?
        public let label: String
        /// Whether reaching it ends the postback's window.
        public let lock: Bool
    }

    public struct Postbacks: Decodable, Sendable {
        public let campaigns: [Campaign]
        public let values: [Value]
        /// Copies that did not verify with Apple's keys, not counted.
        public let unverified: Int
    }

    /// One ad network's campaign, from first postbacks.
    public struct Campaign: Decodable, Sendable, Hashable {
        /// `skan` (SKAdNetwork) or `aak` (AdAttributionKit).
        public let kind: String
        public let adNetwork: String?
        public let sourceIdentifier: String?
        public let installs: Int
        public let redownloads: Int
        /// Installs after an ad was seen, not tapped.
        public let views: Int
        public let last: Date

        enum CodingKeys: String, CodingKey {
            case kind, installs, redownloads, views, last
            case adNetwork = "ad_network"
            case sourceIdentifier = "source_identifier"
        }

        /// The network as people know it: Meta for its SKAdNetwork ids.
        public var network: String {
            guard let id = adNetwork else { return "Unknown" }
            return Self.networks[id.lowercased()] ?? id
        }

        static let networks = [
            "v9wttpbfk9.skadnetwork": "Meta",
            "n38lu8286q.skadnetwork": "Meta",
            "cstr6suwn9.skadnetwork": "Google",
            "development.adattributionkit": "Apple test",
            "com.example": "Apple sample",
        ]
    }

    /// How many postbacks carried a value, in a window (`sequence` 0 is days 0 to 2).
    public struct Value: Decodable, Sendable, Hashable {
        public let sequence: Int
        /// Nil when Apple sent only a coarse value, or none for a small campaign.
        public let conversionValue: Int?
        public let coarseValue: String?
        public let n: Int

        enum CodingKeys: String, CodingKey {
            case sequence, n
            case conversionValue = "conversion_value"
            case coarseValue = "coarse_value"
        }
    }

    public struct AppStore: Decodable, Sendable {
        public struct Request: Decodable, Sendable, Hashable {
            public let createdAt: Date
            public let lastSync: Date?
            public let lastError: String?

            enum CodingKeys: String, CodingKey {
                case createdAt = "created_at"
                case lastSync = "last_sync"
                case lastError = "last_error"
            }
        }

        /// Whether the server has an App Store Connect key to import with.
        public let configured: Bool
        public let request: Request?
        /// `YYYY-MM-DD`, the last day Apple's numbers cover.
        public let latestDay: String?
        /// A row per `ct`: `campaign` (empty for none) and Apple's metrics
        /// (`impressions`, `page_views`, `first_downloads`, `proceeds_usd`...).
        public let campaigns: [[String: JSONValue]]

        enum CodingKeys: String, CodingKey {
            case configured, request, campaigns
            case latestDay = "latest_day"
        }
    }

    public let appStoreId: String?
    public let conversionValues: [Milestone]
    public let postbacks: Postbacks
    public let appstore: AppStore

    enum CodingKeys: String, CodingKey {
        case postbacks, appstore
        case appStoreId = "app_store_id"
        case conversionValues = "conversion_values"
    }

    /// A conversion value as the catalog names it: the highest milestone at
    /// or under it, `Installed` for 0.
    public func milestone(_ value: Int) -> String {
        if value == 0 { return "Installed" }
        return conversionValues.last { $0.value <= value }?.label ?? "Value \(value)"
    }
}

extension AdminClient {
    /// A campaign table: `by` one tag, narrowed to one `source`, through the
    /// catalog's `funnel` (its first open dropped) or the `steps` given.
    public func campaigns(_ slug: String, by: CampaignSplit, source: String? = nil, funnel: Int = 0,
                          steps: [StepQuery] = [], _ scope: Scope) async throws -> CampaignsAnswer {
        var q = scope.items
        q["by"] = by.rawValue
        if let source, by != .source { q["where"] = "utm_source:\(source)" }
        if steps.isEmpty { q["funnel"] = String(funnel) }
        var r = try request("GET", ["admin", "apps", slug, "campaigns"], query: q)
        r.url?.append(queryItems: steps.map { URLQueryItem(name: "step", value: $0.query) })
        return try await send(r)
    }

    /// Apple's numbers: not split by build channel, so the scope's channel is not sent.
    public func attribution(_ slug: String, _ scope: Scope) async throws -> AttributionAnswer {
        try await send("GET", ["admin", "apps", slug, "attribution"], query: ["days": String(scope.days), "env": scope.env.rawValue])
    }
}
