import Foundation
import Testing
@testable import Hush

private let threadKey = String(repeating: "k", count: 43)

/// A server with feedback: a ticket with an email gets a thread key; lists answer by install or by key.
private func feedbackServer() -> FakeServer {
    FakeServer { r in
        let body = r.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        switch r.url!.path {
        case "/v1/tickets" where body["email"] != nil:
            return (201, #"{"id":"901","created_at":"2026-10-05T10:00:00Z","status":"open","thread":"\#(threadKey)"}"#)
        case "/v1/tickets":
            return (201, #"{"id":"900","created_at":"2026-10-05T09:00:00Z","status":"open"}"#)
        case "/v1/tickets/list":
            return (200, #"{"tickets":[{"id":"900","kind":"issue","subject":null,"message":"Crashes","status":"answered","created_at":"2026-10-05T09:00:00.000Z","unread":true,"replies":[{"author":"support","body":"Fixed in 1.3","at":"2026-10-05T11:00:00Z"}]}]}"#)
        case "/v1/tickets/threads":
            return (200, #"{"tickets":[{"id":901,"kind":"feature","subject":"Widgets","message":"Please","status":"open","created_at":"2026-10-05T10:00:00Z","unread":false,"replies":[]}]}"#)
        default:
            return (200, #"{"ok":true,"accepted":0,"duplicate":0,"rejected":0}"#)
        }
    }
}

/// The rule the server and the App Privacy answers rest on.
private func noRequestJoinsInstallAndThread(_ server: FakeServer, install: String) {
    for r in server.requests {
        let text = r.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
        #expect(!(text.contains(install) && text.contains(threadKey)), "\(r.url!.path) carries the install id and a thread key")
    }
}

@Suite struct Feedback {
    @Test func `a ticket with an email leaves the install out, and keeps its thread key`() async throws {
        let storage = MemoryStorage(), server = feedbackServer()
        let client = makeClient(storage: storage, server: server)
        client.start()
        client.identify(rcId: "$RCAnonymousID:abc")
        let id = try await client.createTicket(kind: .feature, message: "Please", email: "ana@example.com", subject: "Widgets").get()
        #expect(id == "901")
        let body = try #require(server.bodies("/v1/tickets").first)
        #expect(body["install"] == nil && body["rc_id"] == nil)
        #expect(body["email"] as? String == "ana@example.com")
        #expect(storage.string("hush.threads.v1")?.contains(threadKey) == true)
        await client.flushQueued()
        #expect(!server.names().contains("ticket_opened"), "no event marks the moment of a ticket with an email")
    }

    @Test func `a ticket without an email goes with the install, and is tracked`() async throws {
        let server = feedbackServer()
        let client = makeClient(server: server)
        client.start()
        client.identify(rcId: "$RCAnonymousID:abc")
        _ = try await client.createTicket(kind: .issue, message: "Crashes").get()
        let body = try #require(server.bodies("/v1/tickets").first)
        #expect(body["install"] as? String == client.installationId)
        #expect(body["rc_id"] as? String == "$RCAnonymousID:abc")
        await client.flushQueued()
        #expect(server.names().contains("ticket_opened"))
    }

    @Test func `the list is two requests, by install and by key, merged newest first`() async throws {
        let server = feedbackServer()
        let client = makeClient(server: server)
        client.start()
        _ = try await client.createTicket(kind: .feature, message: "Please", email: "ana@example.com").get()
        let tickets = await client.listTickets()
        #expect(tickets.map(\.id) == ["901", "900"])
        #expect(tickets.last?.unread == true)
        #expect(tickets.last?.replies.first?.body == "Fixed in 1.3")
        #expect(server.bodies("/v1/tickets/list").first?["install"] as? String == client.installationId)
        #expect(server.bodies("/v1/tickets/threads").first?["threads"] as? [String] == [threadKey])
        noRequestJoinsInstallAndThread(server, install: client.installationId)
    }

    @Test func `a reply goes by the thread key on a ticket with an email, by the install otherwise`() async throws {
        let server = feedbackServer()
        let client = makeClient(server: server)
        client.start()
        _ = try await client.createTicket(kind: .feature, message: "Please", email: "ana@example.com").get()
        _ = try await client.replyToTicket("901", body: "Thanks").get()
        _ = try await client.replyToTicket("900", body: "Still crashes").get()
        let replies = server.requests.filter { $0.url!.path.hasSuffix("/reply") }
        #expect(replies.map(\.url!.path) == ["/v1/tickets/901/reply", "/v1/tickets/900/reply"])
        let bodies = replies.compactMap { $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
        #expect(bodies[0]["thread"] as? String == threadKey && bodies[0]["install"] == nil)
        #expect(bodies[1]["install"] as? String == client.installationId && bodies[1]["thread"] == nil)
        noRequestJoinsInstallAndThread(server, install: client.installationId)
    }

    @Test func `a closed thread, too many, and offline are said so`() async {
        for (status, expected) in [(409, HushFailure.closed), (429, .tooMany), (0, .offline), (500, .failed)] {
            let client = makeClient(server: FakeServer { _ in (status, "{}") })
            client.start()
            #expect(await client.replyToTicket("900", body: "x").failure == expected)
        }
    }

    @Test func `without a key there is no feedback either`() async {
        let client = makeClient(key: "")
        #expect(await client.createTicket(kind: .love, message: "x") == .failure(.unavailable))
    }
}

@Suite struct Forgetting {
    @Test func `forget deletes the email tickets by key, then the install, and starts over`() async throws {
        let storage = MemoryStorage(), server = feedbackServer()
        let client = makeClient(storage: storage, server: server)
        client.start()
        _ = try await client.createTicket(kind: .feature, message: "Please", email: "ana@example.com").get()
        client.track("onboarding_completed", once: true)
        let before = client.installationId
        _ = try await client.forget().get()

        let forgets = server.bodies("/v1/forget")
        #expect(forgets.count == 2)
        #expect(forgets[0]["threads"] as? [String] == [threadKey] && forgets[0]["install"] == nil)
        #expect(forgets[1]["install"] as? String == before && forgets[1]["threads"] == nil)
        #expect(client.installationId != before && !client.installationId.isEmpty)
        #expect(storage.string("hush.install.v1") == client.installationId)
        #expect(storage.string("hush.threads.v1")?.contains(threadKey) != true)
        noRequestJoinsInstallAndThread(server, install: before)

        // A fresh start: the once-event may be sent again, and no new install is counted.
        client.track("onboarding_completed", once: true)
        await client.flushQueued()
        let after = server.events.filter { $0["install"] as? String == client.installationId }.compactMap { $0["name"] as? String }
        #expect(after.contains("onboarding_completed"))
        #expect(!after.contains("app_first_opened"))
    }

    @Test func `offline: nothing is lost, and the install stays`() async {
        let client = makeClient(server: FakeServer { _ in (0, "") })
        client.start()
        let before = client.installationId
        #expect(await client.forget().failure == .offline)
        #expect(client.installationId == before)
    }
}
