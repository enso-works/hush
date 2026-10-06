import HushKit
import Observation
import SwiftUI
import UserNotifications

/// This phone's push sign-ups: the APNs token, which servers it signed up
/// with and for what, and the answers given from a notification.
@Observable
final class PushCenter {
    weak var model: AppModel?
    /// The APNs token, hex, once iOS hands it over.
    private(set) var token: String?
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var problem: String?
    /// What each server was asked for, by server id: kept here to sign up again when the token changes.
    private(set) var signups: [UUID: PushSignup] = [:]

    private var waiting: [CheckedContinuation<String, any Error>] = []
    private static let defaultsKey = "pushSignups"

    /// bavrk's relay, for servers without an APNs key (Config/App.xcconfig).
    private let relay = (Bundle.main.object(forInfoDictionaryKey: "HushPushRelay") as? String)
        .flatMap { $0.isEmpty ? nil : URL(string: $0) }
        .map { PushRelay(url: $0) }
    /// The servers' sealing keys, shared with the notification extension.
    let keys = PushKeys(accessGroup: Bundle.main.object(forInfoDictionaryKey: "HushKeychainGroup") as? String)
    /// The relay's pass for the current token, asked for once.
    private var pass: (token: String, value: String)?

    static let reply = "REPLY"
    static let close = "CLOSE"
    static let ticketCategory = UNNotificationCategory(
        identifier: "TICKET",
        actions: [
            UNTextInputNotificationAction(identifier: reply, title: "Reply", options: [.authenticationRequired],
                                          textInputButtonTitle: "Send", textInputPlaceholder: "Your answer"),
            UNNotificationAction(identifier: close, title: "Close", options: [.authenticationRequired]),
        ],
        intentIdentifiers: [],
        options: []
    )

