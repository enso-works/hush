import Charts
import HushKit
import SwiftUI

/// What a website's visit that reached its goal did: "store click", or the
/// catalog's event in words.
func goalName(_ event: String) -> String {
    event == "store_clicked" ? "store click" : eventLabel(event).lowercased()
}

/// A website's page under its name: visitors and visits rather than installs
/// and sessions, where they came from, the page they landed on, the device,
/// and how many visits reached the site's goal. One read of `/web` for all of it.
struct WebsiteHome: View {
    let data: AppData
    let days: Int
    let env: Env
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Remote(key: data.key(days: days, env: env), height: 640) {
            try await data.client.web(data.slug, data.scope(days: days, env: env))
        } content: { w in
            let c = w.current, p = w.prior
            let goal = goalName(w.goal.event)
            VStack(spacing: 16) {
                LazyVGrid(columns: tileColumns(typeSize), spacing: 12) {
                    Stat(label: "Visitors", value: c.visitors.formatted(), change: change(c.visitors, p.visitors))
                    Stat(label: "New visitors", value: c.newVisitors.formatted(), change: change(c.newVisitors, p.newVisitors))
                    Stat(label: "Visits", value: c.visits.formatted(), change: change(c.visits, p.visits))
                    Stat(label: "Engaged visits", value: percent(c.engaged, of: c.visits))
                    Stat(label: "Visits with \(withArticle(goal))", value: c.goalVisits.formatted(), change: change(c.goalVisits, p.goalVisits))
                    Stat(label: "\(goal.prefix(1).uppercased() + goal.dropFirst()) rate", value: percent(c.goalVisits, of: c.visits))
                }
                if env == .prod, c.visits == 0 {
                    Callout(symbol: "exclamationmark.triangle", tint: .orange,
                            text: "No visits in this period. The site needs the /hush.js tag (or SDK 2.5 with autoTrack) with its write key; crawlers and headless browsers are never counted.")
                }
                Panel(title: "Visitors", trailing: Prefs.periodName(days)) {
                    VisitorsChart(daily: w.daily, goal: goal)
                }
                if let revenue = w.revenue {
                    RevenueSection(revenue: revenue)
                }
                SiteFunnels(data: data, days: days, env: env)
                Panel(title: "Sources", trailing: "Visits") {
                    SplitRows(rows: Array(w.sources.prefix(8)), goal: goal, empty: "No visits in this period.") { row in
                        row.detail == "referrer" ? row.label : row.label == "direct" ? "Direct" : eventLabel(row.label)
                    } code: { $0.detail == "referrer" }
                    Text("A link's utm_source, else the site that sent the visit, else direct: typed in, a bookmark, or an app.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Panel(title: "Campaigns", trailing: "Visits") {
                    SplitRows(rows: w.campaigns, goal: goal, empty: "No tagged visits in this period. Add utm_source and utm_campaign to the links you share.") { row in
                        "\(eventLabel(row.label)) · \(row.detail ?? "")"
                    }
                }
                Panel(title: "Landing pages", trailing: "Visits") {
                    SplitRows(rows: Array(w.landing.prefix(8)), goal: goal, empty: "No pages in this period.") { $0.label } code: { _ in true }
                }
                Panel(title: "Devices", trailing: "Visits") {
                    SplitRows(rows: w.devices, goal: goal, empty: "No visits in this period.") { $0.label.prefix(1).uppercased() + $0.label.dropFirst() }
                    Text(w.goal.event == "store_clicked"
                         ? "A store link leads to an app only on a phone or tablet: compare the \(goal) rate there."
                         : "Phone, tablet or desktop, each with its \(goal) rate.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: typeSize.isAccessibilitySize ? 320 : 150), spacing: 12)], spacing: 12) {
                    NavigationLink(value: AppRoute.website) {
                        Card(symbol: "doc.text", title: "Pages and clicks", value: c.pageviews.formatted(),
                             caption: "Pageviews, countries, store clicks, links out")
                    }
                    NavigationLink(value: AppRoute.events) {
                        Card(symbol: "list.bullet.rectangle", title: "Events", value: w.events.count.formatted(),
                             caption: w.events.isEmpty ? "Only what the tag tracks" : "The site's own events")
                    }
                }
                .buttonStyle(Pressable())
            }
        }
    }
}

/// The funnels a website's catalog names (a shop's cart, say), counted in
/// visitors; nothing at all when it names none.
private struct SiteFunnels: View {
    let data: AppData
    let days: Int
    let env: Env

