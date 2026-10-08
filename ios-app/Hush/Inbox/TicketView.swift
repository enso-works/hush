import HushKit
import SwiftUI

/// One message and its replies, the details the app sent with it, and a
/// reply field kept above the keyboard.
struct TicketView: View {
    let inbox: Inbox
    let id: ServerID
    let appName: (String) -> String
    /// After a delete: the thread is gone, so the list takes over.
    let deleted: () -> Void

    @State private var ticket: Ticket?
    /// Counts answers to animate on (see AppData.arrivals).
    @State private var arrivals = 0
    @State private var error: HushError?
    @State private var draft = ""
    /// A reply on its way: shown in the thread at once, dimmed until the server has it.
    @State private var pending: String?
    @State private var problem: HushError?
    @State private var sent = 0
    @State private var deleting = false
    @State private var editingReplies = false
    @AppStorage(QuickReplies.key) private var saved = QuickReplies()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error { ErrorNote(error: error) { await load() } }
                    if let ticket {
                        Header(ticket: ticket, appName: appName(ticket.app))
                        Details(ticket: ticket)
                        Conversation(ticket: ticket, pending: pending)
                    } else if error == nil {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .animation(arrival(reduceMotion: reduceMotion), value: arrivals)
                .padding(16)
            }
            // A long thread opens at its newest reply; a short one sits at the top.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .scrollDismissesKeyboard(.interactively)
            .background(Color(.systemGroupedBackground))
            .pinnedBar(.bottom) {
                if ticket != nil { composer }
            }
            .onChange(of: pending) { _, new in
                if new != nil { withAnimation(reduceMotion ? nil : .smooth) { proxy.scrollTo("end", anchor: .bottom) } }
            }
        }
        .navigationTitle(ticket.map { "#\($0.id.value)" } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let ticket { ToolbarItem(placement: .topBarTrailing) { actions(ticket) } }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $editingReplies) { QuickRepliesSheet() }
        .confirmationDialog("Delete this message and its replies?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { delete() }
        } message: {
            Text("For a user who asked for it to be deleted. This cannot be undone.")
        }
        .alert("That did not work", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }), presenting: problem) { _ in
            Button("OK") {}
        } message: { Text($0.message) }
        .sensoryFeedback(.success, trigger: sent)
        .sensoryFeedback(trigger: problem) { _, new in new == nil ? nil : .error }
        .onAppear { Telemetry.screen("feedback_thread") }
    }

    // MARK: - The reply field

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let email = ticket?.email {
                Label("Also sent by email to \(email)", systemImage: "envelope")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.leading, 4)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    ForEach(saved.items, id: \.self) { text in
                        Button(text) { draft = trimmed.isEmpty ? text : draft + "\n\n" + text }
                    }
                    if !saved.items.isEmpty { Divider() }
                    if !trimmed.isEmpty, !saved.items.contains(trimmed) {
                        Button("Save as Quick Reply", systemImage: "plus") { saved.items.append(trimmed) }
                    }
                    Button("Edit Quick Replies…", systemImage: "pencil") { editingReplies = true }
                } label: {
                    Image(systemName: "text.bubble")
                        .font(.title3)
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel("Quick replies")

                TextField("Reply", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .accessibilityIdentifier("reply")
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 18))

                // A tap sends; holding offers to close the thread with the reply.
                Menu {
                    Button("Send and Close", systemImage: "checkmark.circle") { send(close: true) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .symbolRenderingMode(.hierarchical)
                } primaryAction: {
                    send(close: false)
                }
                .disabled(trimmed.isEmpty || pending != nil)
                .accessibilityLabel("Send")
                .accessibilityHint("Hold to send and close the conversation.")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - Actions

    private func actions(_ ticket: Ticket) -> some View {
        Menu {
            if ticket.status == .closed {
                Button("Reopen", systemImage: "arrow.uturn.backward") { setStatus(.open) }
            } else {
                Button("Close", systemImage: "checkmark") { setStatus(.closed) }
            }
            if let email = ticket.email {
                Button("Copy Email", systemImage: "doc.on.doc") { UIPasteboard.general.string = email }
            }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) { deleting = true }
        } label: {
            Label("Actions", systemImage: "ellipsis.circle")
        }
    }

    private func load() async {
        do {
            let fresh = try await inbox.ticket(id)
            ticket = fresh
            error = nil
            arrivals += 1
        } catch is CancellationError {
        } catch {
            self.error = HushError(error)
        }
    }

    private func send(close: Bool) {
        let body = trimmed
        guard !body.isEmpty, pending == nil else { return }
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { pending = body }
        draft = ""
        Task {
            do {
                let result = try await inbox.reply(id, body: body, close: close)
                Telemetry.track("ticket_replied", ["closed": close ? "yes" : "no", "emailed": result.emailed == true ? "yes" : "no"])
                sent += 1
                await load()
            } catch {
                // The words come back to the field, so nothing typed is lost.
                draft = body
                problem = HushError(error)
            }
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { pending = nil }
        }
    }

    private func setStatus(_ status: TicketStatus) {
        Task {
            do {
                try await inbox.setStatus(id, status)
                Telemetry.track("ticket_status", ["status": status.rawValue])
                sent += 1
                await load()
            } catch {
                problem = HushError(error)
            }
        }
    }

    private func delete() {
        Task {
            do {
                try await inbox.delete(id)
                Telemetry.track("ticket_deleted")
                deleted()
            } catch {
                problem = HushError(error)
            }
        }
    }
}

