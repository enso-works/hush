import HushKit
import SwiftUI

/// One install by its id: what it is, its tickets, and its latest events as
/// they arrive. For checking that a build sends what it should (the app shows
/// its install id in a debug screen) and for a "delete my data" request.
struct InstallView: View {
    let server: Server

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var text: String
    /// The id looked up, lowercased.
    @State private var id: String?
    @State private var detail: InstallDetail?
    /// Counts answers to animate on (see AppData.arrivals).
    @State private var arrivals = 0
    @State private var error: HushError?
    @State private var live = true
    @State private var forgetting = false
    @State private var forgotten: Forgotten.Counts?
    @State private var problem: HushError?
    @FocusState private var focused: Bool

    init(server: Server, id: String) {
        self.server = server
        _text = State(initialValue: id)
        _id = State(initialValue: id.isInstallID ? id.lowercased() : nil)
    }

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Install id", text: $text, prompt: Text("3f2c9a1e-…"))
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .focused($focused)
                        .accessibilityIdentifier("install-id")
                        .onSubmit(lookUp)
                    if !text.isEmpty {
                        Button("Clear", systemImage: "xmark.circle.fill") {
                            text = ""
                            focused = true
                        }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.tertiary)
                        .buttonStyle(.plain)
                    }
                }
                HStack {
                    PasteButton(payloadType: String.self) { strings in
                        guard let s = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                        text = s
                        lookUp()
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                    Spacer()
                    Button("Look Up", action: lookUp)
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .disabled(!text.isInstallID)
                }
            } footer: {
                Text("The id the app shows in a debug screen (`getInstallationId()` in the SDK). Installs are not listed: an id is looked up only when you have it.")
            }
            if let forgotten {
                Section {
                    Label("Forgotten: \(plural(forgotten.events, "event")) and \(plural(forgotten.tickets, "ticket")) deleted.", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                }
            } else if let error {
                Section {
                    if error == .notFound {
                        ContentUnavailableView("Nothing for this id", systemImage: "person.text.rectangle",
                                               description: Text("No install with it on this server: a typo, an install deleted after it went quiet, or one forgotten."))
                    } else {
                        ErrorNote(error: error) { await load() }
                    }
                }
                .listRowBackground(Color.clear)
            } else if let detail {
                content(detail)
            } else if id != nil {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Install")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if detail != nil, forgotten == nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        live.toggle()
                    } label: {
                        Label(live ? "Live" : "Paused", systemImage: live ? "dot.radiowaves.left.and.right" : "pause.circle")
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(live ? .green : .secondary)
                            .symbolEffect(.variableColor.iterative, isActive: live)
                    }
                    .accessibilityLabel("Live")
                    .accessibilityValue(live ? "On" : "Off")
                    .accessibilityHint("Reads its events again every few seconds.")
                }
            }
        }
        .animation(arrival(reduceMotion: reduceMotion), value: arrivals)
        .onAppear {
            Telemetry.screen("install")
            if id == nil { focused = true }
        }
        .task(id: id) {
            guard id != nil else { return }
            await load()
            // Live: read again every few seconds while the screen is open.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                if live, forgotten == nil, error == nil, !Task.isCancelled { await load() }
            }
        }
        .confirmationDialog("Forget this install?", isPresented: $forgetting, titleVisibility: .visible) {
            Button("Forget Install", role: .destructive) { Task { await forget() } }
        } message: {
            Text("Deletes its events and its tickets on the server. For someone who asked for their data to be deleted. This cannot be undone.")
        }
        .alert("Could not forget it", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }), presenting: problem) { _ in
            Button("OK", role: .cancel) {}
        } message: { Text($0.message) }
        .sensoryFeedback(.success, trigger: forgotten != nil)
        .sensoryFeedback(.selection, trigger: live)
    }

    @ViewBuilder private func content(_ d: InstallDetail) -> some View {
        if let i = d.install {
            Section("Install") {
                Fact("App", i.app)
                Fact("Data", i.env == "prod" ? "Release build" : "Development build")
                Fact("Device", [i.device, i.os].compactMap(\.self).joined(separator: ", ").nilIfBlank)
                Fact("Version", i.version.map { v in i.build.map { "\(v) (\($0))" } ?? v }, code: true)
                Fact("Channel", i.channel.map(channelName))
                Fact("Country", i.country.map { [flag($0), countryName($0)].compactMap(\.self).joined(separator: " ") })
                Fact("Language", i.locale)
                Fact("SDK", i.sdk, code: true)
                Fact("Subscriber", i.pro ? "Yes" : "No")
                if let rc = i.rcId { Fact("RevenueCat id", rc, code: true) }
                Fact("First seen", i.firstSeen.formatted(date: .abbreviated, time: .shortened))
                Fact("Last seen", when(i.lastSeen))
            }
        } else {
            Section {
                Text("Its install row is gone (deleted after it went quiet), but it left the tickets below.")
                    .foregroundStyle(.secondary)
            }
        }
        if !d.tickets.isEmpty {
            Section("Feedback") {
                ForEach(d.tickets) { t in
                    Button {
                        model.showTicket(t.id)
                    } label: {
                        HStack(spacing: 10) {
                            KindBadge(kind: t.kind)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(t.subject ?? "#\(t.id.value)").lineLimit(1)
                                Text(when(t.createdAt)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            StatusPill(status: t.status)
                        }
                    }
                    .foregroundStyle(.primary)
                    .accessibilityHint("Opens the thread in the Feedback tab.")
                }
            }
        }
        Section {
            if d.events.isEmpty {
                Text("No events kept for it.").foregroundStyle(.secondary)
            }
            ForEach(d.events) { e in EventLine(event: e) }
        } header: {
            HStack {
                Text("Latest events")
                Spacer()
                if live { Text("Live").foregroundStyle(.green) }
            }
        }
        Section {
            Button("Forget This Install", systemImage: "trash", role: .destructive) { forgetting = true }
        } footer: {
            Text("Deletes its events and tickets, for a \"delete my data\" request that came by email.")
        }
    }

    private func lookUp() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard t.isInstallID else { return }
        focused = false
        if t == id { Task { await load() }; return }
        detail = nil
        error = nil
        forgotten = nil
        id = t
    }

    private func load() async {
        guard let id else { return }
        do {
            let fresh = try await model.client(for: server).install(id)
            detail = fresh
            error = nil
            arrivals += 1
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { self.error = HushError(error) }
        }
    }

    private func forget() async {
        guard let id else { return }
        do {
            let gone = try await model.client(for: server).forget(install: id)
            Telemetry.track("install_forgotten")
            withAnimation { forgotten = gone.deleted; detail = nil }
        } catch {
            problem = HushError(error)
        }
    }
}

