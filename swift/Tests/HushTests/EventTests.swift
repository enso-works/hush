import Foundation
import Testing
@testable import Hush

@Suite struct Launches {
    @Test func `the first launch sends app_first_opened and a first session`() async throws {
        let server = FakeServer()
        let client = makeClient(server: server)
        client.start()
        await client.flushQueued()

        #expect(server.names() == ["app_first_opened", "session_started"])
        let batch = try #require(server.bodies("/v1/events").first)
        #expect(batch["sdk"] as? String == "swift-0.1.0")
        let context = try #require(batch["context"] as? [String: Any])
        #expect(context["platform"] as? String == "ios")
        #expect(context["os"] as? String == "ios 18.6")
        #expect(context["device"] as? String == "iPhone15,2")
        #expect(context["pro"] == nil, "no paid flag until identify()")
        let session = try #require(server.events.last)
        #expect(session.props()["entry"] as? String == "launch")
        #expect(session.props()["n"] as? Int == 1)
        let install = try #require(session["install"] as? String)
        #expect(install == install.lowercased() && UUID(uuidString: install) != nil)
        #expect(server.requests.first?.value(forHTTPHeaderField: "Authorization") == "Key hush_test_dev_x")
        #expect(server.requests.first?.url?.absoluteString == "https://hush.example.com/v1/events")
    }

    @Test func `a later launch numbers its session and reports the last one's time in the foreground`() async throws {
        let storage = MemoryStorage(), clock = Clock()
        let first = makeClient(storage: storage, clock: clock)
        first.start()
        clock.advance(120)
        first.appState(.background)

        let server = FakeServer()
        let second = makeClient(storage: storage, server: server, clock: clock)
        second.start()
        await second.flushQueued()
        // The first launch's unsent events went to disk as it left, and go out now.
        #expect(server.names().filter { $0 == "app_first_opened" }.count == 1, "no second app_first_opened")
        let props = try #require(server.events.last { $0["name"] as? String == "session_started" }).props()
        #expect(props["n"] as? Int == 2)
        #expect(props["prev_fg_s"] as? Int == 120)
        #expect(first.installationId == second.installationId)
    }

    @Test func `a return after thirty minutes away is a new session`() async throws {
        let server = FakeServer(), clock = Clock()
        let client = makeClient(server: server, clock: clock)
        client.start()
        client.appState(.background)
        clock.advance(10 * 60)
        client.appState(.active)
        clock.advance(5)
        client.appState(.background)
        clock.advance(31 * 60)
        client.appState(.active)
        await client.flushQueued()
        let sessions = server.events.filter { $0["name"] as? String == "session_started" }
        #expect(sessions.map { $0.props()["n"] as? Int } == [1, 2])
        #expect(sessions[0]["session"] as? String != sessions[1]["session"] as? String)
    }

    @Test func `nothing is sent without a key`() async {
        let server = FakeServer()
        let client = makeClient(server: server, key: "")
        client.start()
        client.track("onboarding_completed")
        await client.flushQueued()
        #expect(server.requests.isEmpty)
        #expect(client.installationId.isEmpty)
    }
}

@Suite struct Events {
    @Test func `props, global props and an event's own winning`() async throws {
        let server = FakeServer()
        let client = makeClient(server: server)
        client.setGlobalProps(["variant": "b", "plan": "free"])
        client.start()
        client.track("paywall_viewed", ["plan": "pro", "price": 4.99, "trial": true, "coupon": nil])
        await client.flushQueued()
        let props = try #require(server.events.first { $0["name"] as? String == "paywall_viewed" }).props()
        #expect(props["variant"] as? String == "b")
        #expect(props["plan"] as? String == "pro")
        #expect(props["price"] as? Double == 4.99)
        #expect(props["trial"] as? Bool == true)
        #expect(props["coupon"] is NSNull)
    }

    @Test(arguments: ["Onboarding", "a", "has space", "x-y", String(repeating: "a", count: 65)])
    func `a name the server would refuse is dropped here`(_ name: String) async {
        let server = FakeServer()
        let client = makeClient(server: server)
        client.start()
        client.track(name)
        await client.flushQueued()
        #expect(!server.names().contains(name))
    }

    @Test func `once means once per install, across launches`() async {
        let storage = MemoryStorage(), server = FakeServer()
        let first = makeClient(storage: storage, server: server)
        first.start()
        first.track("onboarding_completed", once: true)
        first.track("onboarding_completed", once: true)
        first.track("tip_seen", onceKey: "v2")
        first.track("tip_seen", onceKey: "v3")
        await first.flushQueued()
        let second = makeClient(storage: storage, server: server)
        second.start()
        second.track("onboarding_completed", once: true)
        await second.flushQueued()
        #expect(server.names().filter { $0 == "onboarding_completed" }.count == 1)
        #expect(server.names().filter { $0 == "tip_seen" }.count == 2)
    }

