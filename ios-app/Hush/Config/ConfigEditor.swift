import HushKit
import SwiftUI

/// Changes a key's default and rules, previews what a device would get with
/// the change, and saves it with a note. Only the parts that differ from
/// what is served are sent: an untouched default stays the catalog's.
struct ConfigEditor: View {
    let data: AppData
    let key: ConfigKey

    @Environment(\.dismiss) private var dismiss
    @State private var value: ValueDraft
    @State private var rules: [RuleDraft]
    @State private var note = ""
    @State private var saving = false
    @State private var problem: String?
    @State private var device = DeviceContext(platform: "ios")
    @State private var saved = 0

    init(data: AppData, key: ConfigKey) {
        self.data = data
        self.key = key
        _value = State(initialValue: ValueDraft(key.effective.default, key.type))
        _rules = State(initialValue: key.effective.rules.map { RuleDraft($0, key.type) })
    }

    /// The write, or why there is none yet.
    private var write: Result<ConfigWrite?, DraftError> {
        do {
            let d = try value.parsed(key.type, field: "Default")
            let r = try rules.enumerated().map { i, rule in try rule.parsed(key.type, number: i + 1) }
            let newDefault = d == key.effective.default ? nil : d
            let newRules = r == key.effective.rules ? nil : r
            if newDefault == nil && newRules == nil { return .success(nil) }
            return .success(ConfigWrite(base: key.change, default: newDefault, rules: newRules, note: note))
        } catch let e as DraftError {
            return .failure(e)
        } catch {
            return .failure(DraftError(message: error.localizedDescription))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ValueField(draft: $value, type: key.type, label: "Default")
                } header: {
                    Text("Default")
                } footer: {
                    Text("What a device gets when no rule matches it. The catalog says \(display(key.catalog.default, key.type)).")
                }
                Section {
                    ForEach($rules) { $rule in
                        NavigationLink {
                            RuleEditor(rule: $rule, type: key.type)
                        } label: {
                            RuleSummary(rule: rule, number: (rules.firstIndex { $0.id == rule.id } ?? 0) + 1)
                        }
                    }
                    .onDelete { rules.remove(atOffsets: $0) }
                    .onMove { rules.move(fromOffsets: $0, toOffset: $1) }
                    if rules.count < data.config?.limits.rules ?? 20 {
                        Button("Add Rule", systemImage: "plus") {
                            rules.append(RuleDraft(ConfigRule(rollout: 100, value: key.effective.default), key.type))
                        }
                    }
                } header: {
                    HStack {
                        Text("Rules")
                        Spacer()
                        if rules.count > 1 { EditButton().font(.caption).textCase(nil) }
                    }
                } footer: {
                    Text("In order: the first rule a device matches decides. A rule at 30% gives its value to the same 30% of matching devices every time.")
                }
                Section {
                    PreviewForm(context: $device)
                    DraftOutcome(data: data, key: key, context: device, write: try? write.get())
                } header: {
                    Text("What a device gets")
                } footer: {
                    Text("With this change, for a device like this one. Nothing is saved until you do.")
                }
                Section {
                    TextField("Why (optional)", text: $note, axis: .vertical)
                } header: {
                    Text("Note")
                } footer: {
                    Text("Kept with the change in the history.")
                }
                if let message = problem ?? write.failureMessage {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(key.key)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled((try? write.get()) == nil)
                    }
                }
            }
            .interactiveDismissDisabled((try? write.get()) != nil)
            .sensoryFeedback(.success, trigger: saved)
            .sensoryFeedback(trigger: problem) { _, new in new == nil ? nil : .error }
        }
    }

    private func save() async {
        guard case .success(let w?) = write else { return }
        saving = true
        defer { saving = false }
        do {
            let out = try await data.client.setConfig(data.slug, key: key.key, w)
            data.replace(out.key, revision: out.revision)
            Telemetry.track("config_saved", ["default": w.default == nil ? "no" : "yes", "rules": w.rules == nil ? "no" : "yes"])
            saved += 1
            dismiss()
        } catch HushError.conflict {
            problem = HushError.conflict.message
            await data.loadConfig()
        } catch let e as HushError {
            if case .server(400, let message) = e { problem = message } else { problem = e.message }
        } catch {
            problem = HushError(error).message
        }
    }
}

