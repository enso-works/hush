/**
 * hush core: the platform-free part of the SDK. The queue, batches, retries,
 * sessions, once-per-install events, global props, the user's opt-out and
 * forget, and feedback tickets, over the hush /v1 API.
 *
 * A platform gives it storage, the app's comings and goings, a description
 * of the device, and whether this is a development build: see HushPlatform.
 * `@enso/hush` (the default entry) is that for React Native and Expo.
 *
 * The only identifier is an install UUID it generates and keeps in storage.
 * Nothing here may ever break the app: every call is fire-and-forget, every
 * failure is swallowed, and a batch the server refuses is dropped rather than
 * retried forever.
 */

/** Where the SDK keeps its state: AsyncStorage, localStorage, a file... */
export type HushStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** 'background' also covers iOS's brief 'inactive': leaving is the deadline either way. */
export type LifecycleState = 'active' | 'background';

/** What a batch says about where it came from. Read at every send. */
export type DeviceInfo = { version: string; build: string; platform: string; os: string; device: string; locale: string };

export type HushPlatform = {
  storage: HushStorage;
  /** Calls back as the app comes to the foreground and leaves it. */
  onAppState(listener: (state: LifecycleState) => void): void;
  device(): DeviceInfo;
  isDev(): boolean;
  /** Defaults to the global fetch, looked up at every request. */
  fetch?: typeof fetch;
};
export type HushConfig = {
  /** The hush server, e.g. https://hush.example.com (no trailing slash). */
  url: string;
  /** A write key minted with `keys:create <app> <env>`. Empty: the SDK stays off. */
  key: string;
  /**
   * Prefix for the three AsyncStorage keys (install id, queue, first-open
   * marker). Changing it gives every install a new id, so an app moving from
   * a copied SDK to this package must pass the prefix it used before.
   */
  storagePrefix?: string;
  /**
   * Runs the flush that happens when the app goes to the background. By
   * default it just runs; pass a wrapper that asks the OS for background
   * time (a native background task) to give that fetch real runway before
   * the process is suspended.
   */
  runInBackground?: (work: () => Promise<void>) => Promise<void>;
  /**
   * Where this build came from, as the app knows it: `app_store`,
   * `testflight`, `play`, `internal`... (lowercase, snake_case, up to 24
   * characters). The dashboard filters by it, so TestFlight and dev-client
   * builds on a prod key stop counting as store users. Pass it from the build
   * profile (e.g. an EXPO_PUBLIC_ variable per EAS profile). Default: `dev`
   * in a __DEV__ build, otherwise not sent.
   */
  channel?: string;
  /** What the SDK says in the console: nothing (default), mistakes, or everything it does. */
  logLevel?: 'silent' | 'error' | 'debug';
  /** Called after every send to /v1/events, for debug screens and tests. */
  onFlush?: (result: FlushResult) => void;
};

/** One send's outcome. `willRetry`: the batch stays queued and goes again later. */
export type FlushResult = {
  status: number | 'offline';
  accepted: number;
  duplicate: number;
  rejected: number;
  willRetry: boolean;
};

/** Sent with every batch, and stored on the install: which SDK spoke. */
export const SDK_VERSION = '2.0.0';

const CHANNEL_RE = /^[a-z][a-z0-9_]{0,23}$/;
// The server's rule for event names; anything else is dropped there anyway.
const EVENT_NAME = /^[a-z][a-z0-9_]{1,63}$/;

type Value = string | number | boolean | null;
export type Props = Record<string, Value>;

// `once` marks an event tracked with { once }: kept on the device only, to
// drop it if an earlier launch already sent the same one.
type QueuedEvent = { id: string; name: string; at: string; session: string; props: Props; once?: string };

export type TicketKind = 'issue' | 'feature' | 'love';

export type Ticket = {
  id: string;
  kind: TicketKind;
  subject: string | null;
  message: string;
  status: 'open' | 'answered' | 'closed';
  created_at: string;
  unread: boolean;
  replies: { author: 'support' | 'user'; body: string; at: string }[];
};