    var body: some View {
        Remote(key: data.key(days: days, env: env), height: 0) {
            try await data.client.funnels(data.slug, data.scope(days: days, env: env))
        } content: { funnels in
            ForEach(funnels, id: \.name) { f in
                Panel(title: f.name, trailing: "Within \(plural(f.windowDays, "day"))") {
                    FunnelSteps(steps: f.steps, unit: "visitor")
                }
            }
        }
    }
}

/// A shop's orders and revenue against the period before, then by the
/// source and the campaign that brought each order: the visitor's last
/// visit, within the lookback, that came from a tagged link or another site.
private struct RevenueSection: View {
    let revenue: WebReport.Revenue
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // The busiest currency leads the tiles; a shop selling in one has just that one.
        let now = revenue.current.first ?? OrderTotal(currency: revenue.prior.first?.currency ?? "", orders: 0, revenue: 0)
        let before = revenue.prior.first { $0.currency == now.currency } ?? OrderTotal(currency: now.currency, orders: 0, revenue: 0)
        let average = { (t: OrderTotal) in t.orders > 0 ? t.revenue / Double(t.orders) : 0 }
        LazyVGrid(columns: tileColumns(typeSize), spacing: 12) {
            Stat(label: "Revenue", value: money(now.revenue, now.currency), change: change(now.revenue, before.revenue))
            Stat(label: "Orders", value: now.orders.formatted(), change: change(now.orders, before.orders))
            Stat(label: "Average order", value: money(average(now), now.currency), change: change(average(now), average(before)))
        }
        if revenue.current.count > 1 {
            Text("Also \(revenue.current.dropFirst().map { money($0.revenue, $0.currency) }.formatted(.list(type: .and))).")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        Panel(title: "Revenue by source", trailing: "Revenue") {
            MoneyRows(rows: Array(revenue.sources.prefix(8)), empty: "No orders in this period.") { row in
                row.label == "direct" ? "Direct" : row.label.contains(".") ? row.label : eventLabel(row.label)
            }
            Text("Each order counts for the last visit, within \(revenue.lookbackDays) days before it, that came from a tagged link or another site.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Panel(title: "Revenue by campaign", trailing: "Revenue") {
            MoneyRows(rows: revenue.campaigns, empty: "No orders from tagged links in this period.") { row in
                "\(eventLabel(row.label)) · \(row.detail ?? "")"
            }
        }
    }
}

/// Sources or campaigns by the revenue they brought, with their orders.
private struct MoneyRows: View {
    let rows: [WebReport.Revenue.Row]
    let empty: String
    let label: (WebReport.Revenue.Row) -> String
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        if rows.isEmpty {
            EmptyNote(empty)
        } else {
            let top = max(rows.map(\.revenue).max() ?? 1, 1)
            VStack(spacing: 12) {
                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(label(row)).font(.subheadline).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(money(row.revenue, row.currency)).font(.subheadline.weight(.medium).monospacedDigit())
                        }
                        GeometryReader { g in
                            Capsule().fill(.quaternary)
                                .overlay(alignment: .leading) {
                                    Capsule().fill(accent(redaction).opacity(0.75))
                                        .frame(width: max(4, g.size.width * CGFloat(row.revenue / top)))
                                }
                        }
                        .frame(height: 6)
                        Text(plural(row.orders, "order")).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(label(row))
                    .accessibilityValue("\(money(row.revenue, row.currency)), \(plural(row.orders, "order"))")
                }
            }
        }
    }
}

