import Foundation
import os

/// The Swift SDK's version, sent with every batch and stored on the install.
public let sdkVersion = "0.1.0"

/// One SDK instance. Apps use the one behind `Hush`; tests make their own with
/// stand-ins for storage, the network, the clock and the timers.
///
/// The same rules as the JavaScript core (sdk/src/core.ts), so the server and
/// the dashboard cannot tell them apart: a queue of up to 500 events kept for
/// 7 days, batches of 20 every 30 seconds and shortly after something happens,
/// a numbered session per return after 30 minutes away, once-per-install
/// events, the user's opt-out and forget, and feedback, where a ticket with an
/// email never carries the install id.
///
/// Every call returns at once and never throws. State sits behind one lock, so
/// calls are recorded in the order they are made; requests run on their own
/// tasks, never holding it.
public final class HushClient: @unchecked Sendable {
    // MARK: Limits, as the JavaScript core has them

    static let maxQueue = 500
    static let batchSize = 20
    static let flushInterval: TimeInterval = 30
    static let flushSoonDelay: TimeInterval = 3
    static let maxAge: TimeInterval = 7 * 24 * 3600
    static let sessionGap: TimeInterval = 30 * 60
    static let entryWindow: TimeInterval = 2.5
    static let maxOnce = 200
    static let maxThreads = 50
    /// `^[a-z][a-z0-9_]{min-1,max-1}$`: the server's rule for event names and channels. By hand: Regex needs iOS 16.
    static func snakeCase(_ s: String, _ lengths: ClosedRange<Int>) -> Bool {
        let u = Array(s.utf8)
        guard lengths.contains(u.count), let first = u.first, (97...122).contains(first) else { return false }
        return u.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 95 }
    }
    static func validName(_ s: String) -> Bool { snakeCase(s, 2...64) }
    static func validChannel(_ s: String) -> Bool { snakeCase(s, 1...24) }
    /// A ticket's thread key as the server mints it: 32 random bytes, base64url.
    static func validThreadKey(_ s: String) -> Bool {
        s.utf8.count == 43 && s.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }
    }
    static let campaignParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"]

    struct QueuedEvent: Codable, Equatable {
        var id: String
        var name: String
        var at: String
        var session: String
        var props: Props
        /// Only on the device: an event tracked with `once`, dropped if an earlier launch already sent it.
        var once: String?
    }

    struct Config {
        var url = ""
        var key = ""
        var prefix = "hush"
        var channel: String?
        var logLevel = LogLevel.silent
        var onFlush: (@Sendable (FlushResult) -> Void)?
        var enabled: Bool { !url.isEmpty && !key.isEmpty }
        func storageKey(_ name: String) -> String { "\(prefix).\(name).v1" }
    }

    struct State {
        var config = Config()
        var ready = false
        var installId = ""
        var sessionId = UUID().uuidString.lowercased()
        var queue: [QueuedEvent] = []
        var sending: Task<Void, Never>?
        var forgetting = false
        var retryAfter = Date.distantPast
        var failures = 0
        var rcId: String?
        var isPro: Bool?
        var globals: Props = [:]
        var onceKeys: [String] = []
        var onceLoaded = false
        var earlyOnce: [String: String] = [:]
        var optedOut = false
        var choiceBeforeStart: Bool?
        var paused = false
        var sessionCount = 0
        var foregroundTime: TimeInterval = 0
        var activeSince: Date?
        var backgroundedAt: Date?
        var pendingSession: QueuedEvent?
        var pendingSessionGeneration = 0
        var heldEntry: (entry: Entry, url: String?, at: Date, beforeStart: Bool)?
        var persistScheduled = false
        var flushSoonScheduled = false
        var timerStarted = false
        var unsavedThreads: [String: String] = [:]
    }

    let storage: HushStorage
    let transport: HushTransport
    let now: @Sendable () -> Date
    /// Runs work after a delay: a dispatch queue in the app, nothing in tests (they flush by hand).
    let schedule: @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> Void
    let device: @Sendable () -> DeviceInfo
    let isDebug: Bool
    private let lifecycle = LifecycleObserver()
    private let lock = NSLock()
    private var state = State()
    private let createdAt: Date
    private let logger = Logger(subsystem: "com.bavrk.hush.sdk", category: "hush")

    init(storage: HushStorage, transport: HushTransport, now: @escaping @Sendable () -> Date = Date.init,
         schedule: @escaping @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> Void,
         device: @escaping @Sendable () -> DeviceInfo = DeviceInfo.current, isDebug: Bool) {
        self.storage = storage
        self.transport = transport
        self.now = now
        self.schedule = schedule
        self.device = device
        self.isDebug = isDebug
        createdAt = now()
    }

    /// The instance `Hush` uses: UserDefaults, URLSession, a background queue for timers.
    static let shared: HushClient = {
        let timers = DispatchQueue(label: "com.bavrk.hush.timers")
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        return HushClient(
            storage: DefaultsStorage(defaults: .standard),
            transport: SessionTransport(session: .shared),
            schedule: { delay, work in timers.asyncAfter(deadline: .now() + delay, execute: work) },
            isDebug: debug
        )
    }()

    func withState<T>(_ body: (inout State) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    func log(_ level: LogLevel, _ message: String) {
        let configured = withState { $0.config.logLevel }
        switch (configured, level) {
        case (.silent, _), (.error, .debug), (_, .silent): return
        case (_, .error): logger.error("\(message, privacy: .public)")
        case (_, .debug): logger.debug("\(message, privacy: .public)")
        }
    }

    static let timestamp = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    func stamp(_ date: Date) -> String { date.formatted(Self.timestamp) }
    static func uuid() -> String { UUID().uuidString.lowercased() }

    // MARK: - Configure and start

    /// Call once, before `start()`; again replaces the configuration. A missing
    /// url or key leaves the SDK off: an empty key is the way to keep it off in
    /// a build that should not send.
    public func configure(url: String, key: String, channel: String? = nil, storagePrefix: String = "hush",
                          logLevel: LogLevel = .silent, onFlush: (@Sendable (FlushResult) -> Void)? = nil) {
        var trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let chosen = channel ?? (isDebug ? "dev" : Distribution.current.channel)
        let valid = chosen.flatMap { Self.validChannel($0) ? $0 : nil }
        withState {
            $0.config = Config(url: trimmed, key: key.trimmingCharacters(in: .whitespacesAndNewlines),
                               prefix: storagePrefix.isEmpty ? "hush" : storagePrefix,
                               channel: valid, logLevel: logLevel, onFlush: onFlush)
        }
        if let chosen, valid == nil { log(.error, "channel \"\(chosen)\" is not a short snake_case label; not sent") }
        if url.isEmpty, !key.isEmpty { log(.error, "url is empty: hush is off") }
    }

    /// Reads what earlier launches stored, starts the session and the timers.
    /// Safe to call more than once and before anything else. Events tracked
    /// before it are kept for this launch's session.
    public func start() {
        let config = withState { $0.config }
        guard config.enabled, !withState({ $0.ready }) else { return }
        let stored = storage.string(config.storageKey("install"))
        let first = storage.string(config.storageKey("first"))
        let storedOptOut = storage.string(config.storageKey("optout")) == "1"
        let storedQueue = decode([QueuedEvent].self, storage.string(config.storageKey("queue")))
        let storedOnce = decode([String].self, storage.string(config.storageKey("once"))) ?? []
        let storedSessions = decode(SessionsRecord.self, storage.string(config.storageKey("sessions")))
        let installId = stored ?? Self.uuid()
        if stored == nil { storage.set(installId, config.storageKey("install")) }

        withState { s in
            s.installId = installId
            s.optedOut = s.choiceBeforeStart ?? storedOptOut
            s.choiceBeforeStart = nil
            if s.optedOut {
                s.queue = []
                s.earlyOnce = [:]
            }
            let sent = Set(storedOnce)
            if !s.earlyOnce.isEmpty {
                s.queue.removeAll { e in s.earlyOnce[e.id].map(sent.contains) ?? false }
            }
            s.onceKeys = Array((storedOnce + s.onceKeys.filter { !sent.contains($0) }).suffix(Self.maxOnce))
            s.earlyOnce = [:]
            s.onceLoaded = true
            s.sessionCount = storedSessions?.n ?? 0
            s.foregroundTime = (storedSessions?.fg ?? 0) / 1000
            s.activeSince = nil
            if let previous = storedQueue, !s.optedOut {
                let cutoff = now().addingTimeInterval(-Self.maxAge)
                let kept = previous.filter { (try? Date($0.at, strategy: Self.timestamp)).map { $0 > cutoff } ?? false }
                s.queue = Array((kept + s.queue).suffix(Self.maxQueue))
            }
            s.ready = true
        }
        if withState({ $0.optedOut }) { storage.set(nil, config.storageKey("queue")) }
        persistOnce()
        persistQueue()
        if first == nil {
            enqueue("app_first_opened", [:])
            storage.set(stamp(now()), config.storageKey("first"))
        }
        startSession(first: true)
        lifecycle.start { [weak self] state in self?.appState(state) }
        startTimer()
        log(.debug, "ready: install \(installId), sdk swift-\(sdkVersion), channel \(config.channel ?? "(none)")")
        Task { await flush() }
    }

    struct SessionsRecord: Codable { var n: Int; var fg: Double }

    func decode<T: Decodable>(_ type: T.Type, _ raw: String?) -> T? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            log(.error, "a stored value could not be read: starting it empty")
            return nil
        }
    }

    func encode<T: Encodable>(_ value: T) -> String? {
        (try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) }
    }

    private func startTimer() {
        let started = withState { s -> Bool in
            defer { s.timerStarted = true }
            return s.timerStarted
        }
        guard !started else { return }
        tick()
    }

    private func tick() {
        schedule(Self.flushInterval) { [weak self] in
            guard let self else { return }
            // Also keeps the foreground time on disk for a process killed mid-session.
            self.persistSessions()
            Task { await self.flush() }
            self.tick()
        }
    }

    // MARK: - Events

    /// Records an event. `once`: at most once per install, ever (`true`), or
    /// once per install and key, for milestones a code path might fire twice.
    public func track(_ name: String, _ props: Props = [:], once: Bool = false, onceKey: String? = nil) {
        guard Self.validName(name) else {
            return log(.error, "event \"\(name)\" is not snake_case (a-z, 0-9, _; 2-64 chars): dropped")
        }
        if props.count > 40 { log(.error, "event \"\(name)\" has \(props.count) props; the server keeps at most 40") }
        guard once || onceKey != nil else {
            enqueue(name, props)
            return
        }
        let key = onceKey.map { "\(name):\($0)" } ?? name
        if withState({ $0.onceKeys.contains(key) }) { return log(.debug, "\"\(key)\" was already sent once: skipped") }
        guard let event = enqueue(name, props, once: key) else { return }
        let loaded = withState { s -> Bool in
            s.onceKeys = Array((s.onceKeys + [key]).suffix(Self.maxOnce))
            if !s.onceLoaded { s.earlyOnce[event.id] = key }
            return s.onceLoaded
        }
        if loaded { persistOnce() }
    }

    /// A screen the user sees. Leave out screens the app's catalog keeps private.
    public func screen(_ name: String) {
        enqueue("screen_viewed", ["screen": .string(name)])
    }

    /// Props added to every event from now on; an event's own props win. Kept in memory: set them each launch.
    public func setGlobalProps(_ props: Props) {
        withState { $0.globals.merge(props) { _, new in new } }
    }

    public func removeGlobalProp(_ key: String) {
        withState { _ = $0.globals.removeValue(forKey: key) }
    }

    /// RevenueCat's anonymous customer id, and whether the install is on a paid plan. Until `pro` is given, batches carry no flag.
    public func identify(pro: Bool? = nil, rcId: String? = nil) {
        withState { s in
            if let pro { s.isPro = pro }
            if let rcId, !rcId.isEmpty { s.rcId = rcId }
        }
    }

    @discardableResult
    func enqueue(_ name: String, _ props: Props, once: String? = nil) -> QueuedEvent? {
        let at = stamp(now())
        let (event, count) = withState { s -> (QueuedEvent?, Int) in
            guard s.config.enabled, !s.optedOut else { return (nil, 0) }
            let event = QueuedEvent(id: Self.uuid(), name: name, at: at, session: s.sessionId,
                                    props: s.globals.merging(props) { _, own in own }, once: once)
            s.queue.append(event)
            if s.queue.count > Self.maxQueue { s.queue.removeFirst(s.queue.count - Self.maxQueue) }
            return (event, s.queue.count)
        }
        guard event != nil else { return nil }
        persistSoon()
        if count >= Self.batchSize { Task { await flush() } } else { flushSoon() }
        return event
    }

    // MARK: - Sessions and entries

    private func startSession(first: Bool = false) {
        commitSession()
        let started = now()
        let (event, claim) = withState { s -> (QueuedEvent?, (entry: Entry, url: String?, at: Date, beforeStart: Bool)?) in
            if !first { s.sessionId = Self.uuid() }
            let claim = s.heldEntry
            s.heldEntry = nil
            // The session that just ended reports its foreground time with the next start:
            // an explicit "session ended" dies with the process whenever iOS kills the app.
            let previous = Int((s.foregroundTime + (s.activeSince.map { started.timeIntervalSince($0) } ?? 0)).rounded())
            s.foregroundTime = 0
            s.activeSince = started
            guard s.config.enabled, !s.optedOut else { return (nil, claim) }
            s.sessionCount += 1
            var props: Props = ["entry": "launch", "n": .int(s.sessionCount)]
            if s.sessionCount > 1, previous > 0 { props["prev_fg_s"] = .int(previous) }
            let event = QueuedEvent(id: Self.uuid(), name: "session_started", at: stamp(first ? createdAt : started),
                                    session: s.sessionId, props: props)
            s.pendingSession = event
            s.pendingSessionGeneration += 1
            return (event, claim)
        }
        persistSessions()
        guard event != nil else { return }
        // Held back for a moment, so the link or widget that opened the app can claim it (see entry()).
        let generation = withState { $0.pendingSessionGeneration }
        schedule(Self.entryWindow) { [weak self] in
            guard let self, self.withState({ $0.pendingSessionGeneration == generation }) else { return }
            self.commitSession()
        }
        if let claim, claim.beforeStart || started.timeIntervalSince(claim.at) <= Self.entryWindow {
            entry(claim.entry, url: claim.url)
        }
    }

    /// Puts the held session_started into the queue with whatever entry it has.
    func commitSession() {
        let committed = withState { s -> Bool in
            guard var event = s.pendingSession else { return false }
            s.pendingSession = nil
            s.pendingSessionGeneration += 1
            guard !s.optedOut else { return false }
            // Globals as they are now: the app may have set them after the session began.
            event.props = s.globals.merging(event.props) { _, own in own }
            s.queue.append(event)
            if s.queue.count > Self.maxQueue { s.queue.removeFirst(s.queue.count - Self.maxQueue) }
            return true
        }
        if committed {
            persistSoon()
            flushSoon()
        }
    }

    /// How this session began: a link, a notification, a widget. Claims the
    /// session that has just started, within 2.5 seconds of its start; made
    /// before the session exists, it waits for it. A link keeps only its
    /// campaign tags (utm_*, ref), never the URL.
    public func entry(_ entry: Entry, url: String? = nil) {
        let at = now()
        let claimed = withState { s -> Bool in
            guard s.pendingSession != nil else {
                // The first claim wins; a later one replaces it only once it has expired.
                if let held = s.heldEntry, held.beforeStart || at.timeIntervalSince(held.at) <= Self.entryWindow { return false }
                s.heldEntry = (entry, url, at, !s.ready)
                return false
            }
            s.pendingSession?.props["entry"] = .string(entry.rawValue)
            if let url { for (k, v) in Self.campaign(url) { s.pendingSession?.props[k] = v } }
            return true
        }
        if claimed { commitSession() }
    }

    static func campaign(_ url: String) -> Props {
        guard let items = URLComponents(string: url)?.queryItems else { return [:] }
        var out: Props = [:]
        for item in items {
            let key = item.name.lowercased()
            guard campaignParams.contains(key), out[key] == nil,
                  let value = item.value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { continue }
            out[key] = .string(String(value.prefix(64)))
        }
        return out
    }

    func appState(_ lifecycle: Lifecycle) {
        let at = now()
        switch lifecycle {
        case .background:
            withState { s in
                s.backgroundedAt = at
                if let since = s.activeSince {
                    s.foregroundTime += at.timeIntervalSince(since)
                    s.activeSince = nil
                }
            }
            persistSessions()
            // Leaving is the deadline: the session's entry is what it is now,
            // the queue goes to disk in case the send never finishes, and the
            // send gets background runway.
            commitSession()
            persistQueue()
            BackgroundTask.run { [weak self] in await self?.flushQueued() }
        case .active:
            let gap = withState { s -> Bool in
                if let away = s.backgroundedAt, at.timeIntervalSince(away) > Self.sessionGap { return true }
                if s.activeSince == nil { s.activeSince = at }
                return false
            }
            if gap { startSession() }
        }
    }

    // MARK: - Persistence

    func persistSessions() {
        let (key, record) = withState { s in
            (s.config.storageKey("sessions"),
             SessionsRecord(n: s.sessionCount, fg: (s.foregroundTime + (s.activeSince.map { now().timeIntervalSince($0) } ?? 0)) * 1000))
        }
        storage.set(encode(record), key)
    }

    func persistOnce() {
        let (key, keys, loaded) = withState { ($0.config.storageKey("once"), $0.onceKeys, $0.onceLoaded) }
        if loaded { storage.set(encode(Array(keys.suffix(Self.maxOnce))), key) }
    }

    /// Before start() has merged the stored queue, memory holds only this
    /// launch's early events: writing them would replace the last launch's unsent ones.
    func persistQueue() {
        let (key, queue, ready) = withState { s -> (String, [QueuedEvent], Bool) in
            s.persistScheduled = false
            return (s.config.storageKey("queue"), s.queue, s.ready)
        }
        if ready { storage.set(encode(Array(queue.suffix(Self.maxQueue))), key) }
    }

    private func persistSoon() {
        let go = withState { s -> Bool in
            guard s.ready, !s.persistScheduled else { return false }
            s.persistScheduled = true
            return true
        }
        if go { schedule(1) { [weak self] in self?.persistQueue() } }
    }

    private func flushSoon() {
        let go = withState { s -> Bool in
            guard !s.flushSoonScheduled else { return false }
            s.flushSoonScheduled = true
            return true
        }
        guard go else { return }
        schedule(Self.flushSoonDelay) { [weak self] in
            guard let self else { return }
            self.withState { $0.flushSoonScheduled = false }
            Task { await self.flush() }
        }
    }

    // MARK: - Sending

    func request(_ method: String, _ path: String, body: (any Encodable)?) -> URLRequest? {
        let config = withState { $0.config }
        guard let url = URL(string: config.url + path) else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.timeoutInterval = 30
        r.setValue("Key \(config.key)", forHTTPHeaderField: "Authorization")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONEncoder().encode(body)
        }
        return r
    }

    /// The answer, or nil when none came.
    func post(_ path: String, _ body: some Encodable) async -> (Data, HTTPURLResponse)? {
        guard let r = request("POST", path, body: body) else { return nil }
        return try? await transport.send(r)
    }

    struct Batch: Encodable {
        struct Context: Encodable {
            let version, build, platform, os, device, locale: String
            let rc_id: String?
            let pro: Bool?
            let channel: String?
        }
        struct Event: Encodable { let id, name, at, session: String; let props: Props; let install: String }
        let sent_at: String
        let sdk: String
        let context: Context
        let events: [Event]
    }

    /// Sends one batch, or waits for the send in flight. Never throws.
    public func flush() async {
        let task = withState { s -> Task<Void, Never>? in
            if let sending = s.sending { return sending }
            guard s.config.enabled, !s.optedOut, !s.paused, !s.forgetting, s.ready, !s.queue.isEmpty,
                  now() >= s.retryAfter else { return nil }
            // The send clears its own slot, as its last step: cleared by whoever
            // awaited it instead, a caller waking in between would take a finished
            // send for one in flight and skip its own. The lock is held until the
            // slot is set, so the task cannot clear it first.
            let task = Task { [weak self] in
                guard let self else { return }
                await self.send()
                self.withState { $0.sending = nil }
            }
            s.sending = task
            return task
        }
        await task?.value
    }

    /// Whatever is held, then a send after the one in flight: for leaving, and for tests.
    public func flushQueued() async {
        commitSession()
        if let sending = withState({ $0.sending }) { await sending.value }
        await flush()
    }

    private func send() async {
        let (batch, body, onFlush) = withState { s -> ([QueuedEvent], Batch, (@Sendable (FlushResult) -> Void)?) in
            let batch = Array(s.queue.prefix(Self.batchSize))
            let d = device()
            let context = Batch.Context(version: d.version, build: d.build, platform: d.platform, os: d.os, device: d.device,
                                        locale: d.locale, rc_id: s.rcId, pro: s.isPro, channel: s.config.channel)
            let events = batch.map { Batch.Event(id: $0.id, name: $0.name, at: $0.at, session: $0.session, props: $0.props, install: s.installId) }
            return (batch, Batch(sent_at: stamp(now()), sdk: "swift-\(sdkVersion)", context: context, events: events), s.config.onFlush)
        }
        let answer = await post("/v1/events", body)
        let status = answer?.1.statusCode
        // 2xx is stored; a 4xx other than a rate limit will never be accepted, so it goes too.
        let done = status.map { (200..<300).contains($0) || ((400..<500).contains($0) && $0 != 429) } ?? false
        withState { s in
            if done {
                // By id, not position: opt-out, forget or the cap may have replaced the queue meanwhile.
                let sent = Set(batch.map(\.id))
                s.queue.removeAll { sent.contains($0.id) }
                s.failures = 0
            } else {
                s.failures += 1
                s.retryAfter = now().addingTimeInterval(min(5 * pow(2, Double(s.failures - 1)), 300))
            }
        }
        if done { persistQueue() }
        struct Counts: Decodable { var accepted, duplicate, rejected: Int? }
        let counts = answer.flatMap { (200..<300).contains($0.1.statusCode) ? try? JSONDecoder().decode(Counts.self, from: $0.0) : nil }
        let result = FlushResult(status: status, accepted: counts?.accepted ?? 0, duplicate: counts?.duplicate ?? 0,
                                 rejected: counts?.rejected ?? (done && !(200..<300).contains(status ?? 0) ? batch.count : 0),
                                 willRetry: !done)
        log(done && (200..<300).contains(status ?? 0) ? .debug : .error, "sent \(batch.count): \(result)")
        onFlush?(result)
    }

    /// Holds sends (not events) until resume(). Not remembered across launches.
    public func pause() { withState { $0.paused = true } }

    public func resume() {
        withState { $0.paused = false }
        Task { await flush() }
    }

    // MARK: - The user's choices

    /// The install id, or "" before start(): for a debug screen, to look the install up on the dashboard.
    public var installationId: String { withState { $0.installId } }

    public var isOptedOut: Bool { withState { $0.optedOut } }

    /// "Don't share anonymous usage", remembered across launches: nothing is
    /// queued or sent until optIn(), and what was queued is dropped. Feedback
    /// still works: a user sends that on purpose.
    public func optOut() {
        let key = withState { s -> String in
            if !s.ready { s.choiceBeforeStart = true }
            s.optedOut = true
            s.queue = []
            s.pendingSession = nil
            s.pendingSessionGeneration += 1
            return s.config.storageKey("optout")
        }
        storage.set("1", key)
        storage.set(nil, key.replacingOccurrences(of: ".optout.", with: ".queue."))
        log(.debug, "opted out")
    }

    /// A new session for a new install id (after forget()).
    func restartSession() {
        if withState({ $0.ready }) { startSession() }
    }

    public func optIn() {
        let (changed, ready, key) = withState { s -> (Bool, Bool, String) in
            if !s.ready { s.choiceBeforeStart = false } else if !s.optedOut { return (false, true, "") }
            s.optedOut = false
            return (true, s.ready, s.config.storageKey("optout"))
        }
        guard changed else { return }
        storage.set(nil, key)
        log(.debug, "opted in")
        if ready { startSession() }
    }
}