struct DraftError: Error, Equatable {
    let message: String
}

extension Result where Failure == DraftError {
    var failureMessage: String? {
        if case .failure(let e) = self { return e.message }
        return nil
    }
}

/// A value as it is typed: text for numbers, strings and JSON, a switch for a bool.
struct ValueDraft: Equatable {
    var bool = false
    var text = ""

    init(_ value: JSONValue, _ type: ConfigType) {
        switch (type, value) {
        case (.bool, .bool(let b)): bool = b
        case (.string, .string(let s)): text = s
        case (.json, _): text = value.prettyJSON
        default: text = value.description
        }
    }

    func parsed(_ type: ConfigType, field: String) throws -> JSONValue {
        switch type {
        case .bool:
            return .bool(bool)
        case .number:
            let t = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
            guard let n = Double(t), n.isFinite else { throw DraftError(message: "\(field): a number, such as 3 or 0.5") }
            return .number(n)
        case .string:
            return .string(text)
        case .json, .other:
            do {
                return try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
            } catch {
                throw DraftError(message: "\(field): not valid JSON")
            }
        }
    }
}

extension JSONValue {
    /// Indented, keys sorted: for editing.
    var prettyJSON: String {
        guard let data = try? JSONEncoder.pretty.encode(self) else { return description }
        return String(decoding: data, as: UTF8.self)
    }
}

extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return e
    }()
}

/// The field for a value of the key's type.
struct ValueField: View {
    @Binding var draft: ValueDraft
    let type: ConfigType
    let label: String

    var body: some View {
        switch type {
        case .bool:
            Toggle(label, isOn: $draft.bool)
        case .number:
            TextField(label, text: $draft.text)
                .keyboardType(.decimalPad)
                .font(.body.monospacedDigit())
        case .string:
            TextField(label, text: $draft.text, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("value-\(label)")
        case .json, .other:
            TextEditor(text: $draft.text)
                .font(.callout.monospaced())
                .frame(minHeight: 120)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }
}

/// A rule as it is edited.
struct RuleDraft: Identifiable, Equatable {
    let id = UUID()
    var platforms: Set<String>
    var version: String
    var channels: String
    var languages: String
    /// nil: anyone.
    var pro: Bool?
    var rollout: Double
    var value: ValueDraft
    var note: String

    init(_ rule: ConfigRule, _ type: ConfigType) {
        platforms = Set(rule.when.platform ?? [])
        version = rule.when.version ?? ""
        channels = (rule.when.channel ?? []).joined(separator: ", ")
        languages = (rule.when.language ?? []).joined(separator: ", ")
        pro = rule.when.pro
        rollout = Double(rule.rollout)
        value = ValueDraft(rule.value, type)
        note = rule.note ?? ""
    }

    func parsed(_ type: ConfigType, number: Int) throws -> ConfigRule {
        let list = { (s: String) -> [String]? in
            let items = s.split(whereSeparator: { $0 == "," || $0 == " " }).map { $0.lowercased() }
            return items.isEmpty ? nil : items
        }
        let when = ConfigWhen(platform: platforms.isEmpty ? nil : platforms.sorted(),
                              version: version.nilIfBlank,
                              channel: list(channels),
                              language: list(languages),
                              pro: pro)
        return ConfigRule(when: when, rollout: Int(rollout.rounded()), value: try value.parsed(type, field: "Rule \(number)"), note: note.nilIfBlank)
    }
}

private struct RuleSummary: View {
    let rule: RuleDraft
    let number: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Rule \(number): \(Int(rule.rollout))%").font(.subheadline.weight(.medium))
            Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
    }

    private var summary: String {
        var parts: [String] = []
        if !rule.platforms.isEmpty { parts.append(rule.platforms.sorted().map(platformName).joined(separator: " or ")) }
        if let v = rule.version.nilIfBlank { parts.append("version \(v)") }
        if let c = rule.channels.nilIfBlank { parts.append(c) }
        if let l = rule.languages.nilIfBlank { parts.append("language \(l)") }
        if let pro = rule.pro { parts.append(pro ? "subscribers" : "not subscribers") }
        return parts.isEmpty ? "Every device" : parts.joined(separator: ", ")
    }
}

/// One rule: who it is for, how many of them, and what they get.
private struct RuleEditor: View {
    @Binding var rule: RuleDraft
    let type: ConfigType