/// Rows of visits with their share, how many were engaged and how many
/// reached the goal: the rate says which source, campaign or page is worth more of.
private struct SplitRows: View {
    let rows: [WebReport.Split]
    let goal: String
    let empty: String
    let label: (WebReport.Split) -> String
    var code: (WebReport.Split) -> Bool = { _ in false }
    @Environment(\.redactionReasons) private var redaction

    init(rows: [WebReport.Split], goal: String, empty: String, label: @escaping (WebReport.Split) -> String,
         code: @escaping (WebReport.Split) -> Bool = { _ in false }) {
        self.rows = rows
        self.goal = goal
        self.empty = empty
        self.label = label
        self.code = code
    }

    var body: some View {
        if rows.isEmpty {
            EmptyNote(empty)
        } else {
            let top = max(rows.map(\.visits).max() ?? 1, 1)
            VStack(spacing: 12) {
                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(label(row))
                                .font(code(row) ? .caption.monospaced() : .subheadline)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Text(row.visits, format: .number).font(.subheadline.weight(.medium).monospacedDigit())
                        }
                        GeometryReader { g in
                            Capsule().fill(.quaternary)
                                .overlay(alignment: .leading) {
                                    Capsule().fill(accent(redaction).opacity(0.75))
                                        .frame(width: max(4, g.size.width * CGFloat(row.visits) / CGFloat(top)))
                                }
                        }
                        .frame(height: 6)
                        Text("\(percent(row.engaged, of: row.visits)) engaged · \(percent(row.goalVisits, of: row.visits)) \(goal) rate (\(row.goalVisits.formatted()))")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(label(row))
                    .accessibilityValue("\(plural(row.visits, "visit")), \(percent(row.engaged, of: row.visits)) engaged, \(percent(row.goalVisits, of: row.visits)) \(goal) rate")
                }
            }
        }
    }
}

/// Visitors per day, and the visits that reached the goal under them.
private struct VisitorsChart: View {
    let daily: [WebReport.Day]
    let goal: String
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let points = daily.compactMap { d in day(d.day).map { ($0, d) } }
        Chart {
            ForEach(points, id: \.0) { date, d in
                AreaMark(x: .value("Day", date, unit: .day), y: .value("Visitors", d.visitors))
                    .foregroundStyle(.linearGradient(colors: [accent(redaction).opacity(0.3), accent(redaction).opacity(0)], startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Day", date, unit: .day), y: .value("Visitors", d.visitors), series: .value("Series", "Visitors"))
                    .foregroundStyle(accent(redaction))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Day", date, unit: .day), y: .value("Visitors", d.goalVisits), series: .value("Series", "Goal"))
                    .foregroundStyle(redaction.isEmpty ? Color.green : Color(.systemFill))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .interpolationMethod(.monotone)
            }
        }
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.day().month(.abbreviated)) } }
        .frame(height: 180)
        .accessibilityLabel("Visitors per day")
        HStack(spacing: 14) {
            Label("Visitors", systemImage: "circle.fill").foregroundStyle(accent(redaction))
            Label("Visits with \(withArticle(goal))", systemImage: "line.diagonal").foregroundStyle(redaction.isEmpty ? Color.green : Color(.systemFill))
        }
        .font(.caption)
        .labelStyle(LegendLabel())
    }
}

private struct LegendLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.font(.system(size: 7))
            configuration.title.foregroundStyle(.secondary)
        }
    }
}

/// A website's pages, countries, and the clicks that left for a store or
/// another site, and the site's own events.
struct WebsiteView: View {
    let data: AppData

