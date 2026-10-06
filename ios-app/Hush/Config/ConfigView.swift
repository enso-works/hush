import HushKit
import SwiftUI

/// An app's remote config: every key the catalog declares, what devices get
/// for it now, and which ones the dashboard overrides.
struct ConfigView: View {
    let data: AppData
    @State private var search = ""

    var body: some View {
        List {
            if let error = data.configError, data.config == nil {
                ErrorNote(error: error) { await data.loadConfig() }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if let config = data.config {
                let keys = config.keys.filter { search.isEmpty || $0.key.localizedCaseInsensitiveContains(search) || ($0.description ?? "").localizedCaseInsensitiveContains(search) }
                Section {
                    if config.keys.isEmpty {
                        Text("No keys: remote config keys are declared in the app's catalog, under config.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(keys) { key in
                        NavigationLink(value: AppRoute.configKey(key.key)) { KeyRow(key: key) }
                    }
                } footer: {
                    let overridden = config.keys.filter(\.overridden).count
                    Text("\(plural(config.keys.count, "key")), \(overridden) overridden here. \(ByteCountFormatter.string(fromByteCount: Int64(config.sizeBytes), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: Int64(config.limits.totalBytes), countStyle: .file)) served.")
                }
                if !config.orphans.isEmpty {
                    Section {
                        ForEach(config.orphans, id: \.key) { o in
                            Label {
                                Text(o.key).font(.body.monospaced())
                            } icon: {
                                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                            }
                        }
                    } header: {
                        Text("Not in the catalog")
                    } footer: {
                        Text("Overrides for keys the catalog no longer has. They are never served; the web dashboard reverts them.")
                    }
                }
                Section {
                    NavigationLink(value: AppRoute.configPreview) {
                        Label("What a Device Gets", systemImage: "iphone.gen3")
                    }
                    NavigationLink(value: AppRoute.configHistory(key: nil)) {
                        Label("Every Change", systemImage: "clock.arrow.circlepath")
                    }
                }
            } else if data.configError == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Remote Config")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Key")
        .task { await data.loadConfig() }
        .refreshable { await data.loadConfig() }
        .onAppear { Telemetry.screen("app_config") }
    }
}

private struct KeyRow: View {
    let key: ConfigKey

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(key.key).font(.body.monospaced()).lineLimit(1)
                if key.overridden { Badge(text: "Overridden", tint: .accentColor) }
                if key.problem != nil { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityLabel("Problem") }
            }
            if let d = key.description, !d.isEmpty {
                Text(d).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 8) {
                ValueChip(value: key.effective.default, type: key.type)
                if !key.effective.rules.isEmpty {
                    Text(plural(key.effective.rules.count, "rule")).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// A word on a tinted capsule.
struct Badge: View {
    let text: String
    var tint: Color = .orange

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(tint)
            .background(tint.opacity(0.14), in: .capsule)
    }
}

/// A config value as code: `true`, `3`, `"b"`, `{…}`.
struct ValueChip: View {
    let value: JSONValue?
    let type: ConfigType

    var body: some View {
        Text(display(value, type))
            .font(.caption.monospaced())
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 5))
    }
}

func display(_ value: JSONValue?, _ type: ConfigType) -> String {
    guard let value else { return "–" }
    if case .string(let s) = value { return "\"\(s)\"" }
    return value.description
}

/// "iOS, version >=1.4.0, subscribers": the devices a rule is for.
func describe(_ when: ConfigWhen) -> String {
    if when.isEmpty { return "Every device" }
    var parts: [String] = []
    if let p = when.platform { parts.append(p.map(platformName).joined(separator: " or ")) }
    if let v = when.version { parts.append("version \(v)") }
    if let c = when.channel { parts.append(c.map(channelName).joined(separator: " or ")) }
    if let l = when.language { parts.append("language \(l.joined(separator: ", "))") }
    if let pro = when.pro { parts.append(pro ? "subscribers" : "not subscribers") }
    return parts.joined(separator: ", ")
}

func platformName(_ p: String) -> String {
    switch p {
    case "ios": "iOS"
    case "android": "Android"
    case "web": "Web"
    default: p
    }
}

/// One key: what it serves, where each part comes from, its rules, its
/// changes, and the edit and revert.
struct ConfigKeyView: View {
    let data: AppData
    let name: String

    @State private var editing = false
    @State private var reverting = false
    @State private var problem: HushError?
    @State private var reverted = 0