    /// A development build's token works only against Apple's sandbox.
    static var sandbox: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let saved = try? JSONDecoder().decode([UUID: PushSignup].self, from: data) {
            signups = saved
        }
    }

    /// At launch: a phone signed up anywhere asks for its token again, which may have changed.
    func launched() {
        Task { await refreshAuthorization() }
        if !signups.isEmpty { UIApplication.shared.registerForRemoteNotifications() }
    }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func tokenArrived(_ hex: String) {
        log.info("Push token arrived")
        let changed = token != nil && token != hex
        token = hex
        problem = nil
        for c in waiting { c.resume(returning: hex) }
        waiting = []
        // A new token: every server it signed up with hears it.
        if changed || signups.values.contains(where: { $0.token != hex }) {
            Task { await resendAll() }
        }
    }

    func tokenFailed(_ error: any Error) {
        log.error("No push token: \(error.localizedDescription, privacy: .public)")
        problem = error.localizedDescription
        for c in waiting { c.resume(throwing: error) }
        waiting = []
    }

    /// Asks permission once, then for the token.
    private func requestToken() async throws -> String {
        log.info("Asking for notifications")
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        log.info("Notifications granted: \(granted, privacy: .public)")
        await refreshAuthorization()
        guard granted else { throw PushError.denied }
        if let token { return token }
        // UI tests: simctl pushes reach the app without one, and a simulator may never get one.
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-push-token"), i + 1 < ProcessInfo.processInfo.arguments.count {
            tokenArrived(ProcessInfo.processInfo.arguments[i + 1])
            return ProcessInfo.processInfo.arguments[i + 1]
        }
        // iOS can stay silent (no network, no Apple account on a simulator): give up rather than spin.
        Task {
            try? await Task.sleep(for: .seconds(15))
            if !waiting.isEmpty { tokenFailed(PushError.noToken) }
        }
        return try await withCheckedThrowingContinuation { c in
            waiting.append(c)
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    enum PushError: LocalizedError {
        case denied, noToken
        var errorDescription: String? {
            switch self {
            case .denied: "Notifications are off for hush in the Settings app."
            case .noToken: "iOS did not give hush a notification token. Check the network and try again."
            }
        }
    }

    func isOn(_ server: Server) -> Bool { signups[server.id] != nil }
    func signup(_ server: Server) -> PushSignup? { signups[server.id] }

    /// Signs this phone up with the server, or changes what it wants. Returns whether and how the server can send.
    @discardableResult
    func signUp(_ server: Server, tickets: Bool = true, replies: Bool = true, apps: [String]? = nil) async throws -> PushStatus? {
        guard let model else { return nil }
        let token = try await requestToken()
        let s = try await signup(for: server, token: token, tickets: tickets, replies: replies, apps: apps)
        let status = try await model.client(for: server).signUpForPush(s)
        signups[server.id] = s
        save()
        return status
    }

    /// A sign-up that works with any server: the relay's pass and a sealing
    /// key go with it, for a server that has no APNs key and pushes through
    /// the relay. One with its own key ignores them.
    private func signup(for server: Server, token: String, tickets: Bool, replies: Bool, apps: [String]?) async throws -> PushSignup {
        let label = server.id.uuidString
        let key = try? keys.keyMaking(for: label).base64EncodedString()
        return PushSignup(token: token, sandbox: Self.sandbox, label: label, tickets: tickets, replies: replies, apps: apps,
                          pass: await relayPass(token), key: key)
    }

    /// Nil when the relay cannot be reached: the sign-up still works with a server that has its own key.
    private func relayPass(_ token: String) async -> String? {
        if let pass, pass.token == token { return pass.value }
        guard let relay else { return nil }
        do {
            let value = try await relay.register(token: token, sandbox: Self.sandbox)
            pass = (token, value)
            return value
        } catch {
            log.error("No pass from the push relay: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    func signOff(_ server: Server) async throws {
        guard let model, let s = signups[server.id] else { return }
        try await model.client(for: server).signOffPush(token: s.token)
        signups[server.id] = nil
        keys.forget(server.id.uuidString)
        save()
    }

    /// A server removed from the app: its sign-up goes too, best effort.
    func forget(_ server: Server, client: AdminClient) {
        guard let s = signups.removeValue(forKey: server.id) else { return }
        keys.forget(server.id.uuidString)
        save()
        Task { try? await client.signOffPush(token: s.token) }
    }

    func test(_ server: Server) async throws {
        guard let model, let s = signups[server.id] else { return }
        try await model.client(for: server).testPush(token: s.token)
    }

    private func resendAll() async {
        guard let model, let token else { return }
        for server in model.servers {
            guard let had = signups[server.id] else { continue }
            let old = had.token
            do {
                let s = try await signup(for: server, token: token, tickets: had.tickets, replies: had.replies, apps: had.apps)
                _ = try await model.client(for: server).signUpForPush(s)
                if old != token { try? await model.client(for: server).signOffPush(token: old) }
                signups[server.id] = s
            } catch {
                log.error("Could not give a server the new push token: \(String(describing: error), privacy: .public)")
            }
        }
        save()
    }

    /// What each server was asked for, without the key and the pass: the key lives in the keychain only.
    private func save() {
        let kept = signups.mapValues { s in
            var s = s
            s.key = nil
            s.pass = nil
            return s
        }
        if let data = try? JSONEncoder().encode(kept) { UserDefaults.standard.set(data, forKey: Self.defaultsKey) }
    }

    /// A notification tapped, answered or closed.
    func handle(_ push: PushTicket, action: String, text: String?) async {
        guard let model,
              let server = model.servers.first(where: { $0.id.uuidString == push.server }) ?? model.current else { return }
        switch action {
        case Self.reply:
            guard let body = text?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty else { return }
            do {
                _ = try await model.client(for: server).reply(to: push.ticket, body: body)
                Telemetry.track("ticket_replied", ["from": "notification"])
            } catch {
                await failed("Your answer was not sent", error)
            }
        case Self.close:
            do {
                try await model.client(for: server).setStatus(push.ticket, .closed)
                Telemetry.track("ticket_status", ["status": "closed", "from": "notification"])
            } catch {
                await failed("The message was not closed", error)
            }
        default:
            if model.current?.id != server.id { model.select(server) }
            model.showTicket(push.ticket)
        }
        if server.id == model.current?.id { await model.inbox?.load() }
    }

    /// An action from the lock screen has nowhere to show an error but another notification.
    private func failed(_ title: String, _ error: any Error) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = HushError(error).message
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
