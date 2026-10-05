import HushKit
import SwiftUI

/// Every app on one server, as the web dashboard's overview shows them.
struct OverviewView: View {
    let server: Server

    @Environment(AppModel.self) private var model
    @AppStorage("days") private var days = 30
    @AppStorage("env") private var env = Env.prod
    @State private var answer: AppsAnswer?
    @State private var error: HushError?

    private struct Query: Equatable { let server: Server; let days: Int; let env: Env }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                PeriodPicker(days: $days)
                if let error { ErrorNote(error: error) }
                content
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(server.name)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { DataMenu(server: server, env: $env) }
        }
        .navigationDestination(for: AppSummary.self) { app in
            AppView(server: server, slug: app.app, name: app.name, kept: answer?.installRetentionDays)
        }
        .sensoryFeedback(.selection, trigger: days)
        .sensoryFeedback(.selection, trigger: env)
        .task(id: Query(server: server, days: days, env: env)) { await load() }
        .refreshable { await load() }
        .onChange(of: server) { answer = nil }
    }

    @ViewBuilder private var content: some View {
        if let answer {
            if answer.apps.isEmpty {
                ContentUnavailableView("No apps yet", systemImage: "square.grid.2x2",
                                       description: Text("Register one on the server with `apps:add`, then create a write key with `keys:create`."))
            } else {
                Totals(answer: answer, days: days)
                AppGrid(apps: answer.apps, days: days)
            }
        } else if error == nil {
            ProgressView().padding(.top, 80)
        }
    }

    private func load() async {
        do {
            answer = try await model.client(for: server).apps(days: days, env: env)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = HushError(error)
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

/// Which builds' data to show, and which server, when there are several.
private struct DataMenu: View {
    let server: Server
    @Binding var env: Env
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            Picker("Data", selection: $env) {
                Text("Release builds (prod)").tag(Env.prod)
                Text("Development (dev)").tag(Env.dev)
            }
            if model.servers.count > 1 {
                Section("Server") {
                    ForEach(model.servers) { s in
                        Button {
                            model.select(s)
                        } label: {
                            if s.id == server.id { Label(s.name, systemImage: "checkmark") } else { Text(s.name) }
                        }
                    }
                }
            }
        } label: {
            Label(env == .prod ? "Prod" : "Dev", systemImage: "line.3.horizontal.decrease.circle")
        }
    }
}

/// The four totals above the cards.
private struct Totals: View {
    let answer: AppsAnswer
    let days: Int

    var body: some View {
        // Installs quiet for longer than the retention window are deleted, so
        // the total is the installs seen in it, and new installs count inside it.
        let kept = answer.installRetentionDays
        let sum = { (key: KeyPath<AppSummary, Int>) in answer.apps.reduce(0) { $0 + $1[keyPath: key] } }
        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                Stat(label: kept.map { "Installs seen in \($0) days" } ?? "Installs, all time", value: sum(\.totalInstalls).formatted())
                Stat(label: "New in \(min(days, kept ?? days)) days", value: sum(\.newInstalls).formatted())
            }
            GridRow {
                Stat(label: "Active in the last day", value: sum(\.dau).formatted())
                Stat(label: "Open feedback", value: sum(\.openTickets).formatted())
            }
        }
    }
}

private struct AppCard: View {
    let app: AppSummary
    let days: Int

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
                HStack {
                    Text("Active installs per day")
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
            HStack {
                ForEach([("Installs", app.totalInstalls), ("DAU", app.dau), ("WAU", app.wau), ("MAU", app.mau)], id: \.0) { label, value in
                    VStack(spacing: 2) {
                        Text(label).font(.caption2).foregroundStyle(.secondary)
                        Text(value, format: .number).font(.subheadline.weight(.semibold).monospacedDigit())
                    }
                    .frame(maxWidth: .infinity)
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