const MAX_QUEUE = 500;
const BATCH = 20;
const FLUSH_MS = 30_000;
// A short session (open, glance, close) never reaches BATCH and often
// backgrounds before FLUSH_MS's first tick — and the backgrounding flush
// itself has no guaranteed runway once iOS starts suspending the process.
// Sending shortly after the events that matter fire, while still foreground,
// gets most sessions out the door before any of that is a factor.
const FLUSH_SOON_MS = 3_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A return after this long is a new session rather than a continuation.
const SESSION_GAP_MS = 30 * 60 * 1000;

const uuid = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Hermes has no crypto global in every build; a v4 from Math.random is
  // plenty for an identifier that only has to be unique across our installs.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
};

const MAX_ONCE = 200;
// Once-events queued before init() read the stored keys: id -> key, checked
// against them when they arrive.
const ENTRY_WINDOW_MS = 2500;

/**
 * Where a session began: the app's own doors (a widget, a quick action, a
 * notification, a deep link...). Any short snake_case string; the dashboard
 * slices sessions by it as it is. `launch` is the default.
 */
export type Entry = 'launch' | 'widget' | 'quick_action' | 'siri' | 'notification' | 'link' | (string & {});

// The campaign tags worth keeping from a link that opened the app, and
// nothing else from it: the URL itself may carry anything.
const CAMPAIGN_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref'];

function campaignOf(url: string): Props {
  const out: Props = {};
  // By hand: React Native's URL has no working searchParams on every version.
  const query = url.split('#')[0].split('?')[1] ?? '';
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    let key = '';
    let value = '';
    try {
      key = decodeURIComponent(rawKey).toLowerCase();
      value = decodeURIComponent(rawValue.replace(/\+/g, ' ')).trim();
    } catch {
      continue;
    }
    if (CAMPAIGN_PARAMS.includes(key) && value && !(key in out)) out[key] = value.slice(0, 64);
  }
  return out;
}


export type Hush = ReturnType<typeof createHush>;

