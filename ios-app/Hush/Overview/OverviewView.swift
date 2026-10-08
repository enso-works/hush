import HushKit
import SwiftUI

/// Every app on one server, as the web dashboard's overview shows them, in
/// the order picked, and searchable once there are many.
struct OverviewView: View {
    let server: Server

    @Environment(AppModel.self) private var model
    @AppStorage("days") private var days = 30
    @AppStorage("env") private var env = Env.prod
    @AppStorage("appOrder") private var order = AppOrder.active
    @State private var answer: AppsAnswer?
    @State private var error: HushError?
    /// Counts answers to animate on (see AppData.arrivals).
    @State private var arrivals = 0
    @State private var search = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Query: Equatable { let server: Server; let days: Int; let env: Env }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let error { ErrorNote(error: error) { await load() } }
                content
            }
            .animation(arrival(reduceMotion: reduceMotion), value: arrivals)
            .padding(16)
        }
        .pinnedBar(.top) {
            FilterBar(extraActive: order != .active, reset: { order = .active }) {
                Menu {
                    Picker("Order", selection: $order) {
                        ForEach(AppOrder.allCases) { Text($0.title).tag($0) }
                    }
                } label: {
                    Chip(title: order.title, symbol: "arrow.up.arrow.down", active: order != .active)
                }
                .accessibilityLabel("Order, \(order.title)")
                .sensoryFeedback(.selection, trigger: order)
            }
        }
        .modifier(SearchApps(text: $search, shown: (answer?.apps.count ?? 0) > 5))
        .background(Color(.systemGroupedBackground))
        .navigationTitle(server.name)
        // A large title under a pinned filter bar blurs into the bar on iOS 26.
        .navigationBarTitleDisplayMode(.inline)
        // The server's name is the title: tapping it switches servers.
        .toolbarTitleMenu { ServerPicker(server: server) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: InstallRoute(id: "")) {
                    Image(systemName: "person.text.rectangle")
                }
                .accessibilityLabel("Look Up an Install")
            }
        }
        .navigationDestination(for: AppSummary.self) { app in
            AppView(server: server, app: app, client: model.client(for: server), kept: answer?.installRetentionDays)
        }
        .navigationDestination(for: InstallRoute.self) { route in
            InstallView(server: server, id: route.id)
        }
        .onAppear { Telemetry.screen("overview") }
        .task(id: Query(server: server, days: days, env: env)) { await load() }
        .refreshable { await load() }
        .onChange(of: server) { answer = nil }
    }

    @ViewBuilder private var content: some View {
        if let answer, answer.apps.isEmpty {
            ContentUnavailableView("No apps yet", systemImage: "square.grid.2x2",
                                   description: Text("Register one on the server with `apps:add`, then create a write key with `keys:create`."))
        } else if answer != nil || error == nil {
            let shown = answer ?? Placeholder.apps
            let apps = order.sorted(shown.apps).filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.app.contains(search.lowercased()) }
            // Inactive apps go last whatever the order: their cards would be zeros.
            let inactive = apps.filter { $0.isInactive() }
            VStack(spacing: 16) {
                Totals(answer: shown, days: days)
                if apps.isEmpty {
                    ContentUnavailableView.search(text: search)
                } else {
                    AppGrid(apps: apps.filter { !$0.isInactive() }, days: days)
                    if !inactive.isEmpty { InactiveApps(apps: inactive, env: env) }
                }
            }
            .placeholder(answer == nil)
            // The first answer replaces the placeholder whole, with a fade:
            // numbers rolling up from invented values would say something false.
            .id(answer == nil)
            .transition(.opacity)
            .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: apps.map(\.app))
        }
    }

    private func load() async {
        do {
            let fresh = try await model.client(for: server).apps(days: days, env: env)
            answer = fresh
            error = nil
            arrivals += 1
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { self.error = HushError(error) }
        }
    }
}

/// The order of the app cards.
enum AppOrder: String, CaseIterable, Identifiable {
    case active, installs, feedback, recent, name
    var id: Self { self }

    var title: String {
        switch self {
        case .active: "Most active"
        case .installs: "Most installs"
        case .feedback: "Open feedback"
        case .recent: "Latest event"
        case .name: "Name"
        }
    }

    func sorted(_ apps: [AppSummary]) -> [AppSummary] {
        switch self {
        case .active: apps.sorted { ($0.dau, $0.mau) > ($1.dau, $1.mau) }
        case .installs: apps.sorted { $0.totalInstalls > $1.totalInstalls }
        case .feedback: apps.sorted { $0.openTickets > $1.openTickets }
        case .recent: apps.sorted { ($0.lastEvent ?? .distantPast) > ($1.lastEvent ?? .distantPast) }
        case .name: apps.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        }
    }
}

/// A search field for the apps, once there are enough to need one.
private struct SearchApps: ViewModifier {
    @Binding var text: String
    let shown: Bool

    func body(content: Content) -> some View {
        if shown {
            content.searchable(text: $text, prompt: "App name")
        } else {
            content
        }
    }
}

