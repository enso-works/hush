import HushKit
import SwiftUI

/// Every event the app sent this period: search, sort, and the names the
/// catalog does not know.
struct EventsView: View {
    let data: AppData

    enum Order: String, CaseIterable, Identifiable {
        case sent, installs, name
        var id: Self { self }

        var title: String {
            switch self {
            case .sent: "Most sent"
            case .installs: "Most installs"
            case .name: "Name"
            }
        }
    }

    @State private var search = ""
    @AppStorage("eventOrder") private var order = Order.sent
    @State private var unknownOnly = false

    var body: some View {
        AppScreen(data: data, title: "Events", screen: "app_events") { _, _ in
            if let d = data.detail {
                let unknown = d.events.filter { !$0.known }.count
                HStack(spacing: 8) {
                    Menu {
                        Picker("Order", selection: $order) {
                            ForEach(Order.allCases) { Text($0.title).tag($0) }
                        }
                    } label: {
                        Chip(title: order.title, symbol: "arrow.up.arrow.down", active: order != .sent)
                    }
                    if unknown > 0 {
                        Button {
                            unknownOnly.toggle()
                        } label: {
                            Chip(title: "Not in the catalog (\(unknown))", symbol: "questionmark.diamond", active: unknownOnly)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(unknownOnly ? .isSelected : [])
                    }
                    Spacer()
                }
                .sensoryFeedback(.selection, trigger: order)
                .sensoryFeedback(.selection, trigger: unknownOnly)
                let rows = shown(d.events)
                if rows.isEmpty {
                    EmptyNote(d.events.isEmpty ? "No events in this period." : "No event matches.")
                } else {
                    let top = max(d.events.map(\.n).max() ?? 1, 1)
                    VStack(spacing: 0) {
                        ForEach(rows, id: \.self) { e in
                            NavigationLink(value: AppRoute.event(e.name)) {
                                EventRow(event: e, top: top)
                            }
                            .buttonStyle(Pressable())
                            if e != rows.last { Divider().padding(.leading, 16) }
                        }
                    }
                    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
                }
            }
        }
        .searchable(text: $search, prompt: "Event name")
    }

    private func shown(_ events: [AppDetail.Event]) -> [AppDetail.Event] {
        let text = search.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "_")
        let matching = events.filter { (!unknownOnly || !$0.known) && (text.isEmpty || $0.name.contains(text)) }
        switch order {
        case .sent: return matching.sorted { $0.n > $1.n }
        case .installs: return matching.sorted { $0.installs > $1.installs }
        case .name: return matching.sorted { $0.name < $1.name }
        }
    }
}

private struct EventRow: View {
    let event: AppDetail.Event
    let top: Int
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(event.name)
                    .font(.subheadline.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !event.known { UnknownBadge() }
                Spacer(minLength: 8)
                Text(event.n, format: .number).font(.subheadline.weight(.semibold).monospacedDigit())
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            HStack(spacing: 10) {
                GeometryReader { g in
                    Capsule().fill((event.known ? accent(redaction) : .orange).opacity(0.7))
                        .frame(width: max(4, g.size.width * CGFloat(event.n) / CGFloat(top)))
                }
                .frame(height: 6)
                Text(plural(event.installs, "install"))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(eventLabel(event.name) + (event.known ? "" : ", not in the catalog"))
        .accessibilityValue("\(plural(event.n, "event")), \(plural(event.installs, "install"))")
    }
}

/// A name the catalog does not list.
struct UnknownBadge: View {
    var body: some View {
        Text("Unknown")
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(.orange)
            .background(.orange.opacity(0.14), in: .capsule)
    }
}

/// One event: how much, from how many, and its props' values.
struct EventView: View {
    let data: AppData
    let name: String

    @State private var prop: String?
    @State private var perInstall = false

    var body: some View {
        AppScreen(data: data, title: eventLabel(name), screen: "app_event") { scope, key in
            let event = data.detail?.events.first { $0.name == name }
            let all = data.detail?.events.reduce(0) { $0 + $1.n } ?? 0
            Panel(title: name) {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                    GridRow {
                        Figure(label: "Sent", value: event?.n.formatted() ?? "0")
                        Figure(label: "Installs", value: event?.installs.formatted() ?? "0")
                        Figure(label: "Per install", value: event.map { $0.installs > 0 ? (Double($0.n) / Double($0.installs)).formatted(.number.precision(.fractionLength(0...1))) : "–" } ?? "–")
                        Figure(label: "Of all events", value: percent(event?.n ?? 0, of: all))
                    }
                }
            }
            if event?.known == false {
                Callout(symbol: "questionmark.diamond", tint: .orange,
                        text: "This name is not in the app's catalog: a typo in the app, or a name to add to the catalog, which keeps the props it may carry and how the dashboard shows it.")
            }
            Panel(title: "By prop") {
                Remote(key: key, height: 160) {
                    try await data.client.props(data.slug, event: name, scope)
                } content: { keys in
                    if keys.isEmpty {
                        EmptyNote("This event carries no props in this period.")
                    } else {
                        let picked = prop.flatMap { p in keys.contains { $0.key == p } ? p : nil } ?? keys[0].key
                        ScrollView(.horizontal) {
                            HStack(spacing: 8) {
                                ForEach(keys, id: \.key) { k in
                                    Button {
                                        prop = k.key
                                    } label: {
                                        PropChip(key: k.key, n: k.n, selected: k.key == picked)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityAddTraits(k.key == picked ? .isSelected : [])
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                        Picker("Count", selection: $perInstall) {
                            Text("Every event").tag(false)
                            Text("Once per install").tag(true)
                        }
                        .pickerStyle(.segmented)
                        Remote(key: [AnyHashable(key), AnyHashable(picked)]) {
                            try await data.client.breakdown(data.slug, event: name, prop: picked, scope)
                        } content: { rows in
                            BreakdownBars(rows: rows, perInstall: perInstall, empty: "Nothing in this period.")
                        }
                    }
                }
            }
            .sensoryFeedback(.selection, trigger: prop)
            .sensoryFeedback(.selection, trigger: perInstall)
        }
    }
}

private struct PropChip: View {
    let key: String
    let n: Int
    let selected: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(key).font(.subheadline.monospaced())
            Text(n, format: .number).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
        .background(selected ? AnyShapeStyle(.tint.opacity(0.14)) : AnyShapeStyle(Color(.tertiarySystemFill)), in: .capsule)
        .contentShape(.capsule)
    }
}
