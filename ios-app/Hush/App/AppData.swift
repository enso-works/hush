import HushKit
import Observation
import SwiftUI

/// One app's page and the screens under it: which app, the channel picked,
/// and the app's detail, shared so a filter changed on any of them shows on
/// all. The period and the data are the whole app's (`@AppStorage`).
@Observable
final class AppData {
    let server: Server
    let slug: String
    let name: String
    let client: AdminClient
    /// The server's install retention, when installs are deleted after it.
    let kept: Int?
    var channel: String?
    private(set) var detail: AppDetail?
    private(set) var error: HushError?
    /// Counts pulls to refresh, so the parts read on their own read again too.
    private(set) var reloads = 0

    init(server: Server, slug: String, name: String, client: AdminClient, kept: Int?) {
        self.server = server
        self.slug = slug
        self.name = name
        self.client = client
        self.kept = kept
    }

    func scope(days: Int, env: Env) -> Scope {
        Scope(days: days, env: env, channel: channel)
    }

    /// What the parts read on their own wait on: the scope, and pulls to refresh.
    struct Key: Hashable {
        let scope: Scope
        let reloads: Int
    }

    func key(days: Int, env: Env) -> Key {
        Key(scope: scope(days: days, env: env), reloads: reloads)
    }

    /// What `detail` was read for, and when: going back to a screen reads it
    /// again only when the filters changed or it has aged.
    private var loaded: (scope: Scope, at: Date)?

    func load(_ scope: Scope, reduceMotion: Bool, force: Bool = false) async {
        if !force, let loaded, loaded.scope == scope, Date.now.timeIntervalSince(loaded.at) < 60 { return }
        do {
            let fresh = try await client.app(slug, scope)
            loaded = (scope, .now)
            withAnimation(arrival(reduceMotion: reduceMotion)) {
                detail = fresh
                error = nil
            }
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { self.error = HushError(error) }
        }
    }

    func refresh(_ scope: Scope, reduceMotion: Bool) async {
        reloads += 1
        await load(scope, reduceMotion: reduceMotion, force: true)
    }

    /// The app's remote config, read by its screens and kept here so a write
    /// shows on the list and the key at once.
    private(set) var config: ConfigAnswer?
    private(set) var configError: HushError?

    func loadConfig() async {
        do {
            config = try await client.config(slug)
            configError = nil
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { configError = HushError(error) }
        }
    }

    /// A key as a write left it.
    func replace(_ key: ConfigKey, revision: String) {
        guard var c = config, let i = c.keys.firstIndex(where: { $0.key == key.key }) else { return }
        c.keys[i] = key
        c.revision = revision
        config = c
    }

    /// New installs and retention count only installs first seen inside the
    /// retention window: a longer period is cut to it.
    func cut(days: Int) -> Int? {
        kept.flatMap { $0 < days ? $0 : nil }
    }
}

/// The screens under an app's page.
enum AppRoute: Hashable {
    case funnels, retention, engagement, audience, events
    case event(String)
    case config, configKey(String), configHistory(key: String?), configPreview
}

/// One install, from any screen.
struct InstallRoute: Hashable {
    let id: String
}
