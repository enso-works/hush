import Foundation
import Testing
@testable import HushKit

@Test func serversAndTheirSecretsAreKeptApart() throws {
    let file = FileManager.default.temporaryDirectory.appending(component: "servers-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    let secrets = MemorySecretStore()
    let store = ServerStore(file: file, secrets: secrets)
    #expect(store.load() == .init())

    let server = Server(name: "Ops", baseURL: URL(string: "https://hush.example.com")!, headerName: "X-Ops")
    try store.save(.init(servers: [.demo(), server], selected: server.id))
    try store.setSecrets(for: server, token: "t0ken", headerValue: "s3cret")

    let state = store.load()
    #expect(state.current == server)
    // The list on disk holds no secret.
    let onDisk = try String(contentsOf: file, encoding: .utf8)
    #expect(!onDisk.contains("t0ken") && !onDisk.contains("s3cret"))

    let connection = try store.connection(for: server)
    #expect(connection.token == "t0ken")
    #expect(connection.headers == ["X-Ops": "s3cret"])

    try store.removeSecrets(for: server)
    #expect(try store.connection(for: server) == Connection(baseURL: server.baseURL))
}

@Test func theFirstServerIsOpenWhenNoneIsSelected() {
    let a = Server(name: "A", baseURL: URL(string: "https://a.example.com")!)
    #expect(ServerStore.State(servers: [a], selected: UUID()).current == a)
    #expect(ServerStore.State().current == nil)
}

@Test func anUnreadableListStartsOver() throws {
    let file = FileManager.default.temporaryDirectory.appending(component: "servers-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    try Data("not json".utf8).write(to: file)
    #expect(ServerStore(file: file, secrets: MemorySecretStore()).load() == .init())
}

extension ClientTests {
    @Test func checkFindsTheDemo() async throws {
        let client = Stub.client(Connection(baseURL: URL(string: "https://hush.example.com")!)) { r in
            (200, try fixture(r.url!.path().hasSuffix("session") ? "session" : "apps"))
        }
        #expect(try await client.check() == .demo)
    }

    @Test func checkFindsAProxy() async throws {
        let client = Stub.client(Connection(baseURL: URL(string: "https://hush.example.com")!)) { r in
            (200, r.url!.path().hasSuffix("session") ? Data(#"{"demo":false}"#.utf8) : try fixture("apps"))
        }
        #expect(try await client.check() == .proxy)
    }

    @Test func checkTakesAWorkingToken() async throws {
        let client = Stub.client { r in
            if r.value(forHTTPHeaderField: "Authorization") != "Bearer t0ken" { return (401, Data(#"{"error":"unauthorized"}"#.utf8)) }
            return (200, try fixture("apps"))
        }
        #expect(try await client.check() == .token)
        #expect(Stub.seen.map { $0.url!.path() } == ["/admin/session", "/admin/apps"])
    }

    @Test func checkRefusesAMissingOrWrongToken() async throws {
        let refuse: Stub.Handler = { _ in (401, Data(#"{"error":"unauthorized"}"#.utf8)) }
        await #expect(throws: HushError.unauthorized) {
            try await Stub.client(Connection(baseURL: URL(string: "https://hush.example.com")!), refuse).check()
        }
        await #expect(throws: HushError.unauthorized) {
            try await Stub.client(Connection(baseURL: URL(string: "https://hush.example.com")!, token: "wrong"), refuse).check()
        }
    }

    @Test func checkSaysWhenTheAddressIsNotHush() async throws {
        let client = Stub.client { _ in (404, Data("<html>Not Found</html>".utf8)) }
        await #expect {
            try await client.check()
        } throws: { error in
            if case HushError.unreadable = error { true } else { false }
        }
    }
}
