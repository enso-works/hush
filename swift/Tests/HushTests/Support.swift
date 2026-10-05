import Foundation
@testable import Hush

/// Storage in memory, shared between "launches" by passing the same one.
final class MemoryStorage: HushStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func string(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ value: String?, _ key: String) { lock.withLock { values[key] = value } }
}

/// The server: answers with what the test says and keeps every request.
final class FakeServer: HushTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, String)
    private let lock = NSLock()
    private var seen: [URLRequest] = []
    private let handler: Handler

    init(_ handler: @escaping Handler = { _ in (200, #"{"accepted":1,"duplicate":0,"rejected":0}"#) }) {
        self.handler = handler
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { seen.append(request) }
        let (status, body) = handler(request)
        if status == 0 { throw URLError(.notConnectedToInternet) }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    var requests: [URLRequest] { lock.withLock { seen } }
    var paths: [String] { requests.map { $0.url!.path } }

    /// The JSON body of each request to `path`.
    func bodies(_ path: String) -> [[String: Any]] {
        requests.filter { $0.url!.path == path }.compactMap { r in
            r.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
    }

    /// Every event sent, in order.
    var events: [[String: Any]] { bodies("/v1/events").flatMap { ($0["events"] as? [[String: Any]]) ?? [] } }
    func names() -> [String] { events.compactMap { $0["name"] as? String } }
}

final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_790_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

let testDevice = DeviceInfo(version: "1.2.0", build: "42", platform: "ios", os: "ios 18.6", device: "iPhone15,2", locale: "en-US")

/// A client on stand-ins. Timers never fire: tests send with flushQueued().
func makeClient(storage: MemoryStorage = MemoryStorage(), server: FakeServer = FakeServer(), clock: Clock = Clock(),
                key: String = "hush_test_dev_x", channel: String? = nil, debug: Bool = false) -> HushClient {
    let client = HushClient(storage: storage, transport: server, now: { clock.now }, schedule: { _, _ in },
                            device: { testDevice }, isDebug: debug)
    client.configure(url: "https://hush.example.com/", key: key, channel: channel)
    return client
}

extension Dictionary where Key == String, Value == Any {
    func props() -> [String: Any] { self["props"] as? [String: Any] ?? [:] }
}

/// What onFlush heard.
final class Results: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [FlushResult] = []
    func add(_ r: FlushResult) { lock.withLock { values.append(r) } }
    var all: [FlushResult] { lock.withLock { values } }
}

extension Result {
    /// The error, or nil on success: Result<Void, _> is not Equatable.
    var failure: Failure? {
        if case .failure(let e) = self { e } else { nil }
    }
}
