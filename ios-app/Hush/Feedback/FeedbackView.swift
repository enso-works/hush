import Hush
import SwiftUI

// Feedback from this app to the hush team, through the Swift SDK: the app is
// on its own hush like any other. This file imports the SDK alone: its Ticket
// and HushKit's share a name. Its screens are never sent as screen views, as
// hush asks of every app's feedback screens.

/// Write to the team, and read the answers.
struct FeedbackView: View {
    @State private var kind = Ticket.Kind.issue
    @State private var subject = ""
    @State private var message = ""
    @State private var email = ""
    @State private var sending = false
    @State private var problem: String?
    @State private var sent = 0
    @State private var tickets: [Ticket] = []
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                Picker("Kind", selection: $kind) {
                    Text("Problem").tag(Ticket.Kind.issue)
                    Text("Idea").tag(Ticket.Kind.feature)
                    Text("Kind words").tag(Ticket.Kind.love)
                }
                .pickerStyle(.segmented)
                TextField("Subject (optional)", text: $subject)
                TextField("Message", text: $message, axis: .vertical)
                    .lineLimit(4...10)
                TextField("Email, for a reply by mail (optional)", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await send() }
                } label: {
                    if sending { ProgressView() } else { Text("Send") }
                }
                .disabled(sending || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let problem {
                    Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                }
            } header: {
                Text("Write to the hush team")
            } footer: {
                Text("The answer shows here, and by email if you leave an address. A message with an email is kept apart from this app's anonymous usage data.")
            }

            Section("Your messages") {
                if tickets.isEmpty {
                    Text(loaded ? "Nothing yet." : "Loading…").foregroundStyle(.secondary)
                }
                ForEach(tickets) { ticket in
                    NavigationLink {
                        ThreadView(ticket: ticket) { await load() }
                    } label: {
                        TicketRow(ticket: ticket)
                    }
                }
            }
        }
        .navigationTitle("Feedback")
        .task { await load() }
        .refreshable { await load() }
        .sensoryFeedback(.success, trigger: sent)
        .sensoryFeedback(trigger: problem) { _, new in new == nil ? nil : .error }
    }

    private func load() async {
        tickets = await Hush.listTickets()
        loaded = true
    }

    private func send() async {
        sending = true
        problem = nil
        defer { sending = false }
        let email = email.trimmingCharacters(in: .whitespaces)
        switch await Hush.createTicket(kind: kind, message: message.trimmingCharacters(in: .whitespacesAndNewlines),
                                       email: email.isEmpty ? nil : email, subject: subject.isEmpty ? nil : subject) {
        case .success:
            message = ""
            subject = ""
            sent += 1
            await load()
        case .failure(let failure):
            problem = FeedbackText.failure(failure)
        }
    }
}

private struct TicketRow: View {
    let ticket: Ticket

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(ticket.unread ? Color.accentColor : .clear).frame(width: 8, height: 8)
                .accessibilityLabel(ticket.unread ? "Unread reply" : "")
            VStack(alignment: .leading, spacing: 3) {
                Text(ticket.subject ?? ticket.message).lineLimit(1)
                Text(FeedbackText.status(ticket)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// One message and its answers, with a reply while it is open.
private struct ThreadView: View {
    let ticket: Ticket
    let changed: () async -> Void

    @State private var reply = ""
    @State private var replies: [Ticket.Reply]
    @State private var sending = false
    @State private var problem: String?

    init(ticket: Ticket, changed: @escaping () async -> Void) {
        self.ticket = ticket
        self.changed = changed
        _replies = State(initialValue: ticket.replies)
    }

    var body: some View {
        List {
            Section {
                Bubble(text: ticket.message, mine: true)
                ForEach(Array(replies.enumerated()), id: \.offset) { _, r in
                    Bubble(text: r.body, mine: r.author == "user")
                }
            }
            .listRowSeparator(.hidden)
            if ticket.status == "closed" {
                Text("This conversation is closed. Write a new message for anything else.").foregroundStyle(.secondary)
            } else {
                Section {
                    TextField("Reply", text: $reply, axis: .vertical).lineLimit(2...6)
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView() } else { Text("Send reply") }
                    }
                    .disabled(sending || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let problem { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
            }
        }
        .navigationTitle(ticket.subject ?? "Message")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send() async {
        sending = true
        defer { sending = false }
        let body = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        switch await Hush.replyToTicket(ticket.id, body: body) {
        case .success:
            reply = ""
            problem = nil
            // The thread as the server has it now, the reply included.
            if let fresh = await Hush.listTickets().first(where: { $0.id == ticket.id }) { replies = fresh.replies }
            await changed()
        case .failure(let failure):
            problem = FeedbackText.failure(failure)
        }
    }
}

private struct Bubble: View {
    let text: String
    let mine: Bool

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            Text(text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(mine ? Color.accentColor : Color(.secondarySystemFill), in: .rect(cornerRadius: 18))
                .foregroundStyle(mine ? .white : .primary)
            if !mine { Spacer(minLength: 40) }
        }
    }
}

enum FeedbackText {
    static func failure(_ failure: HushFailure) -> String {
        switch failure {
        case .offline: "Could not reach the hush team. Try again when you are online."
        case .tooMany: "That is a lot of messages for one day. Try again tomorrow."
        case .closed: "This conversation is closed. Write a new message instead."
        case .unavailable: "Feedback is not available in this build."
        case .failed: "That did not go through. Try again in a moment."
        }
    }

    static func status(_ ticket: Ticket) -> String {
        let answers = ticket.replies.filter { $0.author != "user" }.count
        switch ticket.status {
        case "answered": return answers == 1 ? "Answered" : "Answered · \(answers) replies"
        case "closed": return "Closed"
        default: return "Sent, waiting for an answer"
        }
    }
}