    var body: some View {
        Form {
            Section {
                ForEach(["ios", "android", "web"], id: \.self) { p in
                    Toggle(platformName(p), isOn: Binding(get: { rule.platforms.contains(p) }, set: { on in
                        if on { rule.platforms.insert(p) } else { rule.platforms.remove(p) }
                    }))
                }
                TextField("Version, such as >=2.1.0 <3", text: $rule.version)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Picker("Subscribers", selection: $rule.pro) {
                    Text("Anyone").tag(Bool?.none)
                    Text("Subscribers").tag(Bool?.some(true))
                    Text("Not subscribers").tag(Bool?.some(false))
                }
                TextField("Channels, such as testflight", text: $rule.channels)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Languages, such as de, nl", text: $rule.languages)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("For")
            } footer: {
                Text("A device must match every condition given. None is every device; no platform switched on is every platform.")
            }
            Section {
                HStack {
                    Slider(value: $rule.rollout, in: 0...100, step: 5) { Text("Rollout") }
                    Text("\(Int(rule.rollout))%").font(.body.monospacedDigit()).frame(minWidth: 48, alignment: .trailing)
                }
                Stepper("Fine-tune", value: $rule.rollout, in: 0...100, step: 1)
            } header: {
                Text("Rollout")
            } footer: {
                Text("The share of matching devices that get this value. Raising it keeps the devices that already have it.")
            }
            Section("Value") {
                ValueField(draft: $rule.value, type: type, label: "Value")
            }
            Section("Note") {
                TextField("What it is for (optional)", text: $rule.note, axis: .vertical)
            }
        }
        .navigationTitle("Rule")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.selection, trigger: Int(rule.rollout) / 5)
    }
}

/// The device a preview is for.
struct PreviewForm: View {
    @Binding var context: DeviceContext

    var body: some View {
        Picker("Platform", selection: $context.platform) {
            Text("Any").tag(String?.none)
            ForEach(["ios", "android", "web"], id: \.self) { Text(platformName($0)).tag(Optional($0)) }
        }
        TextField("Version, such as 1.4.0", text: Binding(get: { context.version ?? "" }, set: { context.version = $0.nilIfBlank }))
            .font(.body.monospaced())
            .keyboardType(.numbersAndPunctuation)
        Picker("Subscriber", selection: $context.pro) {
            Text("Unknown").tag(Bool?.none)
            Text("Yes").tag(Bool?.some(true))
            Text("No").tag(Bool?.some(false))
        }
        TextField("Language, such as de", text: Binding(get: { context.language ?? "" }, set: { context.language = $0.nilIfBlank }))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }
}

/// The key's outcomes for the device, with the draft applied.
private struct DraftOutcome: View {
    let data: AppData
    let key: ConfigKey
    let context: DeviceContext
    let write: ConfigWrite?

    private struct Ask: Hashable { let context: DeviceContext; let write: ConfigWrite? }

    var body: some View {
        Remote(key: Ask(context: context, write: write), height: 44) {
            // Typing waits for a pause before it is a request.
            try await Task.sleep(for: .milliseconds(350))
            return try await data.client.configPreview(data.slug, context, key: key.key, draft: write)
        } content: { preview in
            if let k = preview.keys.first(where: { $0.key == key.key }) {
                Outcomes(outcomes: k.outcomes, type: key.type)
            }
            ForEach(preview.warnings, id: \.self) { w in
                Label(w, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// How a key comes out: each value and the share of such devices that get it.
struct Outcomes: View {
    let outcomes: [ConfigPreview.Outcome]
    let type: ConfigType

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(outcomes.enumerated()), id: \.offset) { _, o in
                HStack {
                    ValueChip(value: o.value, type: type)
                    Text(o.rule < 0 ? "the default" : "rule \(o.rule + 1)").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text((o.share / 100).formatted(.percent.precision(.fractionLength(0)))).font(.subheadline.weight(.semibold).monospacedDigit())
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
