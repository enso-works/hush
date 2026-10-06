import HushKit
import SwiftUI

/// A screen under an app's page: the same filters on top, its panels below,
/// the app's detail read again when a filter changes here.
struct AppScreen<Content: View>: View {
    let data: AppData
    let title: String
    /// The screen's name in the app's own usage events.
    let screen: String
    @ViewBuilder let content: (_ scope: Scope, _ key: AppData.Key) -> Content

    @AppStorage("days") private var days = 30
    @AppStorage("env") private var env = Env.prod
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let scope = data.scope(days: days, env: env)
        ScrollView {
            VStack(spacing: 16) {
                AppFilters(data: data)
                content(scope, data.key(days: days, env: env))
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { Telemetry.screen(screen) }
        .task(id: scope) { await data.load(scope, reduceMotion: reduceMotion) }
        .refreshable { await data.refresh(scope, reduceMotion: reduceMotion) }
    }
}

/// Retention rings, and weekly cohorts as a heatmap.
struct RetentionView: View {
    let data: AppData
    @AppStorage("cohortWeeks") private var weeks = 8
    @AppStorage("days") private var days = 30

    var body: some View {
        AppScreen(data: data, title: "Retention", screen: "app_retention") { scope, key in
            if let d = data.detail {
                Panel(title: "Came back", trailing: data.cut(days: days).map { "First seen in the last \($0) days" }) {
                    RetentionRings(retention: d.retention)
                    Text("Of the installs old enough, the share that sent anything at least that many days after their first open.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Panel(title: "Cohorts") {
                Picker("Weeks", selection: $weeks) {
                    ForEach([8, 12, 26], id: \.self) { Text("\($0) weeks").tag($0) }
                }
                .pickerStyle(.segmented)
                Remote(key: [AnyHashable(key), AnyHashable(weeks)], height: 240) {
                    try await data.client.cohorts(data.slug, weeks: weeks, scope)
                } content: { answer in
                    if answer.cohorts.isEmpty {
                        EmptyNote("No installs in the last \(answer.weeks) weeks.")
                    } else {
                        CohortGrid(answer: answer)
                    }
                }
                Text("Each row is a week's new installs (Monday to Sunday, UTC); a cell, the share of them that sent anything that many weeks later. The period does not apply: cohorts count whole weeks.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Weeks down, weeks after across, each cell shaded by its share.
private struct CohortGrid: View {
    let answer: CohortsAnswer
    @ScaledMetric(relativeTo: .caption) private var cell: CGFloat = 44

    var body: some View {
        ScrollView(.horizontal) {
            Grid(horizontalSpacing: 4, verticalSpacing: 4) {
                GridRow {
                    Text("Week").gridColumnAlignment(.leading)
                    Text("Installs").gridColumnAlignment(.trailing)
                    ForEach(0..<answer.weeks, id: \.self) { k in Text(k == 0 ? "0" : "+\(k)").frame(width: cell) }
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                ForEach(answer.cohorts, id: \.week) { c in
                    GridRow {
                        Text(day(c.week)?.formatted(.dateTime.day().month(.abbreviated).utc()) ?? c.week)
                            .lineLimit(1)
                        Text(c.installs, format: .number).monospacedDigit()
                        ForEach(Array(c.active.enumerated()), id: \.offset) { k, n in
                            Shade(n: n, of: c.installs, week: k, size: cell)
                        }
                    }
                    .font(.caption)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }
}

private struct Shade: View {
    let n: Int?
    let of: Int
    let week: Int
    let size: CGFloat
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        if let n {
            let share = of > 0 ? Double(n) / Double(of) : 0
            Text(share, format: .percent.precision(.fractionLength(0)))
                .font(.caption2.weight(.medium).monospacedDigit())
                .foregroundStyle(share > 0.55 ? .white : .primary)
                .frame(width: size, height: 30)
                .background(accent(redaction).opacity(0.08 + share * 0.92), in: .rect(cornerRadius: 6))
                .accessibilityLabel("Week \(week)")
                .accessibilityValue("\(share.formatted(.percent.precision(.fractionLength(0)))), \(n) of \(of)")
        } else {
            Color.clear.frame(width: size, height: 30).accessibilityHidden(true)
        }
    }
}

/// Session length, how often installs come back, and how sessions start.
struct EngagementView: View {
    let data: AppData

    var body: some View {
        AppScreen(data: data, title: "Engagement", screen: "app_engagement") { scope, key in
            if let e = data.detail?.engagement {
                Panel(title: "Sessions") {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                        GridRow {
                            Figure(label: "Median session", value: e.measured > 0 ? duration(e.medianSeconds) : "–")
                            Figure(label: "Longer ones (p75)", value: e.measured > 0 ? duration(e.p75Seconds) : "–")
                            Figure(label: "Per install", value: e.sessionsPerInstall?.formatted(.number.precision(.fractionLength(0...1))) ?? "–")
                        }
                    }
                    if e.measured == 0 {
                        Text("Session length arrives with SDK 2, which reports each session's time in the foreground.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Panel(title: "Installs by sessions", trailing: "This period") {
                    Histogram(counts: e.sessionsHistogram)
                }
            } else if data.detail != nil {
                EmptyNote("This server does not report engagement yet.")
            }
            Panel(title: "How sessions start") {
                Remote(key: key) {
                    try await data.client.breakdown(data.slug, event: "session_started", prop: "entry", scope)
                } content: { rows in
                    BreakdownBars(rows: rows, empty: "No sessions in this period.")
                }
                Text("The app's doors: a launch, a widget, a notification, a link.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A number and what it is, small.
struct Figure: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Text(value).font(.headline.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Installs by how many sessions they had: 1, 2, 3-5, 6-10, 11 and more.
private struct Histogram: View {
    let counts: [Int]
    @Environment(\.redactionReasons) private var redaction
    private static let buckets = ["1", "2", "3–5", "6–10", "11+"]

    var body: some View {
        let top = max(counts.max() ?? 1, 1)
        HStack(alignment: .bottom, spacing: 8) {
            ForEach(Array(zip(Self.buckets, counts)), id: \.0) { bucket, n in
                VStack(spacing: 4) {
                    Text(n, format: .number).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    UnevenRoundedRectangle(topLeadingRadius: 6, topTrailingRadius: 6)
                        .fill(accent(redaction).opacity(0.8))
                        .frame(height: max(3, 96 * CGFloat(n) / CGFloat(top)))
                    Text(bucket).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(bucket) sessions")
                .accessibilityValue(plural(n, "install"))
            }
        }
        .frame(height: 140, alignment: .bottom)
    }
}

/// Versions, countries and build channels.
struct AudienceView: View {
    let data: AppData

    var body: some View {
        AppScreen(data: data, title: "Audience", screen: "app_audience") { _, _ in
            if let d = data.detail {
                Panel(title: "Versions", trailing: "Installs seen") {
                    if d.versions.isEmpty {
                        EmptyNote("No versions in this period.")
                    } else {
                        Bars(rows: d.versions.map { Bars.Row(id: $0.version, label: $0.version, value: $0.installs, code: true) })
                    }
                }
                Panel(title: "Countries", trailing: data.kept.map { "Installs seen in \($0) days" } ?? "All installs") {
                    if d.countries.isEmpty {
                        EmptyNote("No countries: the server's COUNTRY_HEADER is not set, or nothing has arrived yet.")
                    } else {
                        Bars(rows: d.countries.map { c in
                            Bars.Row(id: c.country, label: [flag(c.country), countryName(c.country)].compactMap(\.self).joined(separator: " "),
                                     value: c.installs, muted: c.country.count != 2)
                        })
                        Text("Fewer than ten installs from a country are counted under Other.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let channels = d.channels, !channels.isEmpty {
                    Panel(title: "Build channels", trailing: "Installs seen") {
                        Bars(rows: channels.map { Bars.Row(id: $0.channel, label: channelName($0.channel), value: $0.installs) })
                    }
                }
            }
        }
    }
}
