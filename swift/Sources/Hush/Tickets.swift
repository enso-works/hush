import Foundation

// Feedback and forgetting, as the JavaScript core does them.
//
// A ticket sent with an email is contact info, so it must not be joinable to
// this install's usage data: it goes without the install id and RevenueCat's
// id, no ticket_opened marks the moment, and the server answers with a key to
// that one ticket, kept on the device. No request ever carries the install id
// and a thread key together.
extension HushClient {
    struct Diag: Encodable { let version, build, os, device: String; let pro: Bool? }

    /// Ticket id -> thread key, read fresh on every use, plus keys handed out
    /// in this process whose write failed. Nil when storage could not be parsed.
    func threads() -> [String: String] {
        let (key, unsaved) = withState { ($0.config.storageKey("threads"), $0.unsavedThreads) }
        let stored = decode([String: String].self, storage.string(key)) ?? [:]
        var out = stored.filter { id, key in
            !id.isEmpty && id.utf8.allSatisfy { (48...57).contains($0) } && Self.validThreadKey(key)
        }
        out.merge(unsaved) { _, new in new }
        return out
    }

    func saveThreads(_ change: (inout [String: String]) -> Void) {
        var map = threads()
        change(&map)
        let key = withState { $0.config.storageKey("threads") }
        guard let json = encode(map) else { return }
        storage.set(json, key)
        withState { s in
            for (id, k) in s.unsavedThreads where map[id] == k { s.unsavedThreads[id] = nil }
        }
    }

    /// Sends feedback: a problem, an idea, or kind words. With an email, the
    /// reply also goes by mail, and the ticket is kept apart from this install.
    /// Five a day per install. Returns the new ticket's id.
    public func createTicket(kind: Ticket.Kind, message: String, email: String? = nil,
                             subject: String? = nil) async -> Result<String, HushFailure> {
        let (enabled, installId, rcId, isPro) = withState { ($0.config.enabled, $0.installId, $0.rcId, $0.isPro) }
        guard enabled else { return .failure(.unavailable) }
        let d = device()
        // Version, build, OS, device and the paid flag describe the build, not the person.
        let diag = Diag(version: d.version, build: d.build, os: d.os, device: d.device, pro: isPro)
        let subject = subject.flatMap { $0.isEmpty ? nil : $0 }

        if let email, !email.isEmpty {
            struct Body: Encodable { let kind: String; let email: String; let subject: String?; let message: String; let diag: Diag }
            let answer = await post("/v1/tickets", Body(kind: kind.rawValue, email: email, subject: subject, message: message, diag: diag))
            guard let (data, res) = answer else { return .failure(.offline) }
            if res.statusCode == 429 { return .failure(.tooMany) }
            guard (200..<300).contains(res.statusCode) else { return .failure(.failed) }
            struct Created: Decodable { let id: HushValue?; let thread: String? }
            let created = try? JSONDecoder().decode(Created.self, from: data)
            let id = created?.id.map(Self.idString) ?? ""
            if !id.isEmpty, let thread = created?.thread, Self.validThreadKey(thread) {
                withState { $0.unsavedThreads[id] = thread }
                saveThreads { _ in }
            }
            return .success(id)
        }

        if installId.isEmpty { start() }
        struct Body: Encodable {
            let install: String; let kind: String; let rc_id: String?; let subject: String?; let message: String; let diag: Diag
        }
        let install = withState { $0.installId }
        let answer = await post("/v1/tickets", Body(install: install, kind: kind.rawValue, rc_id: rcId, subject: subject, message: message, diag: diag))
        guard let (data, res) = answer else { return .failure(.offline) }
        if res.statusCode == 429 { return .failure(.tooMany) }
        guard (200..<300).contains(res.statusCode) else { return .failure(.failed) }
        struct Created: Decodable { let id: HushValue? }
        enqueue("ticket_opened", ["kind": .string(kind.rawValue)])
        return .success((try? JSONDecoder().decode(Created.self, from: data))?.id.map(Self.idString) ?? "")
    }

    static func idString(_ v: HushValue) -> String {
        switch v {
        case .string(let s): s
        case .int(let i): String(i)
        case .double(let d): String(Int64(d))
        default: ""
        }
    }