    @Test func `identify puts the paid flag and RevenueCat's id on the batch`() async throws {
        let server = FakeServer()
        let client = makeClient(server: server)
        client.start()
        client.identify(pro: true, rcId: "$RCAnonymousID:abc")
        client.track("purchase_result", ["result": "purchased"])
        await client.flushQueued()
        let context = try #require(server.bodies("/v1/events").last?["context"] as? [String: Any])
        #expect(context["pro"] as? Bool == true)
        #expect(context["rc_id"] as? String == "$RCAnonymousID:abc")
    }

    @Test func `a screen is screen_viewed`() async {
        let server = FakeServer()
        let client = makeClient(server: server)
        client.start()
        client.screen("Settings")
        await client.flushQueued()
        #expect(server.events.contains { $0["name"] as? String == "screen_viewed" && $0.props()["screen"] as? String == "Settings" })
    }
}

@Suite struct Entries {
    @Test func `a link claims the new session, keeping only its campaign tags`() async throws {
        let server = FakeServer()
        let client = makeClient(server: server)
        client.start()
        client.entry(.link, url: "https://app.example.com/open?utm_source=meta&utm_campaign=autumn&email=a@b.c&ref=friend")
        await client.flushQueued()
        let props = try #require(server.events.first { $0["name"] as? String == "session_started" }).props()
        #expect(props["entry"] as? String == "link")
        #expect(props["utm_source"] as? String == "meta")
        #expect(props["utm_campaign"] as? String == "autumn")
        #expect(props["ref"] as? String == "friend")
        #expect(props["email"] == nil, "nothing but campaign tags from a URL")
    }

    @Test func `an entry made before start waits for the session`() async throws {
        let server = FakeServer()
        let client = makeClient(server: server)
        client.entry(.notification)
        client.start()
        await client.flushQueued()
        #expect(try #require(server.events.first { $0["name"] as? String == "session_started" }).props()["entry"] as? String == "notification")
    }
}

@Suite struct Channels {
    @Test func `dev in a debug build, as given otherwise, and never a malformed one`() async throws {
        for (channel, debug, expected) in [(nil, true, "dev"), ("internal", true, "internal"), ("Not OK", false, nil)] as [(String?, Bool, String?)] {
            let server = FakeServer()
            let client = makeClient(server: server, channel: channel, debug: debug)
            client.start()
            await client.flushQueued()
            let context = try #require(server.bodies("/v1/events").first?["context"] as? [String: Any])
            #expect(context["channel"] as? String == expected)
        }
    }
}

@Suite struct Delivery {
    @Test func `a server error keeps the batch for later; a refusal drops it`() async throws {
        let failing = makeClient(server: FakeServer { _ in (503, "{}") })
        failing.start()
        await failing.flushQueued()
        #expect(failing.withState { $0.queue.count } == 2)
        #expect(failing.withState { $0.failures } == 1)

        let results = Results()
        let refused = HushClient(storage: MemoryStorage(), transport: FakeServer { _ in (400, #"{"error":"events"}"#) },
                                 schedule: { _, _ in }, device: { testDevice }, isDebug: false)
        refused.configure(url: "https://hush.example.com", key: "k", onFlush: { results.add($0) })
        refused.start()
        await refused.flushQueued()
        #expect(refused.withState { $0.queue.isEmpty })
        let result = try #require(results.all.first)
        #expect(result.status == 400 && result.rejected == 2 && !result.willRetry)
    }

    @Test func `offline: the queue waits, and goes to disk`() async {
        let storage = MemoryStorage()
        let client = makeClient(storage: storage, server: FakeServer { _ in (0, "") })
        client.start()
        client.track("onboarding_completed")
        client.appState(.background)
        try? await Task.sleep(nanoseconds: 50_000_000)
        let stored = storage.string("hush.queue.v1") ?? ""
        #expect(stored.contains("onboarding_completed"))
        #expect(stored.contains("session_started"))
    }
}

@Suite struct Choices {
    @Test func `opting out drops what is queued, sends nothing, and is remembered`() async {
        let storage = MemoryStorage(), server = FakeServer()
        let client = makeClient(storage: storage, server: server)
        client.start()
        client.track("onboarding_completed")
        client.optOut()
        client.track("paywall_viewed")
        await client.flushQueued()
        #expect(server.requests.isEmpty)

        let next = makeClient(storage: storage, server: server)
        next.start()
        #expect(next.isOptedOut)
        next.optIn()
        await next.flushQueued()
        #expect(server.names() == ["session_started"])
    }
}
