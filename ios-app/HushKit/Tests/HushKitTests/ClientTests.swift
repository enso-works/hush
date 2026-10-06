import Foundation
import Testing
@testable import HushKit

/// Answers every request of a test's URLSession with what the test says, and
/// keeps the requests it saw.
final class Stub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, Data)
    // One test at a time touches these: the suite below is serialized.
    nonisolated(unsafe) static var handler: Handler = { _ in (200, Data("{}".utf8)) }
    nonisolated(unsafe) static var seen: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var r = request
        // URLSession moves a body into a stream before a protocol sees it.
        if r.httpBody == nil, let stream = r.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            r.httpBody = data
        }
        Stub.seen.append(r)
        do {
            let (status, body) = try Stub.handler(r)
            let response = HTTPURLResponse(url: r.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    static func client(_ connection: Connection = Connection(baseURL: URL(string: "https://hush.example.com")!, token: "t0ken"),
                       _ handler: @escaping Handler) -> AdminClient {
        Stub.handler = handler
        Stub.seen = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        return AdminClient(connection, session: URLSession(configuration: config))
    }
}

@Suite(.serialized) struct ClientTests {
    @Test func readsWithTheTokenAndTheQuery() async throws {
        let client = Stub.client { _ in (200, try fixture("apps")) }
        let answer = try await client.apps(days: 7, env: .dev)
        #expect(answer.apps.count == 3)
        let r = try #require(Stub.seen.first)
        #expect(r.httpMethod == "GET")
        #expect(r.url?.absoluteString == "https://hush.example.com/admin/apps?days=7&env=dev")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer t0ken")
        #expect(r.value(forHTTPHeaderField: "Content-Type") == nil)
    }

    @Test func sessionGoesWithoutTheToken() async throws {
        let client = Stub.client { _ in (200, try fixture("session")) }
        #expect(try await client.session().demo)
        #expect(Stub.seen.first?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func aPrefixAndAProxyHeaderAreKept() async throws {
        let connection = Connection(baseURL: URL(string: "https://example.com/hush")!, headers: ["X-Ops": "s3cret"])
        let client = Stub.client(connection) { _ in (200, try fixture("app")) }
        _ = try await client.app("stillwater", channel: "app_store")
        let r = try #require(Stub.seen.first)
        #expect(r.url?.absoluteString == "https://example.com/hush/admin/apps/stillwater?channel=app_store&days=30&env=prod")
        #expect(r.value(forHTTPHeaderField: "X-Ops") == "s3cret")
        #expect(r.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func aSlugCannotAddAPathSegment() async throws {
        let client = Stub.client { _ in (404, Data(#"{"error":"not found"}"#.utf8)) }
        await #expect(throws: HushError.notFound) { try await client.app("../tickets") }
        let path = try #require(Stub.seen.first?.url?.absoluteString)
        #expect(path.hasPrefix("https://hush.example.com/admin/apps/..%2Ftickets"))
    }

    @Test func writesAreJSON() async throws {
        let client = Stub.client { _ in (200, Data(#"{"ok":true,"emailed":true}"#.utf8)) }
        let result = try await client.reply(to: "139", body: "Thanks!", close: true)
        #expect(result.emailed == true)
        let r = try #require(Stub.seen.first)
        #expect(r.httpMethod == "POST")
        #expect(r.url?.path() == "/admin/tickets/139/reply")
        #expect(r.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try JSONSerialization.jsonObject(with: try #require(r.httpBody)) as? [String: Any]
        #expect(body?["body"] as? String == "Thanks!")
        #expect(body?["close"] as? Bool == true)
    }

    @Test func aTicketQueryIsTheServersFilters() async throws {
        let client = Stub.client { _ in (200, Data(#"{"tickets":[],"more":true,"counts":{"open":3,"answered":1,"closed":0}}"#.utf8)) }
        let page = try await client.tickets(TicketQuery(status: .open, kind: .feature, app: "braele", search: " 100% ", limit: 20, offset: 40))
        #expect(page.more)
        #expect(page.counts == TicketPage.Counts(open: 3, answered: 1, closed: 0))
        let url = try #require(Stub.seen.first?.url)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                == ["status": "open", "kind": "feature", "app": "braele", "q": "100%", "limit": "20", "offset": "40"])
        _ = try await client.tickets()
        #expect(Stub.seen.last?.url?.query() == "limit=50", "no status lists every status")
    }

    @Test func insightsTakeTheScope() async throws {
        let client = Stub.client { _ in (200, Data(#"{"window_days":3,"steps":[]}"#.utf8)) }
        let scope = Scope(days: 7, env: .dev, channel: "testflight")
        _ = try await client.funnel("pace", steps: [StepQuery("paywall_viewed"), StepQuery("purchase_started", prop: "plan", value: "yearly")],
                                    windowDays: 3, scope)
        let url = try #require(Stub.seen.last?.url)
        #expect(url.path() == "/admin/apps/pace/funnel")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items.filter { $0.name == "step" }.map(\.value) == ["paywall_viewed", "purchase_started:plan=yearly"], "steps keep their order")
        #expect(Set(items.filter { $0.name != "step" }.map { "\($0.name)=\($0.value ?? "")" })
                == ["days=7", "env=dev", "channel=testflight", "window=3"])

        Stub.handler = { _ in (200, Data(#"{"weeks":8,"cohorts":[]}"#.utf8)) }
        _ = try await client.cohorts("pace", scope)
        #expect(Stub.seen.last?.url?.query() == "channel=testflight&env=dev&weeks=8", "cohorts count whole weeks, not days")

        Stub.handler = { _ in (200, Data(#"{"ok":true,"deleted":{"events":4,"tickets":1}}"#.utf8)) }
        let gone = try await client.forget(install: "294EAEE7-97D1-46C2-8AB3-467DEF05BF69")
        #expect(gone.deleted.events == 4)
        #expect(Stub.seen.last?.httpMethod == "POST")
        #expect(Stub.seen.last?.url?.path() == "/admin/installs/294eaee7-97d1-46c2-8ab3-467def05bf69/forget")
        #expect("294eaee7-97d1-46c2-8ab3-467def05bf69 ".isInstallID && !"#168".isInstallID)
    }

    @Test func configWritesSayOnlyWhatChanges() async throws {
        // The demo's first key, as a write's answer carries it.
        let config = try #require(try JSONSerialization.jsonObject(with: fixture("config")) as? [String: Any])
        let first = try #require((config["keys"] as? [Any])?.first)
        let written = try JSONSerialization.data(withJSONObject: ["ok": true, "revision": "r", "key": first])
        let client = Stub.client { _ in (200, written) }
        _ = try await client.setConfig("pace", key: "paywall_variant", ConfigWrite(base: 4, default: .string("c"), note: "  "))
        let r = try #require(Stub.seen.last)
        #expect(r.httpMethod == "POST" && r.url?.path() == "/admin/apps/pace/config/paywall_variant")
        let body = try #require(try JSONSerialization.jsonObject(with: r.httpBody ?? Data()) as? [String: Any])
        #expect(Set(body.keys) == ["base", "default"], "no rules: the catalog's stand; a blank note is no note")
        _ = try await client.revertConfig("pace", key: "paywall_variant", base: 5)
        #expect(Stub.seen.last?.httpMethod == "DELETE")

        Stub.handler = { _ in (409, Data(#"{"error":"changed since you opened it","key":{}}"#.utf8)) }
        await #expect(throws: HushError.conflict) {
            try await client.setConfig("pace", key: "paywall_variant", ConfigWrite(base: 0, default: .string("c")))
        }

        Stub.handler = { _ in (200, try fixture("config-preview")) }
        _ = try await client.configPreview("pace", DeviceContext(platform: "ios", pro: true), key: "paywall_variant",
                                           draft: ConfigWrite(base: 0, default: .string("c")))
        let items = URLComponents(url: try #require(Stub.seen.last?.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        let q = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        #expect(q["platform"] == "ios" && q["pro"] == "true" && q["key"] == "paywall_variant")
        #expect(q["draft"] == #"{"default":"c"}"#)
    }

    @Test func aPairingLinkRoundTrips() throws {
        let link = PairingLink(server: URL(string: "https://ops.example.com/hush")!, code: "ABC123")
        #expect(PairingLink(link.url) == link)
    }

    @Test func pushSignUpsSayEveryApp() async throws {
        let client = Stub.client { _ in (200, Data(#"{"configured":true,"signup":{"sandbox":true,"label":"x","tickets":true,"replies":false,"apps":null}}"#.utf8)) }
        let status = try await client.signUpForPush(PushSignup(token: "ab12", sandbox: true, label: "x", replies: false))
        #expect(status.configured && status.signup?.replies == false)
        let body = try #require(try JSONSerialization.jsonObject(with: Stub.seen.last?.httpBody ?? Data()) as? [String: Any])
        #expect(body["apps"] is NSNull, "null is every app")
        #expect(body["token"] as? String == "ab12" && body["sandbox"] as? Bool == true)
        _ = try await client.pushStatus(token: "ab12")
        #expect(Stub.seen.last?.url?.query() == "token=ab12")
    }

    @Test func statusAndDelete() async throws {
        let client = Stub.client { _ in (200, Data(#"{"ok":true}"#.utf8)) }
        try await client.setStatus("7", .closed)
        try await client.delete("7")
        #expect(Stub.seen.map { "\($0.httpMethod!) \($0.url!.path())" } == ["POST /admin/tickets/7/status", "DELETE /admin/tickets/7"])
        #expect(String(data: Stub.seen[0].httpBody ?? Data(), encoding: .utf8) == #"{"status":"closed"}"#)
        #expect(Stub.seen[1].value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    @Test func errorsInTheAppsTerms() async throws {
        let cases: [(Int, String, HushError)] = [
            (401, #"{"error":"unauthorized"}"#, .unauthorized),
            (403, #"{"error":"read-only demo"}"#, .readOnly),
            (404, #"{"error":"not found"}"#, .notFound),
            (409, #"{"error":"closed"}"#, .server(status: 409, message: "closed")),
            (502, "<html>Bad Gateway</html>", .server(status: 502, message: "bad gateway")),
        ]
        for (status, body, expected) in cases {
            let client = Stub.client { _ in (status, Data(body.utf8)) }
            await #expect(throws: expected) { try await client.tickets() }
        }
    }

    @Test func anAnswerThatIsNotHushIsUnreadable() async throws {
        let client = Stub.client { _ in (200, Data("<html></html>".utf8)) }
        await #expect {
            try await client.apps()
        } throws: { error in
            if case HushError.unreadable = error { true } else { false }
        }
    }

    @Test func noAnswerIsUnreachable() async throws {
        let client = Stub.client { _ in throw URLError(.notConnectedToInternet) }
        await #expect {
            try await client.apps()
        } throws: { error in
            if case HushError.unreachable = error { true } else { false }
        }
    }
}

@Test(arguments: [
    ("hush.example.com", "https://hush.example.com"),
    ("https://hush.example.com/", "https://hush.example.com"),
    ("https://hush.example.com/dashboard/", "https://hush.example.com"),
    ("https://hush.example.com/dashboard/#/feedback?status=all", "https://hush.example.com"),
    ("https://example.com/hush/dashboard", "https://example.com/hush"),
    ("hush.bavrk.com/demo/dashboard/", "https://hush.bavrk.com/demo"),
    ("http://192.168.1.10:3000", "http://192.168.1.10:3000"),
    ("  https://hush.example.com  ", "https://hush.example.com"),
])
func addresses(_ input: String, _ expected: String) {
    #expect(Connection.normalize(input)?.absoluteString == expected)
}

@Test(arguments: ["", "ftp://hush.example.com", "https://", "not a url at all"])
func notAddresses(_ input: String) {
    #expect(Connection.normalize(input) == nil)
}

/// The real demo, end to end: HUSH_LIVE=1 swift test. Off by default, so the
/// suite never depends on the network.
@Test(.enabled(if: ProcessInfo.processInfo.environment["HUSH_LIVE"] != nil))
func theLiveDemo() async throws {
    let client = AdminClient(.demo)
    #expect(try await client.session().demo)
    let apps = try await client.apps()
    #expect(!apps.apps.isEmpty)
    let slug = apps.apps[0].app
    let detail = try await client.app(slug, Scope())
    #expect(!(try await client.funnels(slug, Scope())).isEmpty)
    _ = try await client.cohorts(slug, Scope())
    let config = try await client.config(slug)
    if let key = config.keys.first {
        _ = try await client.configPreview(slug, DeviceContext(platform: "ios"), key: key.key, draft: ConfigWrite(base: key.change, default: key.effective.default))
        _ = try await client.configHistory(slug, key: key.key)
    }
    let event = try #require(detail.events.first).name
    if let prop = try await client.props(slug, event: event, Scope()).first {
        _ = try await client.breakdown(slug, event: event, prop: prop.key, Scope())
    }
    let tickets = try await client.tickets().tickets
    _ = try await client.ticket(try #require(tickets.first).id)
    await #expect(throws: HushError.readOnly) { try await client.setStatus(tickets[0].id, .closed) }
    if let install = tickets.compactMap(\.install).first {
        #expect(try await client.install(install).install?.id == install)
    }
    await #expect(throws: HushError.notFound) { try await client.install(UUID().uuidString) }
}

@Test func aPushTellsWhichServerAndTicket() {
    let info: [AnyHashable: Any] = ["aps": ["alert": ["title": "New problem in Game"]], "ticket": "42", "app": "game", "server": "8B1F…"]
    let p = PushTicket(info)
    #expect(p?.ticket == "42" && p?.app == "game" && p?.server == "8B1F…")
    #expect(PushTicket(["aps": [:]]) == nil, "a test push names no ticket")
    #expect(Data([0xde, 0xad, 0x01]).hexToken == "dead01")
}

/// Sealed by the server's own code (src/push.mjs `seal`), opened as the notification extension does.
@Test func aSealedPushOpensWithItsKey() throws {
    struct Fixture: Decodable { let key: String; let sealed: String }
    let f = try JSONDecoder().decode(Fixture.self, from: fixture("sealed"))
    let key = try #require(Data(base64Encoded: f.key))
    let content = try #require(PushSeal.open(f.sealed, key: key))
    #expect(content["title"] as? String == "New problem in Game")
    #expect(content["ticket"] as? String == "42" && content["server"] as? String == "srv-b")
    #expect(PushSeal.open(f.sealed, key: PushSeal.newKey()) == nil, "another key opens nothing")
    #expect(PushSeal.newKey().count == 32)
}

/// A push as the relay sends it: a placeholder, the sealed words, and the label of the server's key.
@Test func aRelayedPushIsRevealedForTheApp() throws {
    struct Fixture: Decodable { let key: String; let sealed: String }
    let f = try JSONDecoder().decode(Fixture.self, from: fixture("sealed"))
    let key = try #require(Data(base64Encoded: f.key))
    let info: [AnyHashable: Any] = ["aps": ["alert": ["title": "hush", "body": "Something new on one of your servers."], "mutable-content": 1],
                                    "sealed": f.sealed, "server": "srv-b"]
    let r = try #require(PushSeal.reveal(info, keyFor: { $0 == "srv-b" ? key : nil }))
    #expect(r.title == "New problem in Game" && r.subtitle == "Timer" && r.body == "The timer stops.")
    #expect(r.userInfo == ["ticket": "42", "app": "game", "server": "srv-b"])
    #expect(PushTicket(r.userInfo)?.ticket == "42", "the app opens the ticket from what it reveals")
    #expect(PushSeal.reveal(info, keyFor: { _ in nil }) == nil, "no key, the placeholder stays")
    #expect(PushSeal.reveal(["aps": [:]], keyFor: { _ in key }) == nil, "a push not sealed is left alone")
}
