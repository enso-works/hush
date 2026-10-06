import HushKit
import SwiftUI

/// One app over the period, against the period before: whether it is
/// sending, its numbers and activity, and a card for each closer look
/// (funnels, retention, engagement, events, audience, feedback). The
/// filters stay at the top while it scrolls.
struct AppView: View {
    @State private var data: AppData
    @AppStorage("days") private var days = 30
    @AppStorage("env") private var env = Env.prod
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(server: Server, app: AppSummary, client: AdminClient, kept: Int?) {
        _data = State(initialValue: AppData(server: server, slug: app.app, name: app.name, client: client, kept: kept))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                AppFilters(data: data)
                if let error = data.error { ErrorNote(error: error) { await load() } }
                if data.detail != nil || data.error == nil {
                    Page(data: data, detail: data.detail ?? Placeholder.detail, days: days, env: env)
                        .placeholder(data.detail == nil)
                        // The first answer replaces the placeholder whole (see OverviewView).
                        .id(data.detail == nil)
                        .transition(.opacity)
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(data.name)
        // A large title under a pinned filter bar blurs into the bar on iOS 26.
        .navigationBarTitleDisplayMode(.inline)
        .scopeTitle(data, days: days, env: env)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: InstallRoute(id: "")) {
                    Image(systemName: "person.text.rectangle")
                }
                .accessibilityLabel("Look Up an Install")
            }
        }
        .navigationDestination(for: AppRoute.self) { route in
            switch route {
            case .funnels: FunnelsView(data: data)
            case .retention: RetentionView(data: data)
            case .engagement: EngagementView(data: data)
            case .audience: AudienceView(data: data)
            case .events: EventsView(data: data)
            case .event(let name): EventView(data: data, name: name)
            case .config: ConfigView(data: data)
            case .configKey(let key): ConfigKeyView(data: data, name: key)
            case .configHistory(let key): ConfigHistoryView(data: data, key: key)
            case .configPreview: ConfigPreviewView(data: data)
            }
        }
        .onAppear { Telemetry.screen("app") }
        .task(id: data.scope(days: days, env: env)) { await load() }
        .refreshable { await data.refresh(data.scope(days: days, env: env), reduceMotion: reduceMotion) }
    }

    private func load() async {
        await data.load(data.scope(days: days, env: env), reduceMotion: reduceMotion)
    }
}

/// The filters of an app's screens: the period, the data, and the channel
/// when its installs come from more than one. The first row of the content,
/// not pinned: on iOS 26 a bar pinned under a pushed screen's navigation bar
/// is washed out by the bar's scroll edge effect.
struct AppFilters: View {
    @Bindable var data: AppData

    var body: some View {
        FilterBar(extraActive: data.channel != nil, reset: { data.channel = nil }) {
            if let channels = data.detail?.channels, channels.count > 1 || data.channel != nil {
                ChannelChip(channel: $data.channel, channels: channels)
            }
        }
        // The chips scroll to the screen's edges, past the content's margin.
        .padding(.horizontal, -16)
        .padding(.vertical, -8)
    }
}

/// Everything under the filters, for one answer (or its placeholder).
private struct Page: View {
    let data: AppData
    let detail: AppDetail
    let days: Int
    let env: Env
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let d = detail
        VStack(spacing: 16) {
            Health(detail: d, env: env)
            Stats(detail: d, cut: data.cut(days: days))
            if let unknown = d.unknown, !unknown.isEmpty {
                NavigationLink(value: AppRoute.events) {
                    Callout(symbol: "questionmark.diamond", tint: .orange,
                            text: "\(unknown.count == 1 ? "One event name is" : "\(unknown.count) event names are") not in this app's catalog: \(unknown.map(\.name).joined(separator: ", ")). A typo in the app, or a name to add to the catalog.")
                }
                .buttonStyle(Pressable())
            }
            Panel(title: "Activity", trailing: Prefs.periodName(days)) {
                Activity(daily: d.daily, cut: data.cut(days: days))
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: typeSize.isAccessibilitySize ? 320 : 150), spacing: 12)], spacing: 12) {
                Cards(data: data, detail: d, env: env)
            }
            .buttonStyle(Pressable())
            ForEach(d.breakdowns ?? [], id: \.self) { b in
                Panel(title: b.title, trailing: b.count == "installs" ? "One per install" : nil) {
                    PinnedBreakdown(data: data, pinned: b, days: days, env: env)
                }
            }
        }
    }
}