/// The app, kind, status and subject above the conversation.
private struct Header: View {
    let ticket: Ticket
    let appName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                AppMark(slug: ticket.app, name: appName, size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(appName).font(.subheadline.weight(.semibold))
                    Label(ticket.kind.label, systemImage: ticket.kind.symbol)
                        .font(.caption)
                        .foregroundStyle(ticket.kind.tint)
                }
                Spacer()
                StatusPill(status: ticket.status)
            }
            if let subject = ticket.subject {
                Text(subject).font(.title3.weight(.semibold))
            }
        }
    }
}

/// The user's message, then every reply, theirs on the left and yours on the right.
private struct Conversation: View {
    let ticket: Ticket
    let pending: String?

    var body: some View {
        VStack(spacing: 10) {
            Bubble(text: ticket.message, mine: false, caption: ticket.createdAt.formatted(date: .abbreviated, time: .shortened))
            ForEach(ticket.replies) { reply in
                let mine = reply.author != .user
                Bubble(text: reply.body, mine: mine,
                       caption: reply.at.formatted(date: .abbreviated, time: .shortened) + (mine && reply.emailed ? " · emailed" : ""))
            }
            if let pending {
                Bubble(text: pending, mine: true, caption: "Sending…")
                    .opacity(0.6)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}

private struct Bubble: View {
    let text: String
    let mine: Bool
    let caption: String

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .foregroundStyle(mine ? .white : .primary)
                .background(mine ? Color.accentColor : Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 18))
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, 40)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(mine ? "You: " : "User: ") + Text(text))
        .accessibilityValue(caption)
    }
}

/// What the app sent about itself, and how to reach the user: one line
/// until opened, so the conversation stays the first thing on the screen.
private struct Details: View {
    let ticket: Ticket
    @State private var open = false

    /// The SDK's names for what it sends, in the order a reader wants them.
    private static let known: [(String, String)] = [
        ("version", "Version"), ("build", "Build"), ("os", "System"), ("device", "Device"),
        ("locale", "Language"), ("pro", "Paid"),
    ]

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            VStack(spacing: 8) {
                // A ticket with an email has no install: never one next to the other.
                if let email = ticket.email { row("Email", email) }
                if let install = ticket.install { row("Install", install, mono: true) }
                if let rc = ticket.rcId { row("Customer", rc, mono: true) }
                ForEach(diag, id: \.0) { row($0.0, $0.1) }
                row("Sent", ticket.createdAt.formatted(date: .long, time: .shortened))
            }
            .padding(.top, 8)
        } label: {
            // Grey, not the accent a disclosure label takes: it is information, not an action.
            Text(summary)
                .font(.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
    }

    /// Version, device and language, or what there is of them.
    private var summary: String {
        let values = ticket.diag ?? [:]
        let parts = ["version", "device", "locale"].compactMap { values[$0].map(Self.text) }
        return parts.isEmpty ? "Details" : parts.joined(separator: " · ")
    }

    private var diag: [(String, String)] {
        let values = ticket.diag ?? [:]
        let named = Self.known.compactMap { key, label in values[key].map { (label, Self.text($0)) } }
        let rest = values.keys.filter { k in !Self.known.contains { $0.0 == k } }.sorted().map { (eventLabel($0), Self.text(values[$0]!)) }
        return named + rest
    }

    private static func text(_ value: JSONValue) -> String {
        if case .bool(let b) = value { return b ? "Yes" : "No" }
        return value.description
    }

    private func row(_ label: String, _ value: String, mono: Bool = false) -> some View {
        LabeledContent(label) {
            Text(value)
                .font(mono ? .caption.monospaced() : .subheadline)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .font(.subheadline)
    }
}
