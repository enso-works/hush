import Foundation

/// `GET /admin/apps/:app/web`: a website's page. Visitors and visits rather
/// than installs and sessions; where they came from, the page each visit began
/// on, the device, and how many visits reached the site's goal (a store click
/// unless the catalog names another).
public struct WebReport: Decodable, Sendable {
    public struct Goal: Decodable, Sendable, Hashable {
        public let event: String
    }

    public struct Totals: Decodable, Sendable, Hashable {
        public let visitors: Int
        public let newVisitors: Int
        public let visits: Int
        /// Visits with more than a glance: a second page, a click, or ten seconds in view.
        public let engaged: Int
        public let pageviews: Int
        public let goalVisits: Int
        public let goalVisitors: Int

        enum CodingKeys: String, CodingKey {
            case visitors, visits, engaged, pageviews
            case newVisitors = "new_visitors"
            case goalVisits = "goal_visits"
            case goalVisitors = "goal_visitors"
        }
    }

    public struct Day: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { day }
        /// `YYYY-MM-DD`.
        public let day: String
        public let visitors: Int
        public let newVisitors: Int
        public let visits: Int
        public let goalVisits: Int

        enum CodingKeys: String, CodingKey {
            case day, visitors, visits
            case newVisitors = "new_visitors"
            case goalVisits = "goal_visits"
        }
    }

    /// One row of a split (a source, a campaign, a landing page, a device):
    /// its visits, how many were engaged, how many reached the goal.
    public struct Split: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { "\(label) \(detail ?? "")" }
        /// The source, campaign, page or device.
        public let label: String
        /// A source's kind (`tag`, `referrer`, `direct`), or a campaign's source.
        public let detail: String?
        public let visits: Int
        public let engaged: Int
        public let goalVisits: Int

        enum CodingKeys: String, CodingKey {
            case source, campaign, page, device, kind, visits, engaged
            case goalVisits = "goal_visits"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let campaign = try c.decodeIfPresent(String.self, forKey: .campaign)
            let source = try c.decodeIfPresent(String.self, forKey: .source)
            label = try campaign ?? source ?? c.decodeIfPresent(String.self, forKey: .page) ?? c.decode(String.self, forKey: .device)
            detail = campaign != nil ? source : try c.decodeIfPresent(String.self, forKey: .kind)
            visits = try c.decode(Int.self, forKey: .visits)
            engaged = try c.decode(Int.self, forKey: .engaged)
            goalVisits = try c.decode(Int.self, forKey: .goalVisits)
        }
    }

    public struct Page: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { page }
        public let page: String
        public let views: Int
        public let visitors: Int
    }

    public struct Country: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { country }
        public let country: String
        public let visitors: Int
    }

    /// Clicks to a store (`app_store`, `play`, `testflight`) or another site, by host.
    public struct Click: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { value }
        public let value: String
        public let clicks: Int
        public let visitors: Int
    }

    public struct Event: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { name }
        public let name: String
        public let known: Bool
        public let n: Int
        public let visitors: Int
    }

    public let app: String
    public let goal: Goal
    public let current: Totals
    public let prior: Totals
    public let daily: [Day]
    public let sources: [Split]
    public let campaigns: [Split]
    public let landing: [Split]
    public let pages: [Page]
    public let devices: [Split]
    public let countries: [Country]
    public let stores: [Click]
    public let links: [Click]
    /// The site's own events, beyond pages and clicks.
    public let events: [Event]
    /// A shop's orders and revenue; nil for a site whose goal carries no
    /// amount, and from a server before webshops.
    public let revenue: Revenue?

    /// Orders and revenue for the period against the one before, by source and
    /// by campaign. Each order counts for the visitor's last visit, within
    /// `lookbackDays` before it, that came from a tagged link or another site.
    public struct Revenue: Decodable, Sendable, Hashable {
        /// One source or campaign: its orders and revenue in one currency.
        public struct Row: Decodable, Sendable, Hashable, Identifiable {
            public var id: String { "\(label) \(detail ?? "") \(currency)" }
            /// The source (`direct` when none), or the campaign.
            public let label: String
            /// A campaign's source; nil for a source.
            public let detail: String?
            public let currency: String
            public let orders: Int
            public let revenue: Double

            enum CodingKeys: String, CodingKey {
                case source, campaign, currency, orders, revenue
            }

            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                let campaign = try c.decodeIfPresent(String.self, forKey: .campaign)
                let source = try c.decode(String.self, forKey: .source)
                label = campaign ?? source
                detail = campaign != nil ? source : nil
                currency = try c.decode(String.self, forKey: .currency)
                orders = try c.decode(Int.self, forKey: .orders)
                revenue = try c.decode(Double.self, forKey: .revenue)
            }
        }

        public let lookbackDays: Int
        public let current: [OrderTotal]
        public let prior: [OrderTotal]
        public let sources: [Row]
        public let campaigns: [Row]

        enum CodingKeys: String, CodingKey {
            case current, prior, sources, campaigns
            case lookbackDays = "lookback_days"
        }
    }
}

/// A shop's orders in one currency: how many, and what they came to.
public struct OrderTotal: Decodable, Sendable, Hashable, Identifiable {
    public var id: String { currency }
    /// An ISO code such as `EUR`, or whatever the site sent; empty when none.
    public let currency: String
    public let orders: Int
    public let revenue: Double

    public init(currency: String, orders: Int, revenue: Double) {
        self.currency = currency
        self.orders = orders
        self.revenue = revenue
    }
}

/// `GET /admin/apps/:app/websites`: the websites that sell an app, and their
/// App Store clicks by campaign beside what App Store Connect counted for the
/// same campaign (`ct`). Two counts side by side, never the same people.
public struct WebsitesForApp: Decodable, Sendable {
    public struct Site: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { app }
        public let app: String
        public let name: String
        public let visitors: Int
        public let visits: Int
        public let storeClicks: Int
        public let storeVisits: Int

        enum CodingKeys: String, CodingKey {
            case app, name, visitors, visits
            case storeClicks = "store_clicks"
            case storeVisits = "store_visits"
        }
    }

    public struct Campaign: Decodable, Sendable, Hashable, Identifiable {
        public var id: String { campaign }
        /// Empty for clicks from a visit without one.
        public let campaign: String
        public let storeClicks: Int
        public let visits: Int
        public let appStore: AppStore?

        public struct AppStore: Decodable, Sendable, Hashable {
            public let pageViews: Double?
            public let firstDownloads: Double?

            enum CodingKeys: String, CodingKey {
                case pageViews = "page_views"
                case firstDownloads = "first_downloads"
            }
        }

        enum CodingKeys: String, CodingKey {
            case campaign, visits
            case storeClicks = "store_clicks"
            case appStore = "app_store"
        }
    }

    public let websites: [Site]
    public let campaigns: [Campaign]
}

extension AdminClient {
    /// A website's page for the scope.
    public func web(_ slug: String, _ scope: Scope) async throws -> WebReport {
        try await send("GET", ["admin", "apps", slug, "web"], query: scope.items)
    }

    /// The websites that sell an app; not split by build channel.
    public func websites(_ slug: String, _ scope: Scope) async throws -> WebsitesForApp {
        try await send("GET", ["admin", "apps", slug, "websites"], query: ["days": String(scope.days), "env": scope.env.rawValue])
    }
}