/// Whether the app is sending: the line under its name.
private struct Health: View {
    let detail: AppDetail
    let env: Env

    var body: some View {
        let quiet = detail.lastEvent.map { Date.now.timeIntervalSince($0) } ?? .infinity
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                AppMark(slug: detail.app, name: detail.name ?? detail.app, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Circle().fill(tint(quiet)).frame(width: 8, height: 8)
                        Text(status(quiet)).font(.subheadline.weight(.semibold))
                    }
                    Text("Last event \(when(detail.lastEvent))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .accessibilityElement(children: .combine)
            if env == .prod, detail.lastEvent != nil, quiet > 2 * 86_400 {
                Callout(symbol: "exclamationmark.triangle", tint: .orange,
                        text: "Nothing has arrived since \(when(detail.lastEvent)). A quiet stretch, or a revoked key, a wrong URL or an SDK that stopped sending: look up an install to see one device's events.")
            }
        }
    }

    private func status(_ quiet: TimeInterval) -> String {
        if quiet == .infinity { return "No events yet" }
        if quiet < 3600 { return "Receiving events" }
        if quiet < 2 * 86_400 { return "Quiet for \(Int(quiet / 3600)) h" }
        return "Quiet for \(Int(quiet / 86_400)) days"
    }

    private func tint(_ quiet: TimeInterval) -> Color {
        quiet < 3600 ? .green : quiet < 2 * 86_400 ? .secondary : .orange
    }
}

/// A note with a symbol, on a tinted ground.
struct Callout: View {
    let symbol: String
    var tint: Color = .orange
    let text: String

    var body: some View {
        Label {
            Text(text).foregroundStyle(.primary).multilineTextAlignment(.leading)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint)
        }
        .font(.callout)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.12), in: .rect(cornerRadius: 14))
    }
}

private struct Stats: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let detail: AppDetail
    /// Days new installs are counted over, when the retention window is shorter than the period.
    let cut: Int?

    var body: some View {
        let c = detail.current, p = detail.prior
        LazyVGrid(columns: tileColumns(typeSize), spacing: 12) {
            Stat(label: "Active installs", value: c.active.formatted(), change: change(c.active, p.active))
            Stat(label: cut.map { "New installs, last \($0) days" } ?? "New installs", value: c.newInstalls.formatted(),
                 change: cut == nil ? change(c.newInstalls, p.newInstalls) : nil)
            Stat(label: "Sessions", value: c.sessions.formatted(), change: change(c.sessions, p.sessions))
            Stat(label: "Active today", value: detail.todayActive.formatted())
            if let h = detail.highlight {
                Stat(label: eventLabel(h.event), value: c.highlight.formatted(), change: change(c.highlight, p.highlight))
                if h.doneProp != nil {
                    Stat(label: "Completion rate", value: percent(c.highlightDone, of: c.highlight))
                }
            }
        }
    }
}

/// A card for each closer look, with the number it leads with.
private struct Cards: View {
    let data: AppData
    let detail: AppDetail
    let env: Env
    @Environment(AppModel.self) private var model
    @AppStorage("days") private var days = 30
    /// The catalog's first funnel, read for its card; nil while it comes or when it could not be read.
    @State private var funnel: Funnel??

