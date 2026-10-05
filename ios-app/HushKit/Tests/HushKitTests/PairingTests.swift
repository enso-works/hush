import Foundation
import Testing
@testable import HushKit

@Test func aDashboardsLink() throws {
    let link = try #require(PairingLink("hush://pair?url=https%3A%2F%2Fhush.example.com&code=AbC-123_xyz"))
    #expect(link.server.absoluteString == "https://hush.example.com")
    #expect(link.code == "AbC-123_xyz")
}

@Test func theDemosLinkHasNoCode() throws {
    let link = try #require(PairingLink("hush://pair?url=https%3A%2F%2Fhush.bavrk.com%2Fdemo"))
    #expect(link.server.absoluteString == "https://hush.bavrk.com/demo")
    #expect(link.code == nil)
}

@Test(arguments: [
    "https://hush.example.com",                      // not the app's scheme
    "hush://other?url=https%3A%2F%2Fx.example.com",  // not a pairing
    "hush://pair?code=abc",                          // no server
    "hush://pair?url=ftp%3A%2F%2Fx.example.com",     // not a web address
    "",
])
func notALink(_ text: String) {
    #expect(PairingLink(text) == nil)
}

@Test func aServerSavedBeforeDevicesStillLoads() throws {
    let old = #"{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","name":"Ops","baseURL":"https://hush.example.com","isDemo":false}"#
    let server = try JSONDecoder().decode(Server.self, from: Data(old.utf8))
    #expect(server.deviceID == nil)
}

extension ClientTests {
    @Test func pairingSendsTheCodeAndNoToken() async throws {
        let client = Stub.client { _ in (201, Data(#"{"token":"hush_device_x","device":{"id":"7","name":"Ana's iPhone","created_at":"2026-10-05T10:00:00Z"}}"#.utf8)) }
        let paired = try await client.pair(code: "c0de", name: "Ana's iPhone")
        #expect(paired.token == "hush_device_x")
        #expect(paired.device.id == "7")
        let r = try #require(Stub.seen.first)
        #expect(r.url?.path() == "/admin/pair")
        #expect(r.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try JSONSerialization.jsonObject(with: try #require(r.httpBody)) as? [String: String]
        #expect(body == ["code": "c0de", "name": "Ana's iPhone"])
    }

    @Test func anUsedOrExpiredCodeIsNotFound() async throws {
        let client = Stub.client { _ in (404, Data(#"{"error":"unknown or expired code"}"#.utf8)) }
        await #expect(throws: HushError.notFound) { try await client.pair(code: "old", name: "x") }
    }

    @Test func aDeviceRevokesItself() async throws {
        let client = Stub.client(Connection(baseURL: URL(string: "https://hush.example.com")!, token: "hush_device_x")) { _ in (200, Data(#"{"ok":true}"#.utf8)) }
        try await client.revokeDevice("7")
        let r = try #require(Stub.seen.first)
        #expect("\(r.httpMethod!) \(r.url!.path())" == "DELETE /admin/devices/7")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer hush_device_x")
    }
}
