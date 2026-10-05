import Charts
import HushKit
import SwiftUI

/// One app over the period, against the period before, as the web
/// dashboard's app page shows it: the numbers, activity, retention,
/// versions and countries.
struct AppView: View {
    let server: Server
    let slug: String
    let name: String
    /// The server's install retention, when installs are deleted after it.
    var kept: Int? = nil

    @Environment(AppModel.self) private var model
    @AppStorage("days") private var days = 30
    @AppStorage("env") private var env = Env.prod
    @State private var channel: String?
    @State private var detail: AppDetail?
    @State private var error: HushError?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Query: Equatable { let days: Int; let env: Env; let channel: String? }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                PeriodPicker(days: $days)
                if let error { ErrorNote(error: error) { await load() } }
                if detail != nil || error == nil {
                    Panels(detail: detail ?? Placeholder.detail, days: days, cut: kept.flatMap { $0 < days ? $0 : nil }, env: env)
                        .placeholder(detail == nil)
                        // The first answer replaces the placeholder whole (see OverviewView).
                        .id(detail == nil)
                        .transition(.opacity)
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(name)
        .toolbar {
            if let channels = detail?.channels, channels.count > 1 || channel != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Channel", selection: $channel) {
                            Text("All channels").tag(String?.none)
                            ForEach(channels, id: \.channel) { c in
                                Text(c.channel.replacingOccurrences(of: "_", with: " ")).tag(Optional(c.channel))
                            }
                        }
                    } label: {
                        Label(channel?.replacingOccurrences(of: "_", with: " ") ?? "All channels", systemImage: "line.3.horizontal.decrease.circle")
                    }
                }
            }
        }
        .sensoryFeedback(.selection, trigger: days)
        .sensoryFeedback(.selection, trigger: channel)
        .task(id: Query(days: days, env: env, channel: channel)) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let fresh = try await model.client(for: server).app(slug, days: days, env: env, channel: channel)
            withAnimation(arrival(reduceMotion: reduceMotion)) {
                detail = fresh
                error = nil
            }
        } catch is CancellationError {
        } catch {
            self.error = HushError(error)
        }
    }
}

/// Everything below the period picker, for one answer (or its placeholder).
private struct Panels: View {
    let detail: AppDetail
    let days: Int
    let cut: Int?
    let env: Env

    var body: some View {
        let d = detail
        VStack(spacing: 16) {
            Stats(detail: d, cut: cut)
            if env == .prod, let last = d.lastEvent, Date.now.timeIntervalSince(last) > 2 * 86_400 {
                Label("Nothing has arrived since \(when(last)). A quiet stretch, or a revoked key, a wrong URL or an SDK that stopped sending.",
                      systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.orange.opacity(0.12), in: .rect(cornerRadius: 14))
            }
            Panel(title: "Activity", trailing: Prefs.periodLabel(days)) { Activity(daily: d.daily) }
            Panel(title: "Retention") { Retention(retention: d.retention) }
            if !d.versions.isEmpty {
                Panel(title: "Versions") {
                    Bars(rows: d.versions.prefix(6).map { ($0.version, $0.installs) })
                }
            }
            if !d.countries.isEmpty {
                Panel(title: "Countries") {
                    Bars(rows: d.countries.prefix(8).map { c in (flag(c.country).map { "\($0) \(c.country)" } ?? "Other", c.installs) })
                }
            }
        }
    }
}

private struct Stats: View {
    let detail: AppDetail
    /// Days new installs are counted over, when the retention window is shorter than the period.
    let cut: Int?

    var body: some View {
        let c = detail.current, p = detail.prior
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
            Stat(label: "Active installs", value: c.active.formatted(), change: change(c.active, p.active))
            Stat(label: cut.map { "New installs, last \($0) days" } ?? "New installs", value: c.newInstalls.formatted(),
                 change: cut == nil ? change(c.newInstalls, p.newInstalls) : nil)
            Stat(label: "Sessions", value: c.sessions.formatted(), change: change(c.sessions, p.sessions))
            Stat(label: "Active today", value: detail.todayActive.formatted())
            if let h = detail.highlight {
                Stat(label: eventLabel(h.event), value: c.highlight.formatted(), change: change(c.highlight, p.highlight))
                if h.doneProp != nil {
                    Stat(label: "Completion rate",
                         value: c.highlight > 0 ? (Double(c.highlightDone) / Double(c.highlight)).formatted(.percent.precision(.fractionLength(0))) : "–")
                }
            }
        }
    }
}

/// Active installs per day, with new installs dashed over it.
private struct Activity: View {
    let daily: [AppDetail.Day]
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let points = daily.compactMap { d in day(d.day).map { (date: $0, d: d) } }
        Chart {
            ForEach(points, id: \.date) { p in
                AreaMark(x: .value("Day", p.date, unit: .day), y: .value("Active", p.d.active))
                    .foregroundStyle(.linearGradient(colors: [accent(redaction).opacity(0.3), accent(redaction).opacity(0)], startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Day", p.date, unit: .day), y: .value("Active", p.d.active), series: .value("Series", "Active installs"))
                    .foregroundStyle(accent(redaction))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Day", p.date, unit: .day), y: .value("New", p.d.newInstalls), series: .value("Series", "New installs"))
                    .foregroundStyle(redaction.isEmpty ? Color.teal : Color(.systemFill))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .interpolationMethod(.monotone)
            }
        }
        .chartForegroundStyleScale(["Active installs": accent(redaction), "New installs": redaction.isEmpty ? Color.teal : Color(.systemFill)])
        .chartLegend(position: .top, alignment: .leading)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.day().month(.abbreviated), centered: false)
            }
        }
        .frame(height: 220)
    }
}

/// Of the installs old enough, the share still active one, seven and thirty days on.
private struct Retention: View {
    let retention: AppDetail.Retention
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        HStack(spacing: 12) {
            ForEach([("Day 1", retention.d1), ("Day 7", retention.d7), ("Day 30", retention.d30)], id: \.0) { label, r in
                VStack(spacing: 8) {
                    ZStack {
                        Circle().stroke(.quaternary, lineWidth: 7)
                        Circle()
                            .trim(from: 0, to: r.rate ?? 0)
                            .stroke(accent(redaction), style: StrokeStyle(lineWidth: 7, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text(r.rate.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "–")
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                    }
                    .frame(width: 68, height: 68)
                    Text(label).font(.subheadline.weight(.medium))
                    Text("\(r.retained.formatted()) of \(r.cohort.formatted())")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// Labelled counts as bars of their share of the largest.
private struct Bars: View {
    let rows: [(String, Int)]
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let top = max(rows.map(\.1).max() ?? 1, 1)
        VStack(spacing: 8) {
            ForEach(rows, id: \.0) { label, n in
                HStack(spacing: 10) {
                    Text(label).font(.subheadline).lineLimit(1).frame(width: 96, alignment: .leading)
                    GeometryReader { g in
                        Capsule().fill(accent(redaction).opacity(0.75))
                            .frame(width: max(4, g.size.width * CGFloat(n) / CGFloat(top)))
                    }
                    .frame(height: 8)
                    Text(n, format: .number).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        .frame(minWidth: 40, alignment: .trailing)
                }
            }
        }
    }
}
