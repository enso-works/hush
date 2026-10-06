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