/// The app cards, as many columns as fit.
private struct AppGrid: View {
    let apps: [AppSummary]
    let days: Int

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 16)], spacing: 16) {
            ForEach(apps) { app in
                NavigationLink(value: app) { AppCard(app: app, days: days) }
                    .buttonStyle(Pressable())
            }
        }
    }
}

/// Apps with no events for 30 days, under the others, a row each.
private struct InactiveApps: View {
    let apps: [AppSummary]
    let env: Env

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Inactive").font(.headline)
                Text("No events in \(env.rawValue) for \(AppSummary.inactiveDays) days. They come back up with their next event.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, 8)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 12)], spacing: 12) {
                ForEach(apps) { app in
                    NavigationLink(value: app) { InactiveRow(app: app) }
                        .buttonStyle(Pressable())
                }
            }
        }
    }
}

private struct InactiveRow: View {
    let app: AppSummary

    var body: some View {
        HStack(spacing: 12) {
            AppMark(slug: app.app, name: app.name, size: 32)
                .saturation(0)
                .opacity(0.5)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(app.name).font(.subheadline.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                    InactiveBadge()
                }
                Text(app.lastEvent == nil ? "No events yet" : "Last event \(when(app.lastEvent))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if app.openTickets > 0 {
                Label("\(app.openTickets)", systemImage: "bubble.left")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.tint.opacity(0.12), in: .capsule)
                    .foregroundStyle(.tint)
            }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground).opacity(0.6), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.quaternary, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .contentShape(.rect(cornerRadius: 14))
    }
}

/// The flag on an app with no events for 30 days.
struct InactiveBadge: View {
    var body: some View {
        Label("Inactive", systemImage: "moon")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary.opacity(0.6), in: .capsule)
    }
}

/// The servers, in the title's menu: the open one checked.
private struct ServerPicker: View {
    let server: Server
    @Environment(AppModel.self) private var model

    var body: some View {
        ForEach(model.servers) { s in
            Button {
                model.select(s)
            } label: {
                if s.id == server.id {
                    Label(s.name, systemImage: "checkmark")
                } else {
                    Text(s.name)
                }
            }
        }
        Divider()
        Button("Servers…", systemImage: "server.rack") { model.tab = .settings }
    }
}

/// The four totals above the cards.
private struct Totals: View {
    let answer: AppsAnswer
    let days: Int
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(AppModel.self) private var model

    var body: some View {
        // Installs quiet for longer than the retention window are deleted, so
        // the total is the installs seen in it, and new installs count inside it.
        let kept = answer.installRetentionDays
        let sum = { (key: KeyPath<AppSummary, Int>) in answer.apps.reduce(0) { $0 + $1[keyPath: key] } }
        LazyVGrid(columns: tileColumns(typeSize), spacing: 12) {
            Stat(label: kept.map { "Installs seen in \($0) days" } ?? "Installs, all time", value: sum(\.totalInstalls).formatted())
            Stat(label: "New in \(min(days, kept ?? days)) days", value: sum(\.newInstalls).formatted())
            Stat(label: "Active in the last day", value: sum(\.dau).formatted())
            Button {
                model.showFeedback()
            } label: {
                Stat(label: "Open feedback", value: sum(\.openTickets).formatted())
            }
            .buttonStyle(Pressable())
            .accessibilityHint("Shows the open feedback.")
        }
    }
}

private struct AppCard: View {
    let app: AppSummary
    let days: Int
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                AppMark(slug: app.app, name: app.name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name).font(.headline).lineLimit(1)
                    Text("Last event \(when(app.lastEvent))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if app.openTickets > 0 {
                    Label("\(app.openTickets)", systemImage: "bubble.left")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(.tint.opacity(0.12), in: .capsule)
                        .foregroundStyle(.tint)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Active installs per day")
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Text(Prefs.periodLabel(days)).monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let trend = app.trend, trend.contains(where: { $0 > 0 }) {
                    Sparkline(values: trend).frame(height: 56)
                } else {
                    Text("No activity")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
                }
            }
            Divider()
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: typeSize.isAccessibilitySize ? 2 : 4), spacing: 10) {
                ForEach([("Installs", app.totalInstalls), ("DAU", app.dau), ("WAU", app.wau), ("MAU", app.mau)], id: \.0) { label, value in
                    VStack(spacing: 2) {
                        Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
                        Text(value, format: .number).font(.subheadline.weight(.semibold).monospacedDigit())
                            .lineLimit(1).minimumScaleFactor(0.7)
                            .contentTransition(.numericText(value: Double(value)))
                    }
                }
            }
            HStack {
                Text(footer).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 18))
        .contentShape(.rect(cornerRadius: 18))
    }

    private var footer: String {
        var parts = ["\(app.sessions.formatted()) sessions", "\(app.newInstalls.formatted()) new"]
        if let ads = app.adInstalls, ads > 0 { parts.append("\(ads.formatted()) from ads") }
        return parts.joined(separator: " · ")
    }
}