    var body: some View {
        let d = detail
        NavigationLink(value: AppRoute.funnels) {
            switch funnel {
            case .some(.some(let f)):
                Card(symbol: "line.3.horizontal.decrease", title: "Funnels",
                     value: percent(f.steps.last?.installs ?? 0, of: f.steps.first?.installs ?? 0), caption: "\(f.name), first step to last")
            case .some(.none):
                Card(symbol: "line.3.horizontal.decrease", title: "Funnels", value: "–", caption: "Where installs drop off")
            case .none:
                Card(symbol: "line.3.horizontal.decrease", title: "Funnels", value: "00%", caption: "Where installs drop off")
                    .redacted(reason: .placeholder)
            }
        }
        .task(id: data.key(days: days, env: env)) {
            let fresh = try? await data.client.funnels(data.slug, data.scope(days: days, env: env)).first
            if !Task.isCancelled { funnel = .some(fresh) }
        }
        NavigationLink(value: AppRoute.retention) {
            Card(symbol: "arrow.uturn.backward.circle", title: "Retention",
                 value: d.retention.d7.rate?.formatted(.percent.precision(.fractionLength(0))) ?? "–",
                 caption: "Back a week after the first open")
        }
        NavigationLink(value: AppRoute.engagement) {
            if let e = d.engagement, e.measured > 0 {
                Card(symbol: "timer", title: "Engagement", value: duration(e.medianSeconds), caption: "Median session")
            } else {
                Card(symbol: "timer", title: "Engagement",
                     value: d.engagement?.sessionsPerInstall?.formatted(.number.precision(.fractionLength(0...1))) ?? "–",
                     caption: "Sessions per install")
            }
        }
        NavigationLink(value: AppRoute.events) {
            let unknown = d.unknown?.count ?? 0
            Card(symbol: "list.bullet.rectangle", title: "Events", value: d.events.count.formatted(),
                 caption: unknown > 0 ? "\(unknown) not in the catalog" : "\(d.events.reduce(0) { $0 + $1.n }.formatted()) sent",
                 warning: unknown > 0)
        }
        NavigationLink(value: AppRoute.audience) {
            Card(symbol: "globe", title: "Audience", value: d.versions.first?.version ?? "–",
                 caption: "Top of \(d.versions.count) versions, \(d.countries.count) countries")
        }
        NavigationLink(value: AppRoute.config) {
            if let config = data.config {
                let overridden = config.keys.filter(\.overridden).count
                Card(symbol: "slider.horizontal.3", title: "Remote config", value: config.keys.count.formatted(),
                     caption: config.keys.isEmpty ? "No keys in the catalog" : overridden == 0 ? "Keys, as the catalog says" : "Keys, \(overridden) overridden")
            } else {
                Card(symbol: "slider.horizontal.3", title: "Remote config", value: "–", caption: "Values the app reads at launch")
            }
        }
        .task { if data.config == nil { await data.loadConfig() } }
        Button {
            model.showFeedback(app: data.slug)
        } label: {
            Card(symbol: "bubble.left.and.bubble.right", title: "Feedback", value: d.tickets.formatted(),
                 caption: d.tickets == 1 ? "Open message" : "Open messages", leaves: true)
        }
        .accessibilityHint("Opens the Feedback tab, filtered to this app.")
    }
}

/// A closer look's card: what it is, its leading number, and a line on it.
private struct Card: View {
    let symbol: String
    let title: String
    let value: String
    let caption: String
    var warning = false
    /// Whether it opens another tab rather than a screen under this one.
    var leaves = false
    @Environment(\.redactionReasons) private var redaction
    @ScaledMetric(relativeTo: .headline) private var symbolRow: CGFloat = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: symbol)
                    .font(.headline)
                    .foregroundStyle(redaction.isEmpty ? AnyShapeStyle(.tint) : AnyShapeStyle(Color(.systemFill)))
                Spacer()
                Image(systemName: leaves ? "arrow.up.right" : "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            // Symbols differ in height; the numbers under them line up across cards.
            .frame(height: symbolRow)
            Text(value)
                .font(.title2.weight(.semibold).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.top, 4)
            Text(title).font(.subheadline.weight(.semibold))
            Text(caption)
                .font(.caption)
                .foregroundStyle(warning ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                .lineLimit(2, reservesSpace: true)
        }
        .foregroundStyle(.primary)
        .multilineTextAlignment(.leading)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
        .contentShape(.rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

/// A breakdown the catalog pins to the app's page.
private struct PinnedBreakdown: View {
    let data: AppData
    let pinned: AppDetail.Pinned
    let days: Int
    let env: Env

    var body: some View {
        Remote(key: data.key(days: days, env: env)) {
            try await data.client.breakdown(data.slug, event: pinned.event, prop: pinned.prop, data.scope(days: days, env: env))
        } content: { rows in
            BreakdownBars(rows: rows, perInstall: pinned.count == "installs", empty: "Nothing in this period.")
        }
    }
}
