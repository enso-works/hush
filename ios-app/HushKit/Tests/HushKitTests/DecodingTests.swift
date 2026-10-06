import Foundation
import Testing
@testable import HushKit

// The fixtures are the demo's own answers (hush.bavrk.com/demo/admin/...), so
// these decode what a server really sends.
func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try HushJSON.decoder.decode(T.self, from: fixture(name))
}

@Test func session() throws {
    #expect(try decode(SessionInfo.self, "session").demo)
}

@Test func apps() throws {
    let answer = try decode(AppsAnswer.self, "apps")
    #expect(answer.apps.map(\.app) == ["pace", "stillwater", "tally"])
    #expect(answer.installRetentionDays == 180)
    let pace = try #require(answer.apps.first)
    #expect(pace.trend?.count == 30)
    #expect(pace.lastEvent != nil)
}

@Test func appDetail() throws {
    let detail = try decode(AppDetail.self, "app")
    #expect(detail.app == "stillwater")
    #expect(detail.channel == nil)
    #expect(detail.daily.count == 30)
    #expect(detail.highlight?.event == "meditation_completed")
    #expect(detail.retention.d30.rate == nil) // no install is 30 days old in a 30-day demo
    #expect(detail.engagement?.sessionsHistogram.count == 5)
}

@Test func ticketList() throws {
    let page = try HushJSON.decoder.decode(TicketPage.self, from: fixture("tickets"))
    #expect(!page.tickets.isEmpty)
    // A ticket with an email is never linked to an install.
    for t in page.tickets where t.email != nil {
        #expect(t.install == nil && t.rcId == nil)
    }
    // The fixture is an older server's answer: everything at once, no counts.
    #expect(page.counts == nil && !page.more)
}

@Test func anOlderServersListIsFilteredHereAsTheServerWould() throws {
    let page = try HushJSON.decoder.decode(TicketPage.self, from: fixture("tickets"))
    let app = try #require(page.tickets.first).app
    let open = page.filtered(by: TicketQuery(status: .open, app: app))
    #expect(open.tickets.allSatisfy { $0.status == .open && $0.app == app })
    let counts = try #require(open.counts)
    #expect(counts.all == page.tickets.filter { $0.app == app }.count, "the counts ignore the status")
    #expect(counts.open == open.tickets.count)
    let one = try #require(page.tickets.last)
    #expect(page.filtered(by: TicketQuery(search: "#\(one.id)")).tickets.map(\.id) == [one.id])
    #expect(page.filtered(by: TicketQuery(search: "nothing-like-this")).tickets.isEmpty)
}

@Test func ticketThread() throws {
    let ticket = try decode(Ticket.self, "ticket")
    #expect(ticket.id == "139")
    #expect(ticket.status == .answered)
    #expect(ticket.replies.first?.author == .support)
    #expect(ticket.diag?["version"] == .string("1.4.0"))
}

@Test(arguments: [
    "2026-10-04T14:09:17.300Z",
    "2026-10-03T19:09:17.3+00:00",
    "2026-10-04T14:09:17Z",
    "2026-10-04T16:09:17.123456+02:00",
])
func dates(_ s: String) throws {
    let date = try #require(HushJSON.parseDate(s))
    #expect(abs(date.timeIntervalSince1970 - 1_791_123_000) < 200_000)
}

@Test func unknownValuesFromANewerServerSurvive() throws {
    let json = Data(#"{"id": 7, "app": "x", "kind": "praise", "install": null, "rc_id": null, "email": null, "subject": null, "status": "snoozed", "created_at": "2026-10-04T14:09:17Z", "updated_at": "2026-10-04T14:09:17Z", "preview": "", "replies": 0}"#.utf8)
    let t = try HushJSON.decoder.decode(TicketSummary.self, from: json)
    #expect(t.id == "7")
    #expect(t.kind == .other("praise"))
    #expect(t.status.rawValue == "snoozed")
}
