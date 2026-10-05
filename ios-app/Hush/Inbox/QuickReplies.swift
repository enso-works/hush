import SwiftUI

/// Answers written often ("Thanks, fixed in the next version"), kept on this
/// phone, one tap from the reply field.
struct QuickReplies: RawRepresentable, Equatable {
    var items: [String]

    init(_ items: [String] = []) { self.items = items }

    init?(rawValue: String) {
        guard let items = try? JSONDecoder().decode([String].self, from: Data(rawValue.utf8)) else { return nil }
        self.items = items
    }

    var rawValue: String {
        (try? String(decoding: JSONEncoder().encode(items), as: UTF8.self)) ?? "[]"
    }

    static let key = "quickReplies"
}

/// Add, remove and order the quick replies.
struct QuickRepliesSheet: View {
    @AppStorage(QuickReplies.key) private var saved = QuickReplies()
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("New quick reply", text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    Button("Add") {
                        saved.items.append(text)
                        draft = ""
                    }
                    .disabled(text.isEmpty || saved.items.contains(text))
                } footer: {
                    Text("Quick replies stay on this phone. Pick one from the reply field to start an answer with it.")
                }
                if !saved.items.isEmpty {
                    Section("Saved") {
                        ForEach(saved.items, id: \.self) { Text($0).lineLimit(3) }
                            .onDelete { saved.items.remove(atOffsets: $0) }
                            .onMove { saved.items.move(fromOffsets: $0, toOffset: $1) }
                    }
                }
            }
            .navigationTitle("Quick replies")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if !saved.items.isEmpty { ToolbarItem(placement: .topBarLeading) { EditButton() } }
            }
        }
    }
}