    /// A reply on one of this device's tickets. A closed thread refuses: offer a new message instead.
    public func replyToTicket(_ id: String, body: String) async -> Result<Void, HushFailure> {
        guard withState({ $0.config.enabled }) else { return .failure(.unavailable) }
        let thread = threads()[id]
        if thread == nil, installationId.isEmpty { start() }
        struct ByThread: Encodable { let thread: String; let body: String }
        struct ByInstall: Encodable { let install: String; let body: String }
        let path = "/v1/tickets/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)/reply"
        let answer = if let thread {
            await post(path, ByThread(thread: thread, body: body))
        } else {
            await post(path, ByInstall(install: installationId, body: body))
        }
        guard let (_, res) = answer else { return .failure(.offline) }
        if res.statusCode == 409 { return .failure(.closed) }
        if res.statusCode == 429 { return .failure(.tooMany) }
        guard (200..<300).contains(res.statusCode) else { return .failure(.failed) }
        if thread == nil { enqueue("ticket_replied", [:]) }
        return .success(())
    }

    /// This install's tickets and the ones it sent with an email, newest first,
    /// with support's replies. Two requests, never one: the install's by its
    /// id, the others by their thread keys (the newest 50).
    public func listTickets() async -> [Ticket] {
        guard withState({ $0.config.enabled }) else { return [] }
        if installationId.isEmpty { start() }
        let map = threads()
        let keys = map.keys.sorted { $0.count != $1.count ? $0.count > $1.count : $0 > $1 }.prefix(Self.maxThreads).compactMap { map[$0] }
        struct Own: Encodable { let install: String }
        struct Keyed: Encodable { let threads: [String] }
        async let own = fetchTickets(Own(install: installationId), path: "/v1/tickets/list")
        async let keyed = keys.isEmpty ? [] : fetchTickets(Keyed(threads: keys), path: "/v1/tickets/threads")
        var seen = Set<String>()
        return (await own + keyed)
            .filter { seen.insert($0.id).inserted }
            .sorted { (Self.parse($0.createdAt) ?? .distantPast) > (Self.parse($1.createdAt) ?? .distantPast) }
    }

    static func parse(_ s: String) -> Date? {
        (try? Date(s, strategy: timestamp)) ?? (try? Date(s, strategy: .iso8601))
    }

    private func fetchTickets(_ body: some Encodable, path: String) async -> [Ticket] {
        guard let (data, res) = await post(path, body), (200..<300).contains(res.statusCode) else { return [] }
        return (try? JSONDecoder().decode(TicketsAnswer.self, from: data))?.tickets ?? []
    }

    struct TicketsAnswer: Decodable { let tickets: [Ticket] }

    /// The user's "delete my data": the tickets sent with an email whose keys
    /// this device holds, then everything stored about this install, and the
    /// SDK starts over with a new install id, without counting a new install.
    /// Offline or refused: nothing is lost, and calling it again finishes the rest.
    public func forget() async -> Result<Void, HushFailure> {
        guard withState({ $0.config.enabled }) else { return .failure(.unavailable) }
        if installationId.isEmpty { start() }
        guard !installationId.isEmpty else { return .failure(.failed) }
        // Nothing of this install may land after its delete: a send already out lands first, no new one starts.
        let sending = withState { s -> Task<Void, Never>? in
            s.forgetting = true
            return s.sending
        }
        defer { withState { $0.forgetting = false } }
        await sending?.value

        let map = threads()
        let ids = Array(map.keys)
        struct ByThreads: Encodable { let threads: [String] }
        for start in stride(from: 0, to: ids.count, by: Self.maxThreads) {
            let chunk = Array(ids[start..<min(start + Self.maxThreads, ids.count)])
            guard let (_, res) = await post("/v1/forget", ByThreads(threads: chunk.compactMap { map[$0] })) else { return .failure(.offline) }
            guard (200..<300).contains(res.statusCode) else { return .failure(.failed) }
            withState { s in for id in chunk { s.unsavedThreads[id] = nil } }
            saveThreads { stored in for id in chunk { stored[id] = nil } }
        }
        struct ByInstall: Encodable { let install: String }
        guard let (_, res) = await post("/v1/forget", ByInstall(install: installationId)) else { return .failure(.offline) }
        guard (200..<300).contains(res.statusCode) else { return .failure(.failed) }

        let fresh = Self.uuid()
        let config = withState { s -> Config in
            s.queue = []
            s.pendingSession = nil
            s.pendingSessionGeneration += 1
            s.installId = fresh
            s.onceKeys = []
            s.sessionCount = 0
            s.foregroundTime = 0
            return s.config
        }
        storage.set(fresh, config.storageKey("install"))
        for name in ["queue", "once", "sessions"] { storage.set(nil, config.storageKey(name)) }
        log(.debug, "forgotten; new install \(fresh)")
        restartSession()
        return .success(())
    }
}
