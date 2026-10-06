import HushKit
import SwiftUI

/// Feedback from every app on the server: filter, search, and answer. The
/// list and the open thread sit side by side on an iPad, and the thread
/// pushes onto the list on an iPhone.
struct InboxView: View {
    let server: Server
    @Bindable var inbox: Inbox

    @Environment(AppModel.self) private var model
    @State private var selection: ServerID?
    @State private var search = ""
    @State private var apps: [String: String] = [:]
    @State private var editingReplies = false
    /// The list stays in view beside the thread, in portrait too: an inbox is read from its list.
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            TicketList(inbox: inbox, apps: apps, selection: $selection, searching: !search.isEmpty)
                .navigationTitle("Feedback")
                .searchable(text: $search, prompt: "Subject, message, email or #id")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        FilterMenu(query: $inbox.query, apps: apps, editingReplies: $editingReplies)
                    }
                }
        } detail: {
            if let selection {
                TicketView(inbox: inbox, id: selection, appName: { apps[$0] ?? $0 }, deleted: { self.selection = nil })
                    .id(selection)
            } else {
                ContentUnavailableView("No message selected", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Pick one from the list to read and answer it."))
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $editingReplies) { QuickRepliesSheet() }
        .task(id: inbox.query) { await inbox.load() }
        .task(id: search) {
            // A search waits for a pause in typing, so each letter is not a request.
            if !search.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
            guard !Task.isCancelled else { return }
            let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
            if inbox.query.search ?? "" != text { inbox.query.search = text.isEmpty ? nil : text }
        }
        .task(id: server) { await loadApps() }
        .onAppear { Telemetry.screen("feedback_inbox") }
    }

    /// The apps' names, for the rows and the filter. Without them, slugs.
    private func loadApps() async {
        guard let answer = try? await model.client(for: server).apps(days: 1) else { return }
        apps = Dictionary(answer.apps.map { ($0.app, $0.name) }, uniquingKeysWith: { a, _ in a })
    }
}

private struct TicketList: View {
    @Bindable var inbox: Inbox
    let apps: [String: String]
    @Binding var selection: ServerID?
    let searching: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var deleting: TicketSummary?
    @State private var problem: HushError?
    @State private var done = 0

    var body: some View {
        List(selection: $selection) {
            if let error = inbox.error {
                ErrorNote(error: error) { await inbox.load() }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
            }
            if !inbox.loaded {
                ForEach(Placeholder.tickets) { TicketRow(ticket: $0, appName: "Application") }
                    .placeholder(true)
            }
            ForEach(inbox.tickets) { ticket in
                TicketRow(ticket: ticket, appName: apps[ticket.app] ?? ticket.app)
                    .tag(ticket.id)
                    .swipeActions(edge: .leading) { statusButton(ticket) }
                    .swipeActions(edge: .trailing) {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = ticket }
                    }
                    .contextMenu {
                        statusButton(ticket)
                        if let email = ticket.email {
                            Button("Copy Email", systemImage: "doc.on.doc") { UIPasteboard.general.string = email }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = ticket }
                    }
            }
            if inbox.more {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
                    .task { await inbox.loadMore() }
            }
        }
        .listStyle(.plain)
        .safeAreaInset(edge: .top, spacing: 0) {
            StatusPicker(status: $inbox.query.status, counts: inbox.counts)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
        }
        .overlay { if inbox.loaded, inbox.tickets.isEmpty, inbox.error == nil { empty } }
        .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: inbox.tickets.map(\.id))
        .refreshable { await inbox.load() }
        .sensoryFeedback(.success, trigger: done)
        .sensoryFeedback(trigger: problem) { _, new in new == nil ? nil : .error }
        .confirmationDialog("Delete this message and its replies?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { ticket in
            Button("Delete", role: .destructive) { act { try await inbox.delete(ticket.id) } }
        } message: { _ in
            Text("For a user who asked for it to be deleted. This cannot be undone.")
        }
        .alert("That did not work", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }), presenting: problem) { _ in
            Button("OK") {}
        } message: { Text($0.message) }
    }

    @ViewBuilder private func statusButton(_ ticket: TicketSummary) -> some View {
        if ticket.status == .closed {
            Button("Reopen", systemImage: "arrow.uturn.backward") { act { try await inbox.setStatus(ticket.id, .open) } }
                .tint(.accentColor)
        } else {
            Button("Close", systemImage: "checkmark") { act { try await inbox.setStatus(ticket.id, .closed) } }
                .tint(.gray)
        }
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            do {
                try await work()
                done += 1
            } catch {
                problem = HushError(error)
            }
        }
    }

    @ViewBuilder private var empty: some View {
        if searching {
            ContentUnavailableView.search
        } else {
            switch inbox.query.status {
            case .open?:
                ContentUnavailableView("Nothing open", systemImage: "checkmark.bubble",
                                       description: Text("New feedback from your apps shows here."))
            case let status?:
                ContentUnavailableView("Nothing \(status.label.lowercased())", systemImage: "bubble.left.and.bubble.right")
            case nil:
                ContentUnavailableView("No feedback yet", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Feedback your users send from your apps shows here."))
            }
        }
    }
}