    var body: some View {
        List {
            if let key = data.config?.keys.first(where: { $0.key == name }) {
                content(key)
            } else if data.config == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else {
                ContentUnavailableView("No such key", systemImage: "slider.horizontal.3", description: Text("The catalog no longer declares \(name)."))
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let key = data.config?.keys.first(where: { $0.key == name }), !data.server.isDemo, key.fits {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { editing = true }
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let key = data.config?.keys.first(where: { $0.key == name }) {
                ConfigEditor(data: data, key: key)
            }
        }
        .confirmationDialog("Revert \(name) to the catalog?", isPresented: $reverting, titleVisibility: .visible) {
            Button("Revert", role: .destructive) { Task { await revert() } }
        } message: {
            Text("Devices get the catalog's default and rules again at their next fetch. The change is kept in the history.")
        }
        .alert("Not reverted", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }), presenting: problem) { _ in
            Button("OK", role: .cancel) {}
        } message: { Text($0.message) }
        .sensoryFeedback(.success, trigger: reverted)
        .task { if data.config == nil { await data.loadConfig() } }
        .refreshable { await data.loadConfig() }
        .onAppear { Telemetry.screen("app_config_key") }
    }

    @ViewBuilder private func content(_ key: ConfigKey) -> some View {
        Section {
            if let d = key.description, !d.isEmpty { Text(d) }
            LabeledContent("Type", value: key.type.rawValue)
        }
        if let p = key.problem {
            Section {
                Label(p, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            } footer: {
                Text(key.fits ? "The override is stored but not served." : "The override no longer fits the key's type: revert it, then set it again.")
            }
        }
        Section {
            LabeledContent("Value") { ValueChip(value: key.effective.default, type: key.type) }
        } header: {
            Text("Default")
        } footer: {
            Text(key.source.default == "override" ? "Overridden here; the catalog says \(display(key.catalog.default, key.type))." : "From the catalog.")
        }
        Section {
            if key.effective.rules.isEmpty {
                Text("No rules: every device gets the default.").foregroundStyle(.secondary)
            }
            ForEach(Array(key.effective.rules.enumerated()), id: \.offset) { i, rule in
                RuleRow(number: i + 1, rule: rule, type: key.type)
            }
        } header: {
            Text("Rules")
        } footer: {
            Text((key.source.rules == "override" ? "Overridden here. " : "From the catalog. ") + "The first rule a device matches decides, for its rollout share; the rest get the default.")
        }
        if let o = key.override {
            Section("Override") {
                if let note = o.note { LabeledContent("Note", value: note) }
                if let at = o.updatedAt { LabeledContent("Changed", value: at.formatted(date: .abbreviated, time: .shortened)) }
                if !data.server.isDemo {
                    Button("Revert to the Catalog", systemImage: "arrow.uturn.backward", role: .destructive) { reverting = true }
                }
            }
        }
        Section("Changes") {
            KeyHistory(data: data, key: key.key, change: key.change)
            NavigationLink(value: AppRoute.configHistory(key: key.key)) { Text("All Changes to \(key.key)") }
        }
    }

    private func revert() async {
        guard let key = data.config?.keys.first(where: { $0.key == name }) else { return }
        do {
            let out = try await data.client.revertConfig(data.slug, key: name, base: key.change)
            data.replace(out.key, revision: out.revision)
            reverted += 1
            Telemetry.track("config_reverted")
        } catch HushError.conflict {
            problem = .conflict
            await data.loadConfig()
        } catch {
            problem = HushError(error)
        }
    }
}

/// A rule: who, how many, what.
struct RuleRow: View {
    let number: Int
    let rule: ConfigRule
    let type: ConfigType

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(number)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(describe(rule.when)).font(.subheadline)
                Spacer()
                ValueChip(value: rule.value, type: type)
            }
            HStack(spacing: 8) {
                Gauge(value: Double(rule.rollout), in: 0...100) { EmptyView() }
                    .gaugeStyle(.accessoryLinearCapacity)
                    .tint(.accentColor)
                Text("\(rule.rollout)%").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(minWidth: 36, alignment: .trailing)
            }
            if let note = rule.note, !note.isEmpty {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The key's last few changes.
private struct KeyHistory: View {
    let data: AppData
    let key: String
    /// Read again when the key changes.
    let change: Int

    var body: some View {
        Remote(key: change, height: 44) {
            try await data.client.configHistory(data.slug, key: key, limit: 3)
        } content: { history in
            if history.changes.isEmpty {
                Text("Never changed here.").foregroundStyle(.secondary)
            }
            ForEach(history.changes) { ChangeRow(change: $0, showKey: false) }
        }
    }
}
