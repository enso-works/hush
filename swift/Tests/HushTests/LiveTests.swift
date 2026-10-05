import Foundation
import Testing
@testable import Hush

/// Against a real hush server, over real HTTP. Off unless HUSH_E2E_URL,
/// HUSH_E2E_KEY (a write key) and HUSH_E2E_ADMIN (its admin token) are set:
///   HUSH_E2E_URL=http://127.0.0.1:3077 HUSH_E2E_KEY=hush_… HUSH_E2E_ADMIN=… swift test --filter Live
@Suite(.enabled(if: ProcessInfo.processInfo.environment["HUSH_E2E_URL"] != nil))
struct Live {
    let env = ProcessInfo.processInfo.environment

    func admin(_ path: String) async throws -> [String: Any] {
        var r = URLRequest(url: URL(string: env["HUSH_E2E_URL"]! + path)!)
        r.setValue("Bearer \(env["HUSH_E2E_ADMIN"]!)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: r)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    @Test func `events, feedback with and without an email, a reply and forget, as the server stores them`() async throws {
        let client = HushClient(storage: MemoryStorage(), transport: SessionTransport(session: .shared),
                                schedule: { _, _ in }, device: { testDevice }, isDebug: false)
        client.configure(url: env["HUSH_E2E_URL"]!, key: env["HUSH_E2E_KEY"]!, channel: "internal")
        client.start()
        client.track("onboarding_completed", ["goal": "focus"], once: true)
        client.screen("Home")
        let results = Results()
        client.configure(url: env["HUSH_E2E_URL"]!, key: env["HUSH_E2E_KEY"]!, channel: "internal", onFlush: { results.add($0) })
        await client.flushQueued()
        let sent = try #require(results.all.last)
        #expect(sent.status == 200 && sent.rejected == 0, "the server took every event: \(sent)")

        let install = try await admin("/admin/installs/\(client.installationId)")
        let names = (install["events"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        #expect(Set(names).isSuperset(of: ["app_first_opened", "session_started", "onboarding_completed", "screen_viewed"]))
        let row = try #require(install["install"] as? [String: Any])
        #expect(row["sdk"] as? String == "swift-0.1.0")
        #expect(row["channel"] as? String == "internal")
        #expect(row["device"] as? String == "iPhone15,2")

        let own = try await client.createTicket(kind: .issue, message: "From the Swift SDK's live test").get()
        let mailed = try await client.createTicket(kind: .feature, message: "With an email", email: "live@example.com").get()
        _ = try await client.replyToTicket(mailed, body: "A reply by thread key").get()
        let tickets = await client.listTickets()
        #expect(Set(tickets.map(\.id)) == [own, mailed])

        let stored = try await admin("/admin/tickets/\(mailed)")
        #expect(stored["install"] is NSNull, "a ticket with an email is not linked to the install")
        #expect(stored["email"] as? String == "live@example.com")

        _ = try await client.forget().get()
        let gone = try await admin("/admin/tickets/\(mailed)")
        #expect(gone["error"] as? String == "not found")
    }
}
