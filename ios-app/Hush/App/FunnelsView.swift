import HushKit
import SwiftUI

/// The catalog's funnels, and one built here from any events.
struct FunnelsView: View {
    let data: AppData

    var body: some View {
        AppScreen(data: data, title: "Funnels", screen: "app_funnels") { scope, key in
            Remote(key: key, height: 240) {
                try await data.client.funnels(data.slug, scope)
            } content: { funnels in
                if funnels.isEmpty {
                    EmptyNote("No funnels: add some to the catalog's funnels for this app.")
                }
                ForEach(funnels, id: \.name) { f in
                    Panel(title: f.name, trailing: "Within \(plural(f.windowDays, "day"))") {
                        FunnelSteps(steps: f.steps)
                    }
                }
            }
            Panel(title: "Build a funnel") {
                FunnelBuilder(data: data, scope: scope, reloads: key.reloads)
            }
        }
    }
}

/// Steps as bars against the first, with the share kept from the step before
/// and the time it took; the step that loses the most is marked.
struct FunnelSteps: View {
    let steps: [FunnelStep]
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let top = steps.first?.installs ?? 0
        if top == 0 {
            EmptyNote("Nobody reached the first step in this period.")
        } else {
            let worst = worstStep
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text("\(i + 1)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.label).font(.subheadline)
                                if i > 0 {
                                    Text(caption(i))
                                        .font(.caption)
                                        .foregroundStyle(i == worst ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                                }
                            }
                            Spacer()
                            Text(s.installs, format: .number).font(.subheadline.weight(.semibold).monospacedDigit())
                        }
                        GeometryReader { g in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color(.tertiarySystemFill))
                                Capsule().fill(i == worst && redaction.isEmpty ? Color.orange : accent(redaction))
                                    .frame(width: max(4, g.size.width * CGFloat(s.installs) / CGFloat(top)))
                            }
                        }
                        .frame(height: 8)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Step \(i + 1), \(s.label)")
                    .accessibilityValue([plural(s.installs, "install"), i > 0 ? caption(i) : nil].compactMap(\.self).joined(separator: ", "))
                }
                if let last = steps.last {
                    Text("**\(percent(last.installs, of: top))** made it from the first step to the last.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func caption(_ i: Int) -> String {
        let s = steps[i]
        var parts = ["\(percent(s.installs, of: steps[i - 1].installs)) of the step before"]
        if let t = s.medianSeconds { parts.append("median \(duration(t))") }
        if i == worstStep { parts.append("the biggest drop") }
        return parts.joined(separator: " · ")
    }

    /// The step that keeps the smallest share of the one before, when any loses some.
    private var worstStep: Int? {
        let shares = steps.indices.dropFirst().compactMap { i -> (Int, Double)? in
            let prev = steps[i - 1].installs
            return prev > 0 ? (i, Double(steps[i].installs) / Double(prev)) : nil
        }
        guard shares.count > 1, let worst = shares.min(by: { $0.1 < $1.1 }), worst.1 < 1 else { return nil }
        return worst.0
    }
}

/// Pick events in order, each optionally with one prop it must carry, and
/// see the funnel at once.
private struct FunnelBuilder: View {
    let data: AppData
    let scope: Scope
    let reloads: Int

    @State private var steps: [StepQuery] = []
    @State private var windowDays = 7
    /// The steps as last sent: typing a condition waits for a pause.
    @State private var applied: [StepQuery] = []

    private struct Ask: Hashable {
        let scope: Scope
        let reloads: Int
        let steps: [StepQuery]
        let window: Int
    }

    var body: some View {
        let names = data.detail?.events.map(\.name) ?? []
        VStack(alignment: .leading, spacing: 12) {
            ForEach(steps.indices, id: \.self) { i in
                StepRow(number: i + 1, step: $steps[i], names: names, removable: steps.count > 2) {
                    steps.remove(at: i)
                }
            }
            HStack {
                Button("Add Step", systemImage: "plus") {
                    steps.append(StepQuery(names.first ?? ""))
                }
                .disabled(steps.count >= 8 || names.isEmpty)
                Spacer()
                Menu {
                    Picker("Within", selection: $windowDays) {
                        ForEach([1, 3, 7, 14, 30], id: \.self) { Text(plural($0, "day")).tag($0) }
                    }
                } label: {
                    Chip(title: "Within \(plural(windowDays, "day"))", active: windowDays != 7)
                }
            }
            .font(.subheadline)
            Divider()
            let valid = applied.filter { !$0.event.isEmpty && ($0.prop?.nilIfBlank == nil) == ($0.value?.nilIfBlank == nil) }
            if valid.count >= 2 {
                Remote(key: Ask(scope: scope, reloads: reloads, steps: valid, window: windowDays), height: 160) {
                    try await data.client.funnel(data.slug, steps: valid, windowDays: windowDays, scope).steps
                } content: { steps in
                    FunnelSteps(steps: steps)
                }
            } else {
                EmptyNote(names.isEmpty ? "No events in this period." : "Pick at least two steps.")
            }
            Text("Save one for good in the catalog's funnels to see it above without building it again.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onChange(of: names, initial: true) {
            guard steps.isEmpty, !names.isEmpty else { return }
            let first = ["app_first_opened", "paywall_viewed"].filter(names.contains) + names
            steps = Array(first.prefix(2)).map { StepQuery($0) }
            applied = steps
        }
        .task(id: steps) {
            try? await Task.sleep(for: .milliseconds(400))
            if !Task.isCancelled { applied = steps }
        }
    }
}

private struct StepRow: View {
    let number: Int
    @Binding var step: StepQuery
    let names: [String]
    let removable: Bool
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text("\(number)").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 16)
                Menu {
                    Picker("Event", selection: $step.event) {
                        ForEach(names, id: \.self) { Text($0).tag($0) }
                    }
                } label: {
                    Text(step.event.isEmpty ? "Pick an event" : step.event)
                        .font(.subheadline.monospaced())
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Menu {
                    if step.prop == nil {
                        Button("Add Condition", systemImage: "line.3.horizontal.decrease") { step.prop = ""; step.value = "" }
                    } else {
                        Button("Remove Condition", systemImage: "xmark") { step.prop = nil; step.value = nil }
                    }
                    if removable {
                        Button("Remove Step", systemImage: "trash", role: .destructive, action: remove)
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").imageScale(.large)
                }
                .accessibilityLabel("Step \(number) options")
            }
            if step.prop != nil {
                HStack(spacing: 6) {
                    TextField("prop", text: Binding(get: { step.prop ?? "" }, set: { step.prop = $0 }))
                    Text("=").foregroundStyle(.secondary)
                    TextField("value", text: Binding(get: { step.value ?? "" }, set: { step.value = $0 }))
                }
                .font(.subheadline.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .padding(.leading, 26)
            }
        }
    }
}

extension String {
    var nilIfBlank: String? {
        let t = trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? nil : t
    }
}