/// Open, Answered, Closed or All, each with its count once the server gives
/// them and the width allows: a narrow list (an iPad's, in portrait) has the
/// words alone rather than cut ones.
private struct StatusPicker: View {
    @Binding var status: TicketStatus?
    let counts: TicketPage.Counts?

    var body: some View {
        ViewThatFits(in: .horizontal) {
            if let counts { picker(counts).fixedSize() }
            picker(nil)
        }
        .sensoryFeedback(.selection, trigger: status)
    }

    private func picker(_ counts: TicketPage.Counts?) -> some View {
        Picker("Status", selection: $status) {
            ForEach(TicketStatus.allCases, id: \.self) { s in
                Text(counts.map { "\(s.label) \($0[s])" } ?? s.label).tag(Optional(s))
            }
            Text("All").tag(TicketStatus?.none)
        }
        .pickerStyle(.segmented)
    }
}

/// Kind and app filters, and the quick replies.
private struct FilterMenu: View {
    @Binding var query: TicketQuery
    let apps: [String: String]
    @Binding var editingReplies: Bool

    var body: some View {
        Menu {
            Picker("Kind", selection: $query.kind) {
                Text("All kinds").tag(TicketKind?.none)
                ForEach(TicketKind.allCases, id: \.self) { Label($0.plural, systemImage: $0.symbol).tag(Optional($0)) }
            }
            if apps.count > 1 {
                Picker("App", selection: $query.app) {
                    Text("All apps").tag(String?.none)
                    ForEach(apps.sorted { $0.value < $1.value }, id: \.key) { Text($0.value).tag(Optional($0.key)) }
                }
            }
            Divider()
            Button("Quick Replies…", systemImage: "text.bubble") { editingReplies = true }
        } label: {
            let filtered = query.kind != nil || query.app != nil
            Label("Filter", systemImage: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .sensoryFeedback(.selection, trigger: query.kind)
        .sensoryFeedback(.selection, trigger: query.app)
    }
}

private struct TicketRow: View {
    let ticket: TicketSummary
    let appName: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            KindBadge(kind: ticket.kind)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(ticket.subject ?? ticket.preview)
                        .font(.subheadline.weight(ticket.status == .open ? .semibold : .regular))
                        .lineLimit(ticket.subject == nil ? 2 : 1)
                    Spacer(minLength: 8)
                    Text(when(ticket.createdAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if ticket.subject != nil {
                    Text(ticket.preview)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    Text(appName).lineLimit(1)
                    if ticket.replies > 0 {
                        Label("\(ticket.replies)", systemImage: "arrowshape.turn.up.left")
                            .accessibilityLabel(ticket.replies == 1 ? "1 reply" : "\(ticket.replies) replies")
                    }
                    if ticket.email != nil {
                        Image(systemName: "envelope").accessibilityLabel("Left an email")
                    }
                    Spacer(minLength: 0)
                    if ticket.status != .open { StatusPill(status: ticket.status) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
