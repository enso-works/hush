import Foundation

/// hush for native Swift apps: anonymous usage and in-app feedback, sent to
/// your own hush server. The same events, sessions and tickets as the
/// JavaScript SDK (`@bavrk/hush`), so the dashboard reads both alike.
///
///     Hush.configure(url: "https://hush.example.com", key: "hush_myapp_prod_…")
///     Hush.start()                                   // at launch
///     Hush.track("onboarding_completed", once: true)
///     Hush.screen("Settings")
///
/// Every call returns at once, never throws, and never breaks the app: with no
/// key, or no server, it does nothing.
public enum Hush {
    /// The instance behind every call here.
    public static var client: HushClient { .shared }

    /// Call once, before `start()`. `key`: a write key from `keys:create <app> <env>`;
    /// an empty one leaves hush off. `channel`: where this build came from; by
    /// default `dev` in a debug build, else `testflight` or `app_store` as iOS
    /// reports it, and nothing for development and ad hoc builds.
    public static func configure(url: String, key: String, channel: String? = nil, storagePrefix: String = "hush",
                                 logLevel: LogLevel = .silent, onFlush: (@Sendable (FlushResult) -> Void)? = nil) {
        client.configure(url: url, key: key, channel: channel, storagePrefix: storagePrefix, logLevel: logLevel, onFlush: onFlush)
    }

    /// At launch, after `configure`: reads what earlier launches stored and starts the session.
    public static func start() { client.start() }

    /// Records an event: snake_case, 2-64 characters, props one flat level.
    /// `once`: at most once per install, ever; `onceKey`: once per install and key.
    public static func track(_ name: String, _ props: Props = [:], once: Bool = false, onceKey: String? = nil) {
        client.track(name, props, once: once, onceKey: onceKey)
    }

    public static func screen(_ name: String) { client.screen(name) }

    /// How this session began. Call it with the URL that opened the app (`onOpenURL`) or `.notification`.
    public static func entry(_ entry: Entry, url: URL? = nil) { client.entry(entry, url: url?.absoluteString) }

    public static func setGlobalProps(_ props: Props) { client.setGlobalProps(props) }
    public static func removeGlobalProp(_ key: String) { client.removeGlobalProp(key) }

    /// Whether the install is on a paid plan, and RevenueCat's anonymous customer id.
    public static func identify(pro: Bool? = nil, rcId: String? = nil) { client.identify(pro: pro, rcId: rcId) }

    /// The install id, for a debug screen: paste it into the dashboard's Installs page. "" before `start()`.
    public static var installationId: String { client.installationId }

    /// The user's "don't share anonymous usage", remembered. Feedback still works.
    public static func optOut() { client.optOut() }
    public static func optIn() { client.optIn() }
    public static var isOptedOut: Bool { client.isOptedOut }

    /// The user's "delete my data".
    public static func forget() async -> Result<Void, HushFailure> { await client.forget() }

    /// Sends feedback; with an email, replies also go by mail. Returns the ticket's id.
    public static func createTicket(kind: Ticket.Kind, message: String, email: String? = nil,
                                    subject: String? = nil) async -> Result<String, HushFailure> {
        await client.createTicket(kind: kind, message: message, email: email, subject: subject)
    }

    /// This device's feedback, newest first, with support's replies.
    public static func listTickets() async -> [Ticket] { await client.listTickets() }

    public static func replyToTicket(_ id: String, body: String) async -> Result<Void, HushFailure> {
        await client.replyToTicket(id, body: body)
    }

    /// Sends what is queued now, for a debug screen. hush sends on its own otherwise.
    public static func flush() async { await client.flushQueued() }
}