/// A labelled fact; nothing when the install did not say.
private struct Fact: View {
    let label: String
    let value: String?
    var code = false

    init(_ label: String, _ value: String?, code: Bool = false) {
        self.label = label
        self.value = value
        self.code = code
    }

    var body: some View {
        if let value {
            LabeledContent(label) {
                Text(value)
                    .font(code ? .body.monospaced() : .body)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.trailing)
            }
        }
    }
}

/// An event as the install sent it: its name, when, and its props.
private struct EventLine: View {
    let event: InstallDetail.Event

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(event.name).font(.subheadline.monospaced()).lineLimit(1)
                if !event.known { UnknownBadge() }
                Spacer()
                Text(event.at, format: .dateTime.hour().minute().second())
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if !event.props.isEmpty {
                // Props wrap onto as many lines as they need.
                FlowLayout(spacing: 4) {
                    ForEach(event.props.keys.sorted(), id: \.self) { k in
                        (Text(k + "=").foregroundStyle(.secondary) + Text(event.props[k]?.description ?? ""))
                            .font(.caption2.monospaced())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 4))
                    }
                }
            }
            if event.receivedAt.timeIntervalSince(event.at) > 3600 {
                Text("Arrived \(when(event.receivedAt)), sent late from the device's queue")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Lays its children in rows, wrapping to the next when one is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows = [Row()]
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            if !rows[rows.count - 1].items.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                rows.append(Row())
            }
            var row = rows[rows.count - 1]
            row.width += (row.items.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.items.append(i)
            rows[rows.count - 1] = row
        }
        return rows
    }
}