/** One SDK instance on one platform. The default entry makes the one an app uses. */
export function createHush(platform: HushPlatform) {
  const storage = platform.storage;
  const doFetch: typeof fetch = (input, init) => (platform.fetch ?? globalThis.fetch)(input, init);


  let TELEMETRY_URL = '';
  let TELEMETRY_KEY = '';
  let INSTALL_KEY = 'hush.install.v1';
  let QUEUE_KEY = 'hush.queue.v1';
  let FIRST_KEY = 'hush.first.v1';
  let ONCE_KEY = 'hush.once.v1';
  let OPTOUT_KEY = 'hush.optout.v1';
  let SESSIONS_KEY = 'hush.sessions.v1';
  let withBackgroundTask: (work: () => Promise<void>) => Promise<void> = (work) => work();
  let CHANNEL: string | undefined;
  let LOG_LEVEL: 'silent' | 'error' | 'debug' = 'silent';
  let onFlush: ((result: FlushResult) => void) | undefined;

  const isDev = () => platform.isDev();
  function log(level: 'error' | 'debug', ...args: unknown[]) {
    if (LOG_LEVEL === 'silent' || (level === 'debug' && LOG_LEVEL !== 'debug')) return;
    // eslint-disable-next-line no-console
    (level === 'error' ? console.warn : console.log)('[hush]', ...args);
  }

  /** Call once, before init(). Calling it again replaces the configuration. */
  function configure(config: HushConfig): void {
    TELEMETRY_URL = config.url.replace(/\/+$/, '');
    TELEMETRY_KEY = config.key ?? '';
    const prefix = config.storagePrefix ?? 'hush';
    INSTALL_KEY = `${prefix}.install.v1`;
    QUEUE_KEY = `${prefix}.queue.v1`;
    FIRST_KEY = `${prefix}.first.v1`;
    ONCE_KEY = `${prefix}.once.v1`;
    OPTOUT_KEY = `${prefix}.optout.v1`;
    SESSIONS_KEY = `${prefix}.sessions.v1`;
    if (config.runInBackground) withBackgroundTask = config.runInBackground;
    LOG_LEVEL = config.logLevel ?? 'silent';
    onFlush = config.onFlush;
    const channel = config.channel ?? (isDev() ? 'dev' : undefined);
    CHANNEL = channel && CHANNEL_RE.test(channel) ? channel : undefined;
    if (channel && !CHANNEL) log('error', `channel "${channel}" is not a short snake_case label; not sent`);
    enabled = TELEMETRY_KEY.length > 0;
  }

  let enabled = false;
  let ready = false;
  let installId = '';
  let sessionId = uuid();
  let backgroundedAt = 0;
  let queue: QueuedEvent[] = [];
  let flushing = false;
  let retryAfter = 0;
  let failures = 0;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let flushSoonTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let rcId: string | undefined;
  let isPro = false;
  // Merged into every event's props (the event's own win), for context such as
  // a paywall variant. In memory: the app sets them again each launch.
  let globals: Props = {};
  // Keys of events tracked with { once } that this install has already sent.
  let onceKeys: string[] = [];
  let onceLoaded = false;
  const earlyOnce = new Map<string, string>();
  // The user said no to anonymous usage data (optOut): no events are kept or
  // sent. Feedback still works; it is something they send on purpose.
  let optedOut = false;
  // pause(): hold sends (not events) until resume(); not remembered across launches.
  let paused = false;
  // Sessions: how many this install has had, and the current one's time in the
  // foreground so far, reported with the next session_started.
  let sessionCount = 0;
  let foregroundMs = 0;
  let activeSince = 0;
  // The session_started event of the session that just began, held back from
  // the queue while its entry can still be claimed. A widget tap, a reminder,
  // Siri or a link all report themselves a moment *after* the app is active,
  // and init() flushes the queue the instant it is ready, so an event that
  // went straight into the queue would already be on the wire when the claim
  // arrived. Held out, it leaves with the right entry or, after the window,
  // as a plain launch. A process killed inside the window loses that one
  // session_started; the window is short enough that this is rare.
  let pendingSession: { event: QueuedEvent; timer: ReturnType<typeof setTimeout> } | null = null;
  function context() {
    return {
      ...platform.device(),
      rc_id: rcId,
      pro: isPro,
      channel: CHANNEL,
    };
  }

  const foregroundSoFar = () => foregroundMs + (activeSince ? Date.now() - activeSince : 0);

  function persistSessions() {
    void storage.setItem(SESSIONS_KEY, JSON.stringify({ n: sessionCount, fg: foregroundSoFar() })).catch(() => {});
  }

  function persistOnce() {
    if (!onceLoaded) return;
    void storage.setItem(ONCE_KEY, JSON.stringify(onceKeys.slice(-MAX_ONCE))).catch(() => {});
  }

  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      // Oldest first out: a queue this long means the service has been
      // unreachable for days, and the recent events are the useful ones.
      void storage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE))).catch(() => {});
    }, 1000);
  }

  async function post(path: string, body: unknown): Promise<Response | null> {
    try {
      return await doFetch(`${TELEMETRY_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Key ${TELEMETRY_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return null;
    }
  }

  async function flush(): Promise<void> {
    if (!enabled || optedOut || paused || !ready || flushing || queue.length === 0 || Date.now() < retryAfter) return;
    flushing = true;
    try {
      const batch = queue.slice(0, BATCH);
      const res = await post('/v1/events', {
        sent_at: new Date().toISOString(),
        sdk: SDK_VERSION,
        context: context(),
        events: batch.map(({ id, name, at, session, props }) => ({ id, name, at, session, props, install: installId })),
      });
      const done = !!res && (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429));
      if (done) {
        // 2xx means stored; a 4xx that is not a rate limit means the server will
        // never accept these events, so keeping them would block the queue.
        queue = queue.slice(batch.length);
        failures = 0;
        persistSoon();
      } else {
        failures += 1;
        retryAfter = Date.now() + Math.min(5000 * 2 ** (failures - 1), 5 * 60_000);
      }
      const body = res?.ok ? ((await res.json().catch(() => null)) as Partial<FlushResult> | null) : null;
      const result: FlushResult = {
        status: res ? res.status : 'offline',
        accepted: body?.accepted ?? 0,
        duplicate: body?.duplicate ?? 0,
        rejected: body?.rejected ?? (done && !res?.ok ? batch.length : 0),
        willRetry: !done,
      };
      log(done && res?.ok ? 'debug' : 'error', `sent ${batch.length}:`, result);
      try {
        onFlush?.(result);
      } catch {
        // The app's callback never breaks the queue.
      }
    } finally {
      flushing = false;
    }
  }

  /** Flushes shortly from now, once, however many calls ask for it in the meantime. */
  function flushSoon() {
    if (flushSoonTimer) return;
    flushSoonTimer = setTimeout(() => {
      flushSoonTimer = null;
      void flush();
    }, FLUSH_SOON_MS);
  }

  function enqueue(name: string, props: Props = {}, once?: string): QueuedEvent | null {
    if (!enabled || optedOut) return null;
    const event: QueuedEvent = { id: uuid(), name, at: new Date().toISOString(), session: sessionId, props: { ...globals, ...props } };
    if (once) event.once = once;
    queue.push(event);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    persistSoon();
    if (queue.length >= BATCH) void flush();
    else flushSoon();
    return event;
  }

  /** Puts the held session_started into the queue with whatever entry it has. */
  function commitSession() {
    if (!pendingSession) return;
    clearTimeout(pendingSession.timer);
    const { event } = pendingSession;
    pendingSession = null;
    if (optedOut) return;
    // Globals as they are now: the app may have set them after the session began.
    event.props = { ...globals, ...event.props };
    // Its `at` is the moment the session began, set when it was created, so it
    // sorts correctly however late it joins the queue.
    queue.push(event);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    persistSoon();
    flushSoon();
  }

  function startSession() {
    commitSession();
    sessionId = uuid();
    // The session that just ended reports its time in the foreground here, with
    // the next start: an explicit "session ended" dies with the process
    // whenever iOS kills the app in the background.
    const previousForegroundS = Math.round(foregroundSoFar() / 1000);
    foregroundMs = 0;
    activeSince = Date.now();
    if (!enabled || optedOut) return;
    sessionCount += 1;
    persistSessions();
    const props: Props = { entry: 'launch', n: sessionCount };
    if (sessionCount > 1 && previousForegroundS > 0) props.prev_fg_s = previousForegroundS;
    const event: QueuedEvent = { id: uuid(), name: 'session_started', at: new Date().toISOString(), session: sessionId, props };
    pendingSession = { event, timer: setTimeout(commitSession, ENTRY_WINDOW_MS) };
  }

  /**
   * How this session began, reported by the screen that knows: the root layout
   * for URLs and notification taps. Claims the held session_started when it is
   * still within the window; after that the app has been open for a while and
   * the tap is an action inside the session, not its entry.
   */
  function entry(source: Entry, options: { url?: string } = {}): void {
    if (!pendingSession) return;
    pendingSession.event.props.entry = source;
    // A link's campaign tags (utm_*, ref) join the session, never the URL.
    if (options.url) Object.assign(pendingSession.event.props, campaignOf(options.url));
    commitSession();
  }

  function onAppState(state: LifecycleState) {
    if (state === 'background') {
      backgroundedAt = Date.now();
      if (activeSince) {
        foregroundMs += Date.now() - activeSince;
        activeSince = 0;
      }
      persistSessions();
      // Leaving is the deadline: whatever entry the session has by now is the
      // one it gets, and it goes out with everything else, through
      // runInBackground so an app can give the fetch real runway instead of
      // racing process suspension.
      commitSession();
      void withBackgroundTask(flush);
      return;
    }
    if (state === 'active') {
      if (backgroundedAt && Date.now() - backgroundedAt > SESSION_GAP_MS) startSession();
      else if (!activeSince) activeSince = Date.now();
    }
  }

  /**
   * Safe to call more than once and safe to call before anything else; it never
   * throws and never blocks a render. Events tracked before it resolves are
   * queued and get the install id at flush time.
   */
  function init(): Promise<void> {
    if (!enabled || ready) return Promise.resolve();
    // One init, however many callers arrive while the first is still reading
    // storage: a second pass would start a second session and listener.
    initPromise ??= initOnce().finally(() => {
      initPromise = null;
    });
    return initPromise;
  }

  let initPromise: Promise<void> | null = null;

  async function initOnce(): Promise<void> {
    try {
      const [stored, storedQueue, first, storedOnce, storedOptOut, storedSessions] = await Promise.all([
        storage.getItem(INSTALL_KEY),
        storage.getItem(QUEUE_KEY),
        storage.getItem(FIRST_KEY),
        storage.getItem(ONCE_KEY),
        storage.getItem(OPTOUT_KEY),
        storage.getItem(SESSIONS_KEY),
      ]);
      installId = stored ?? uuid();
      if (!stored) await storage.setItem(INSTALL_KEY, installId);

      optedOut = storedOptOut === '1';
      if (optedOut) {
        // Whatever the app tracked before init knew is dropped, like everything after.
        queue = [];
        earlyOnce.clear();
        void storage.removeItem(QUEUE_KEY).catch(() => {});
      }

      // Once-events tracked before init that an earlier launch already sent go.
      const sent = new Set<string>(storedOnce ? (JSON.parse(storedOnce) as string[]) : []);
      if (earlyOnce.size) queue = queue.filter((e) => !(earlyOnce.has(e.id) && sent.has(earlyOnce.get(e.id)!)));
      onceKeys = [...sent, ...onceKeys.filter((k) => !sent.has(k))].slice(-MAX_ONCE);
      earlyOnce.clear();
      onceLoaded = true;
      persistOnce();

      // The previous launch's last session reports its foreground time with this one's start.
      if (storedSessions) {
        const saved = JSON.parse(storedSessions) as { n?: number; fg?: number };
        sessionCount = typeof saved.n === 'number' ? saved.n : 0;
        foregroundMs = typeof saved.fg === 'number' ? saved.fg : 0;
      }
      activeSince = 0;

      if (storedQueue) {
        const cutoff = Date.now() - MAX_AGE_MS;
        const previous = (JSON.parse(storedQueue) as QueuedEvent[]).filter(
          (e) => Date.parse(e.at) > cutoff,
        );
        queue = [...previous, ...queue].slice(-MAX_QUEUE);
      }

      ready = true;
      if (!first) {
        enqueue('app_first_opened');
        await storage.setItem(FIRST_KEY, new Date().toISOString());
      }
      startSession();

      platform.onAppState(onAppState);
      flushTimer ??= setInterval(() => {
        // Also keeps the foreground time on disk for a process killed mid-session.
        persistSessions();
        void flush();
      }, FLUSH_MS);
      log('debug', `ready: install ${installId}, sdk ${SDK_VERSION}, channel ${CHANNEL ?? '(none)'}${optedOut ? ', opted out' : ''}`);
      void flush();
    } catch {
      // Anything failing here just leaves telemetry off for this launch.
    }
  }

  /** Warns (logLevel 'error' and up) about what the server would drop, and says whether to send. */
  function valid(name: string, props: Props): boolean {
    if (!EVENT_NAME.test(name)) {
      log('error', `event "${name}" is not snake_case (a-z, 0-9, _; 2-64 chars): dropped`);
      return false;
    }
    const keys = Object.keys(props);
    if (keys.length > 40) log('error', `event "${name}" has ${keys.length} props; the server keeps at most 40`);
    for (const k of keys) {
      const v = props[k];
      if (v !== null && typeof v === 'object') log('error', `event "${name}" prop "${k}" is nested; props are one flat level, so the event will be rejected`);
    }
    return true;
  }

  /**
   * Records an event. `once`: at most once per install, ever (`true`), or once
   * per install and key (`once: 'v2_onboarding'`) — for milestones such as
   * `onboarding_completed` that code paths might fire twice.
   */
  function track(name: string, props: Props = {}, options: { once?: true | string } = {}): void {
    if (!valid(name, props)) return;
    if (options.once) {
      const key = options.once === true ? name : `${name}:${options.once}`;
      if (onceKeys.includes(key)) {
        log('debug', `"${key}" was already sent once: skipped`);
        return;
      }
      const event = enqueue(name, props, key);
      if (!event) return;
      onceKeys = [...onceKeys, key].slice(-MAX_ONCE);
      if (onceLoaded) persistOnce();
      else earlyOnce.set(event.id, key);
      return;
    }
    enqueue(name, props);
  }

  /** Props added to every event from now on (an event's own props win). Kept in memory: set them each launch. */
  function setGlobalProps(props: Props): void {
    globals = { ...globals, ...props };
  }

  function removeGlobalProp(key: string): void {
    const { [key]: _removed, ...rest } = globals;
    globals = rest;
  }

  function clearGlobalProps(): void {
    globals = {};
  }

  function screen(name: string): void {
    enqueue('screen_viewed', { screen: name });
  }

  /** RevenueCat's own anonymous customer id, so purchases can be joined to installs without ever setting an appUserID; and whether the install is on a paid plan. */
  function identify(next: { rcId?: string; pro?: boolean }): void {
    if (next.rcId) rcId = next.rcId;
    if (typeof next.pro === 'boolean') isPro = next.pro;
  }

  /** The install id, or '' before init() has read it. getInstallationId() waits for it. */
  function installationId(): string {
    return installId;
  }

  /** The install id once init() has it (e.g. for a debug screen, to look the install up on the dashboard); '' when off. */
  async function getInstallationId(timeoutMs = 3000): Promise<string> {
    if (!enabled) return '';
    if (installId) return installId;
    await Promise.race([init(), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    return installId;
  }

  /**
   * The user's "don't share anonymous usage": remembered across launches.
   * Nothing is queued or sent until optIn(); what was queued is dropped.
   * Feedback keeps working, since a user sends that on purpose.
   */
  function optOut(): void {
    optedOut = true;
    queue = [];
    if (pendingSession) {
      clearTimeout(pendingSession.timer);
      pendingSession = null;
    }
    void storage.setItem(OPTOUT_KEY, '1').catch(() => {});
    void storage.removeItem(QUEUE_KEY).catch(() => {});
    log('debug', 'opted out');
  }

  function optIn(): void {
    if (!optedOut) return;
    optedOut = false;
    void storage.removeItem(OPTOUT_KEY).catch(() => {});
    log('debug', 'opted in');
    if (ready) startSession();
  }

  /** Whether the user opted out. Read from storage by init(); false before it resolves. */
  function isOptedOut(): boolean {
    return optedOut;
  }

  /**
   * The user's "delete my data": the server deletes everything stored about
   * this install (events, feedback), then the SDK starts over with a new
   * install id, as a fresh install would, but without counting a new one.
   * Offline or refused: nothing changes, and the app can offer to try again.
   */
  async function forget(): Promise<{ ok: boolean; error?: 'unavailable' | 'offline' | 'failed' }> {
    if (!enabled) return { ok: false, error: 'unavailable' };
    if (!installId) await init();
    if (!installId) return { ok: false, error: 'failed' };
    const res = await post('/v1/forget', { install: installId });
    if (!res) return { ok: false, error: 'offline' };
    if (!res.ok) return { ok: false, error: 'failed' };
    queue = [];
    if (pendingSession) {
      clearTimeout(pendingSession.timer);
      pendingSession = null;
    }
    installId = uuid();
    onceKeys = [];
    sessionCount = 0;
    foregroundMs = 0;
    await Promise.all([
      storage.setItem(INSTALL_KEY, installId),
      storage.removeItem(QUEUE_KEY),
      storage.removeItem(ONCE_KEY),
      storage.removeItem(SESSIONS_KEY),
    ]).catch(() => {});
    log('debug', `forgotten; new install ${installId}`);
    if (ready) startSession();
    return { ok: true };
  }

  /** For dev builds and tests; a user's choice is optOut(). */
  function setEnabled(next: boolean): void {
    enabled = next && TELEMETRY_KEY.length > 0;
    if (!enabled) {
      queue = [];
      void storage.removeItem(QUEUE_KEY).catch(() => {});
    }
  }

  async function flushNow(): Promise<void> {
    commitSession();
    await flush();
  }

  /** Stops sending until resume(), keeping everything queued. Not remembered: the next launch sends again. */
  function pause(): void {
    paused = true;
  }

  function resume(): void {
    paused = false;
    void flush();
  }

  // --- support tickets

  async function createTicket(input: {
    kind: TicketKind;
    email?: string;
    subject?: string;
    message: string;
  }): Promise<{ ok: boolean; id?: string; error?: string }> {
    if (!enabled) return { ok: false, error: 'unavailable' };
    if (!installId) await init();
    const res = await post('/v1/tickets', {
      install: installId,
      kind: input.kind,
      // The RevenueCat customer id as of this moment, stored on the ticket
      // itself: a report from a paying user should be recognisable as one
      // without asking them who they are.
      rc_id: rcId,
      email: input.email || undefined,
      subject: input.subject || undefined,
      message: input.message,
      diag: (({ version, build, os, device }) => ({ version, build, os, device, pro: isPro }))(platform.device()),
    });
    if (!res) return { ok: false, error: 'offline' };
    if (res.status === 429) return { ok: false, error: 'too_many' };
    if (!res.ok) return { ok: false, error: 'failed' };
    const created = (await res.json().catch(() => null)) as { id?: string | number } | null;
    enqueue('ticket_opened', { kind: input.kind });
    // The id is what the app opens next; a missing one still counts as sent.
    return { ok: true, id: created?.id !== undefined ? String(created.id) : undefined };
  }

  /**
   * A reply on one of this install's tickets. The thread stays open for as long
   * as the ops side keeps it open; a closed one refuses, and the app offers a
   * new message instead.
   */
  async function replyToTicket(
    id: string,
    body: string,
  ): Promise<{ ok: boolean; error?: 'unavailable' | 'offline' | 'closed' | 'too_many' | 'failed' }> {
    if (!enabled) return { ok: false, error: 'unavailable' };
    if (!installId) await init();
    const res = await post(`/v1/tickets/${encodeURIComponent(id)}/reply`, { install: installId, body });
    if (!res) return { ok: false, error: 'offline' };
    if (res.status === 409) return { ok: false, error: 'closed' };
    if (res.status === 429) return { ok: false, error: 'too_many' };
    if (!res.ok) return { ok: false, error: 'failed' };
    enqueue('ticket_replied');
    return { ok: true };
  }

  async function listTickets(): Promise<Ticket[]> {
    if (!enabled) return [];
    if (!installId) await init();
    try {
      const res = await doFetch(`${TELEMETRY_URL}/v1/tickets?install=${encodeURIComponent(installId)}`, {
        headers: { Authorization: `Key ${TELEMETRY_KEY}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { tickets: Ticket[] };
      return body.tickets ?? [];
    } catch {
      return [];
    }
  }

  const telemetryAvailable = (): boolean => enabled;

  return {
    configure,
    entry,
    init,
    track,
    setGlobalProps,
    removeGlobalProp,
    clearGlobalProps,
    screen,
    identify,
    installationId,
    getInstallationId,
    optOut,
    optIn,
    isOptedOut,
    forget,
    setEnabled,
    flushNow,
    pause,
    resume,
    createTicket,
    replyToTicket,
    listTickets,
    telemetryAvailable,
  };
}
