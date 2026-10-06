import CryptoKit
import Foundation
import Security

/// The push relay bavrk runs for the App Store app (the server's src/relay.mjs):
/// a server without an APNs key of its own pushes through it. The phone gets
/// a pass for its token here and hands it to each server it signs up with.
public struct PushRelay: Sendable {
    public let url: URL
    let session: URLSession

    public init(url: URL, session: URLSession = .shared) {
        self.url = url
        self.session = session
    }

    /// The pass for this token: no account, nothing kept.
    public func register(token: String, sandbox: Bool) async throws -> String {
        struct Body: Encodable { let token: String; let sandbox: Bool }
        struct Answer: Decodable { let pass: String }
        var r = URLRequest(url: url.appending(component: "register"))
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONEncoder().encode(Body(token: token, sandbox: sandbox))
        let (data, response) = try await session.data(for: r)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw HushError.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "the push relay refused the token")
        }
        return try JSONDecoder().decode(Answer.self, from: data).pass
    }
}

/// What a push through the relay says, sealed by the server with the key the
/// phone gave it: AES-256-GCM, nonce, ciphertext and tag in one base64 string.
public enum PushSeal {
    public static func newKey() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    /// What a push through the relay says, from its `userInfo`: the words to
    /// show and the `userInfo` the app reads when it is tapped. Nil for a push
    /// that is not sealed, or does not open with any key `keyFor` gives.
    public struct Revealed: Sendable {
        public let title: String?
        public let subtitle: String?
        public let body: String?
        public let userInfo: [String: String]
    }

    public static func reveal(_ userInfo: [AnyHashable: Any], keyFor: (String) -> Data?) -> Revealed? {
        guard let sealed = userInfo["sealed"] as? String, let label = userInfo["server"] as? String,
              let key = keyFor(label), let opened = open(sealed, key: key) else { return nil }
        var info: [String: String] = [:]
        for k in ["ticket", "app", "server"] {
            if let v = opened[k] as? String { info[k] = v }
        }
        return Revealed(title: opened["title"] as? String, subtitle: opened["subtitle"] as? String,
                        body: opened["body"] as? String, userInfo: info)
    }

    /// The push's title, subtitle, body, ticket, app and server, or nil when it does not open with this key.
    public static func open(_ sealed: String, key: Data) -> [String: Any]? {
        guard let combined = Data(base64Encoded: sealed),
              let box = try? AES.GCM.SealedBox(combined: combined),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key)),
              let object = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else { return nil }
        return object
    }
}

/// The sealing keys, one per server, in a keychain group the app shares with
/// its notification extension, which opens pushes while the app is closed.
public struct PushKeys: Sendable {
    /// `<team id>.com.bavrk.hush.shared`; nil in tests, which use the default group.
    public let accessGroup: String?
    let service = "com.bavrk.hush.push"

    public init(accessGroup: String?) {
        self.accessGroup = accessGroup
    }

    private func query(_ label: String) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: label]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func key(for label: String) -> Data? {
        var q = query(label)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    /// The server's key, made the first time.
    public func keyMaking(for label: String) throws -> Data {
        if let existing = key(for: label) { return existing }
        let fresh = PushSeal.newKey()
        var q = query(label)
        q[kSecValueData as String] = fresh
        // Pushes arrive while the phone is locked: readable after the first unlock.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return fresh
    }

    public func forget(_ label: String) {
        SecItemDelete(query(label) as CFDictionary)
    }
}