    var body: some View {
        AppScreen(data: data, title: "Pages and clicks", screen: "app_website") { scope, key in
            Remote(key: key, height: 480) {
                try await data.client.web(data.slug, scope)
            } content: { w in
                VStack(spacing: 16) {
                    Panel(title: "Top pages", trailing: "Pageviews") {
                        if w.pages.isEmpty {
                            EmptyNote("No pageviews in this period. The /hush.js tag records one for every page.")
                        } else {
                            Bars(rows: w.pages.map { Bars.Row(id: $0.page, label: $0.page, value: $0.views, detail: plural($0.visitors, "visitor"), code: true) })
                        }
                    }
                    Panel(title: "Countries", trailing: "Visitors") {
                        if w.countries.isEmpty {
                            EmptyNote("No countries: the server's COUNTRY_HEADER is not set, or nothing has arrived yet.")
                        } else {
                            Bars(rows: w.countries.map { c in
                                Bars.Row(id: c.country, label: [flag(c.country), countryName(c.country)].compactMap(\.self).joined(separator: " "),
                                         value: c.visitors, muted: c.country.count != 2)
                            })
                            Text("Fewer than ten visitors from a country are counted under Other.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Panel(title: "Store clicks", trailing: "Clicks") {
                        if w.stores.isEmpty {
                            EmptyNote("No clicks on App Store, TestFlight or Google Play links in this period.")
                        } else {
                            Bars(rows: w.stores.map { Bars.Row(id: $0.value, label: storeName($0.value), value: $0.clicks, detail: plural($0.visitors, "visitor")) })
                        }
                    }
                    Panel(title: "Links out", trailing: "Clicks") {
                        if w.links.isEmpty {
                            EmptyNote("No clicks on links to other sites in this period.")
                        } else {
                            Bars(rows: w.links.map { Bars.Row(id: $0.value, label: $0.value, value: $0.clicks, code: true) })
                        }
                    }
                    Panel(title: "The site's events", trailing: "Sent") {
                        if w.events.isEmpty {
                            EmptyNote("None: the site sends only what the tag tracks by itself.")
                        } else {
                            Bars(rows: w.events.map { Bars.Row(id: $0.name, label: $0.name, value: $0.n, detail: plural($0.visitors, "visitor"), code: true) })
                        }
                    }
                }
            }
        }
    }

    private func storeName(_ s: String) -> String {
        switch s {
        case "app_store": "App Store"
        case "play": "Google Play"
        case "testflight": "TestFlight"
        default: eventLabel(s)
        }
    }
}

/// An app's websites: their visits and store clicks, and App Store clicks by
/// campaign beside App Store Connect's count for the same campaign (`ct`).
struct WebsitesForAppView: View {
    let data: AppData

    var body: some View {
        AppScreen(data: data, title: "Websites", screen: "app_websites") { scope, key in
            Remote(key: key, height: 320) {
                try await data.client.websites(data.slug, scope)
            } content: { w in
                VStack(spacing: 16) {
                    ForEach(w.websites) { site in
                        Panel(title: site.name) {
                            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                                GridRow {
                                    Figure(label: "Visitors", value: site.visitors.formatted())
                                    Figure(label: "Store clicks", value: site.storeClicks.formatted())
                                    Figure(label: "Of visits", value: percent(site.storeVisits, of: site.visits))
                                }
                            }
                        }
                    }
                    Panel(title: "By campaign", trailing: "App Store") {
                        if w.campaigns.isEmpty {
                            EmptyNote("No App Store clicks on its websites in this period.")
                        } else {
                            VStack(spacing: 0) {
                                ForEach(Array(w.campaigns.enumerated()), id: \.offset) { i, c in
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(c.campaign.isEmpty ? "No campaign" : c.campaign)
                                            .font(c.campaign.isEmpty ? .subheadline.italic() : .caption.monospaced())
                                            .foregroundStyle(c.campaign.isEmpty ? .secondary : .primary)
                                            .lineLimit(1)
                                        Spacer()
                                        VStack(alignment: .trailing, spacing: 2) {
                                            Text("\(c.storeClicks.formatted()) clicks").font(.subheadline.weight(.medium).monospacedDigit())
                                            if let a = c.appStore {
                                                Text("Apple: \(Int(a.pageViews ?? 0).formatted()) page views · \(Int(a.firstDownloads ?? 0).formatted()) first downloads")
                                                    .font(.caption2.monospacedDigit())
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                    .accessibilityElement(children: .combine)
                                    if i < w.campaigns.count - 1 { Divider().padding(.vertical, 10) }
                                }
                            }
                            Text("The store link carries the visit's campaign as ct, so App Store Connect counts the same campaign. Two counts side by side, never the same people: a click is not an install.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}
