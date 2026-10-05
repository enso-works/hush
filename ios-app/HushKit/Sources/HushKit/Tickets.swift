import Foundation

/// Which tickets to list: every filter `GET /admin/tickets` takes.
public struct TicketQuery: Sendable, Hashable {
    /// Nil lists every status.
    public var status: TicketStatus?
    public var kind: TicketKind?
    /// An app's slug.
    public var app: String?
    /// Matches the subject, the message, the email, a reply, or `#id`.
    public var search: String?
    public var limit: Int
    public var offset: Int

    public init(status: TicketStatus? = nil, kind: TicketKind? = nil, app: String? = nil, search: String? = nil,
                limit: Int = 50, offset: Int = 0) {
        self.status = status
        self.kind = kind
        self.app = app
        self.search = search
        self.limit = limit
        self.offset = offset
    }

    var items: [String: String] {
        var q = ["limit": String(limit)]
        q["status"] = status?.rawValue
        q["kind"] = kind?.rawValue
        q["app"] = app
        q["q"] = search?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if offset > 0 { q["offset"] = String(offset) }
        return q
    }

    /// Whether a ticket matches, the way the server decides: for a server
    /// that only filters by status and kind.
    public func matches(_ t: TicketSummary) -> Bool {
        if let status, t.status != status { return false }
        if let kind, t.kind != kind { return false }
        if let app, t.app != app { return false }
        guard let text = search?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty else { return true }
        if t.id.value == text.trimmingPrefix("#") { return true }
        return [t.subject, t.preview, t.email].contains { $0?.localizedCaseInsensitiveContains(text) == true }
    }
}

/// One page of `GET /admin/tickets`.
public struct TicketPage: Decodable, Sendable {
    public struct Counts: Decodable, Sendable, Hashable {
        public var open: Int
        public var answered: Int
        public var closed: Int

        public init(open: Int = 0, answered: Int = 0, closed: Int = 0) {
            self.open = open
            self.answered = answered
            self.closed = closed
        }

        public subscript(status: TicketStatus) -> Int {
            switch status {
            case .open: open
            case .answered: answered
            case .closed: closed
            case .other: 0
            }
        }

        public var all: Int { open + answered + closed }
    }

    public var tickets: [TicketSummary]
    /// Whether a next page exists.
    public var more: Bool
    /// Each status's count under the same app, kind and search; nil from a
    /// server from before October 2026.
    public var counts: Counts?

    public init(tickets: [TicketSummary], more: Bool = false, counts: Counts? = nil) {
        self.tickets = tickets
        self.more = more
        self.counts = counts
    }

    enum CodingKeys: String, CodingKey { case tickets, more, counts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tickets = try c.decode([TicketSummary].self, forKey: .tickets)
        more = try c.decodeIfPresent(Bool.self, forKey: .more) ?? false
        counts = try c.decodeIfPresent(Counts.self, forKey: .counts)
    }

    /// An older server's whole answer, filtered and counted here as the
    /// server would: the status counts ignore the status filter.
    public func filtered(by query: TicketQuery) -> TicketPage {
        var unfiltered = query
        unfiltered.status = nil
        let pool = tickets.filter(unfiltered.matches)
        var counts = Counts()
        for t in pool {
            switch t.status {
            case .open: counts.open += 1
            case .answered: counts.answered += 1
            case .closed: counts.closed += 1
            case .other: break
            }
        }
        return TicketPage(tickets: pool.filter(query.matches), more: false, counts: counts)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
