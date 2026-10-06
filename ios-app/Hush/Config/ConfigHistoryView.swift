import HushKit
import SwiftUI

/// Every change to the app's config, or to one key, newest first.
struct ConfigHistoryView: View {
    let data: AppData
    let key: String?

    @State private var changes: [ConfigChange] = []
    @State private var more = false
    @State private var loaded = false
    @State private var error: HushError?

    var body: some View {
        List {
            if let error { ErrorNote(error: error) { await load() }.listRowBackground(Color.clear) }
            ForEach(changes) { ChangeRow(change: $0, showKey: key == nil) }
            if more {
                ProgressView().frame(maxWidth: .infinity).task { await load(after: changes.last?.id) }
            }
        }
        .overlay {
            if loaded, changes.isEmpty, error == nil {
                ContentUnavailableView("No changes", systemImage: "clock.arrow.circlepath",
                                       description: Text("Nothing has been changed here: every key is as the catalog says."))
            }
        }
        .navigationTitle(key ?? "Every Change")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .onAppear { Telemetry.screen("app_config_history") }
    }

    private func load(after: ServerID? = nil) async {
        do {
            let page = try await data.client.configHistory(data.slug, key: key, before: after, limit: 30)
            changes = after == nil ? page.changes : changes + page.changes
            more = page.more
            loaded = true
            error = nil
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { self.error = HushError(error); more = false }
        }
    }
}

/// One change: what happened to which part, when, and why.
struct ChangeRow: View {
    let change: ConfigChange
    let showKey: Bool

    var body: some View {
        let type = ConfigType.json
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: change.action == "revert" ? "arrow.uturn.backward.circle" : "pencil.circle")
                    .foregroundStyle(change.action == "revert" ? AnyShapeStyle(.orange) : AnyShapeStyle(.tint))
                if showKey { Text(change.key).font(.subheadline.monospaced()) }
                Text(change.action == "revert" ? "Reverted to the catalog" : "Changed").font(.subheadline)
                Spacer()
                Text(when(change.at)).font(.caption).foregroundStyle(.secondary)
            }
            if let before = change.effectiveBefore, let after = change.effectiveAfter {
                if before.default != after.default {
                    HStack(spacing: 6) {
                        Text("Default").font(.caption).foregroundStyle(.secondary)
                        ValueChip(value: before.default, type: type).strikethrough()
                        Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.secondary)
                        ValueChip(value: after.default, type: type)
                    }
                }
                if before.rules != after.rules {
                    Text(rulesChange(before.rules, after.rules)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let note = change.note, !note.isEmpty {
                Text(note).font(.callout).italic()
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func rulesChange(_ before: [ConfigRule], _ after: [ConfigRule]) -> String {
        if before.count != after.count { return "Rules: \(before.count) to \(after.count)" }
        let rollouts = zip(before, after).enumerated().filter { $1.0.rollout != $1.1.rollout }
        if rollouts.count == 1, let (i, (b, a)) = rollouts.first, zip(before, after).allSatisfy({ $0.when == $1.when && $0.value == $1.value }) {
            return "Rule \(i + 1) rollout: \(b.rollout)% to \(a.rollout)%"
        }
        return "Rules changed"
    }
}

/// Every key, as a device like the one described would get it.
struct ConfigPreviewView: View {
    let data: AppData
    @State private var context = DeviceContext(platform: "ios")
    @State private var install = ""

    var body: some View {
        Form {
            Section {
                PreviewForm(context: $context)
                TextField("Or an install id", text: $install)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("A device")
            } footer: {
                Text("With an install id, what that install last reported fills in what is left blank.")
            }
            Section("It gets") {
                let ctx = DeviceContext(platform: context.platform, version: context.version, channel: context.channel,
                                         language: context.language, pro: context.pro, install: install.isInstallID ? install : nil)
                Remote(key: ctx, height: 88) {
                    try await Task.sleep(for: .milliseconds(350))
                    return try await data.client.configPreview(data.slug, ctx)
                } content: { preview in
                    if !preview.fromInstall.isEmpty {
                        Text("From the install: \(preview.fromInstall.joined(separator: ", ")).").font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(preview.warnings, id: \.self) { Label($0, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
                    ForEach(preview.keys) { k in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(k.key).font(.subheadline.monospaced())
                            Outcomes(outcomes: k.outcomes, type: k.type)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .navigationTitle("What a Device Gets")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { Telemetry.screen("app_config_preview") }
    }
}
