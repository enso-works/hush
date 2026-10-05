import HushKit
import Observation
import SwiftUI

/// One server's feedback: the list the Feedback tab shows, its filters, and
/// the changes made from a thread, so the list follows without a reload.
@Observable
final class Inbox {
    let serverID: UUID
    private let client: AdminClient

    /// What the list shows. Changing it reloads (the view's task).
    var query = TicketQuery(status: .open)
    private(set) var tickets: [TicketSummary] = []
    private(set) var counts: TicketPage.Counts?
    private(set) var more = false
    private(set) var loaded = false
    var error: HushError?
    /// Open feedback on the whole server, for the tab's badge: the count from
    /// the last list without an app, kind or search filter.
    private(set) var openTotal = 0
    /// A server from before October 2026 filters by status and kind only;
    /// for it the whole list comes at once and is filtered here.
    private var older = false
    private var loadingMore = false

    private static let pageSize = 50

    init(serverID: UUID, client: AdminClient) {
        self.serverID = serverID
        self.client = client
    }

    func load() async {
        do {
            let page = try await fetch(offset: 0)
            tickets = page.tickets
            counts = page.counts
            more = page.more
            if query.kind == nil, query.app == nil, (query.search ?? "").isEmpty, let open = page.counts?.open { openTotal = open }
            loaded = true
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = HushError(error)
            loaded = true
        }
    }

    /// The next page, when the last row shows.
    func loadMore() async {
        guard more, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await fetch(offset: tickets.count)
            // A ticket that moved up between the pages would show twice.
            let seen = Set(tickets.map(\.id))
            tickets += page.tickets.filter { !seen.contains($0.id) }
            more = page.more
        } catch {
            self.error = HushError(error)
        }
    }

    private func fetch(offset: Int) async throws -> TicketPage {
        if older { return try await everything() }
        var q = query
        q.limit = Self.pageSize
        q.offset = offset
        let page = try await client.tickets(q)
        guard page.counts == nil else { return page }
        older = true
        return try await everything()
    }

    private func everything() async throws -> TicketPage {
        try await client.tickets(TicketQuery(limit: 200)).filtered(by: query)
    }

    // MARK: - Changes made from a thread

    func ticket(_ id: ServerID) async throws -> Ticket {
        try await client.ticket(id)
    }

    func reply(_ id: ServerID, body: String, close: Bool) async throws -> ReplyResult {
        let result = try await client.reply(to: id, body: body, close: close)
        replied(id, closed: close)
        return result
    }

    func setStatus(_ id: ServerID, _ status: TicketStatus) async throws {
        try await client.setStatus(id, status)
        changed(id) { $0.status = status }
    }

    func delete(_ id: ServerID) async throws {
        try await client.delete(id)
        if let gone = tickets.first(where: { $0.id == id }) { recount(from: gone.status, to: nil) }
        tickets.removeAll { $0.id == id }
    }

    /// After a reply sent from the thread: answered, or closed with it.
    private func replied(_ id: ServerID, closed: Bool) {
        changed(id) {
            $0.status = closed ? .closed : .answered
            $0.replies += 1
            $0.updatedAt = .now
        }
    }

    /// A row that no longer matches the status shown leaves the list, and
    /// the counts move with it.
    private func changed(_ id: ServerID, _ change: (inout TicketSummary) -> Void) {
        guard let i = tickets.firstIndex(where: { $0.id == id }) else { return }
        let before = tickets[i].status
        change(&tickets[i])
        recount(from: before, to: tickets[i].status)
        if let status = query.status, tickets[i].status != status { tickets.remove(at: i) }
    }

    private func recount(from old: TicketStatus, to new: TicketStatus?) {
        guard old != new else { return }
        // The ticket changed on the server whatever the list's filters.
        if old == .open { openTotal = max(0, openTotal - 1) }
        if new == .open { openTotal += 1 }
        guard var c = counts else { return }
        func add(_ status: TicketStatus, _ n: Int) {
            switch status {
            case .open: c.open += n
            case .answered: c.answered += n
            case .closed: c.closed += n
            case .other: break
            }
        }
        add(old, -1)
        if let new { add(new, 1) }
        counts = c
    }
}
