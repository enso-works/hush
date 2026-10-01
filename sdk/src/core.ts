/**
 * hush core: the platform-free part of the SDK. The queue, batches, retries,
 * sessions, once-per-install events, global props, the user's opt-out and
 * forget, and feedback tickets, over the hush /v1 API.
 *
 * A platform gives it storage, the app's comings and goings, a description
 * of the device, and whether this is a development build: see HushPlatform.
 * `@bavrk/hush` (the default entry) is that for React Native and Expo.
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
  /**
   * Apple's ad attribution (SKAdNetwork, AdAttributionKit), through a native
   * bridge such as `@bavrk/hush-expo`. With it the SDK registers the install
   * on first launch and, for the 35 days Apple listens, raises the conversion
   * value as the milestones in the server's catalog happen (fetched from
   * /v1/config). The value goes to Apple and the ad network, aggregated;
   * nothing about it is sent to hush. Nothing happens for an opted-out user.
   */
  attribution?: AttributionBridge;
};

/** A conversion value: the fine value (0-63), the coarse one, and whether it ends the current window. */
export type ConversionValue = { fine: number; coarse: 'low' | 'medium' | 'high'; lock: boolean };

/** What a native module gives the SDK to set Apple's conversion value. */
export type AttributionBridge = { update(value: ConversionValue): Promise<void> | void };

/** A milestone from the catalog: reached when `event` happens with `where` matching its props. */
type Milestone = { value: number; coarse: ConversionValue['coarse']; event: string; where: Record<string, string> | null; lock: boolean };

/** One send's outcome. `willRetry`: the batch stays queued and goes again later. */
export type FlushResult = {
  status: number | 'offline';
  accepted: number;
  duplicate: number;
  rejected: number;
  willRetry: boolean;
};

/** Sent with every batch, and stored on the install: which SDK spoke. */
export const SDK_VERSION = '2.2.2';

const CHANNEL_RE = /^[a-z][a-z0-9_]{0,23}$/;
// The server's rule for event names; anything else is dropped there anyway.
const EVENT_NAME = /^[a-z][a-z0-9_]{1,63}$/;

type Value = string | number | boolean | null;
export type Props = Record<string, Value>;

// undefined is allowed too: JSON leaves the key out.
const isFlat = (v: unknown): v is Value | undefined =>
  v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const NOT_FLAT = Symbol('not flat');
/**
 * A prop value as JSON sends it, or NOT_FLAT. A Date (anything with toJSON)
 * goes as what toJSON returns, its ISO string, as it did before 2.2.2 and as
 * the server accepts. An object or array is not flat, and may be circular.
 */
function asFlat(v: unknown): Value | undefined | typeof NOT_FLAT {
  if (isFlat(v)) return v;
  if (typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    try {
      const json = (v as { toJSON: () => unknown }).toJSON();
      if (isFlat(json)) return json;
    } catch {
      // A toJSON that throws would sink the batch like a circular value.
    }
  }
  return NOT_FLAT;
}

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
// How long after a session starts its entry can still be claimed.
const ENTRY_WINDOW_MS = 2500;

/**
 * Where a session began: the app's own doors (a widget, a quick action, a
 * notification, a deep link...). Any short snake_case string; the dashboard
 * slices sessions by it as it is. `launch` is the default.
 */
export type Entry = 'launch' | 'widget' | 'quick_action' | 'siri' | 'notification' | 'link' | (string & {});

// The campaign tags worth keeping from a link that opened the app, and
// nothing else from it: the URL itself may carry anything.
const CAMPAIGN_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'];

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

  /**
   * Call once, before init(). Calling it again replaces the configuration.
   * Never throws: a missing url or key (an env variable unset in some build
   * profile, say) turns the SDK off, and logLevel 'error' says why.
   */
  function configure(config: HushConfig): void {
    if (!config || typeof config !== 'object') {
      TELEMETRY_URL = '';
      TELEMETRY_KEY = '';
      enabled = false;
      log('error', 'configure() needs { url, key }: telemetry is off');
      return;
    }
    TELEMETRY_URL = typeof config.url === 'string' ? config.url.trim().replace(/\/+$/, '') : '';
    TELEMETRY_KEY = typeof config.key === 'string' ? config.key.trim() : '';
    const prefix = typeof config.storagePrefix === 'string' && config.storagePrefix ? config.storagePrefix : 'hush';
    INSTALL_KEY = `${prefix}.install.v1`;
    QUEUE_KEY = `${prefix}.queue.v1`;
    FIRST_KEY = `${prefix}.first.v1`;
    ONCE_KEY = `${prefix}.once.v1`;
    OPTOUT_KEY = `${prefix}.optout.v1`;
    SESSIONS_KEY = `${prefix}.sessions.v1`;
    ATTRIBUTION_KEY = `${prefix}.attribution.v1`;
    attribution = config.attribution && typeof config.attribution.update === 'function' ? config.attribution : undefined;
    if (typeof config.runInBackground === 'function') withBackgroundTask = config.runInBackground;
    LOG_LEVEL = config.logLevel === 'error' || config.logLevel === 'debug' ? config.logLevel : 'silent';
    onFlush = typeof config.onFlush === 'function' ? config.onFlush : undefined;
    const channel = config.channel ?? (isDev() ? 'dev' : undefined);
    CHANNEL = typeof channel === 'string' && CHANNEL_RE.test(channel) ? channel : undefined;
    if (channel && !CHANNEL) log('error', `channel "${String(channel)}" is not a short snake_case label; not sent`);
    enabled = TELEMETRY_KEY.length > 0 && TELEMETRY_URL.length > 0;
    // An empty string key is the documented way to leave the SDK off (dev
    // without a key, or url and key both '' before the server exists), so it
    // stays quiet whatever the url is; anything else missing is a mistake
    // worth a line.
    if (typeof config.key === 'string' && !TELEMETRY_KEY) log('debug', 'key is empty: telemetry is off');
    else if (!TELEMETRY_URL) log('error', `url is ${typeof config.url === 'string' ? 'empty' : 'missing or not a string'}: telemetry is off`);
    else if (typeof config.key !== 'string') log('error', 'key is missing or not a string: telemetry is off');
  }

  let enabled = false;
  let ready = false;
  let ATTRIBUTION_KEY = 'hush.attribution.v1';
  let attribution: AttributionBridge | undefined;
  // Apple's conversion value: what this install has set (-1: not registered
  // yet), since when, and the catalog's milestones as last fetched.
  let conversion: { value: number; since: string; milestones: Milestone[] | null; fetchedAt: number } | null = null;
  // Events seen before the milestones arrived, checked once they do.
  let unchecked: { name: string; props: Props }[] = [];
  let installId = '';
  // The process's first session: events tracked before init() carry this id,
  // and init() starts the session under it, dated from here so its
  // session_started sorts before them (campaign funnels count from it).
  let sessionId = uuid();
  const createdAt = new Date().toISOString();
  let backgroundedAt = 0;
  let queue: QueuedEvent[] = [];
  // The send in flight: forget() waits for it, and a flush asked for
  // meanwhile gets it rather than a second request.
  let sending: Promise<void> | null = null;
  // forget() is talking to the server: no batch may land after its delete.
  let forgetting = false;
  let retryAfter = 0;
  let failures = 0;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let flushSoonTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let rcId: string | undefined;
  // Unknown until identify() says: left out of batches, so the server keeps
  // what it has rather than downgrading a paid install.
  let isPro: boolean | undefined;
  // Merged into every event's props (the event's own win), for context such as
  // a paywall variant. In memory: the app sets them again each launch.
  let globals: Props = {};
  // Keys of events tracked with { once } that this install has already sent.
  let onceKeys: string[] = [];
  let onceLoaded = false;
  // Once-events queued before init() read the stored keys: id -> key, checked
  // against them when they arrive.
  const earlyOnce = new Map<string, string>();
  // The user said no to anonymous usage data (optOut): no events are kept or
  // sent. Feedback still works; it is something they send on purpose.
  let optedOut = false;
  // optOut() or optIn() before init() has read the stored choice: it is the
  // newer one, so it wins over what init() reads.
  let choiceBeforeInit: boolean | null = null;
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
  // An entry reported before its session exists: a cold start's link or
  // widget that arrives before init() has read storage, or a warm return's
  // URL that iOS delivers before 'active'. The next session takes it: one
  // made before init() always, a later one within ENTRY_WINDOW_MS.
  let heldEntry: { source: Entry; url?: string; at: number; beforeInit: boolean } | null = null;
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

  // Before init() has merged the stored queue into memory, memory holds only
  // this launch's early events: writing it would replace the last launch's
  // unsent ones. Both writers wait for `ready`; init() writes after the merge.
  function persistSoon() {
    if (persistTimer || !ready) return;
    persistTimer = setTimeout(persistNow, 1000);
  }

  function persistNow() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    if (!ready) return;
    try {
      // Oldest first out: a queue this long means the service has been
      // unreachable for days, and the recent events are the useful ones.
      void storage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE))).catch(() => {});
    } catch (err) {
      log('error', 'queue not saved', err);
    }
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

  /** Sends one batch, or hands back the send already in flight. Never rejects. */
  function flush(): Promise<void> {
    if (sending) return sending;
    if (!enabled || optedOut || paused || forgetting || !ready || queue.length === 0 || Date.now() < retryAfter) return Promise.resolve();
    sending = send()
      .catch((err) => log('error', 'send failed', err))
      .finally(() => {
        sending = null;
      });
    return sending;
  }

  /** After the send in flight, if any, one more with what is queued now: for leaving, and flushNow(). */
  async function flushQueued(): Promise<void> {
    if (sending) await sending;
    await flush();
  }

  async function send(): Promise<void> {
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
      // By id, not position: optOut(), forget() or the 500 cap may have
      // replaced the queue while the request was out.
      const sentIds = new Set(batch.map((e) => e.id));
      queue = queue.filter((e) => !sentIds.has(e.id));
      failures = 0;
      // At once, not on the debounce: the send as the app leaves is often the
      // last JS before suspension, and a stale queue on disk goes out again.
      persistNow();
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
    if (attribution) reached(name, event.props);
    return event;
  }

  // --- Apple's ad attribution (conversion values)

  const ATTRIBUTION_DAYS = 35;
  const CONFIG_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  async function setConversion(value: ConversionValue): Promise<void> {
    if (!attribution || !conversion || value.fine <= conversion.value) return;
    // Raised before the native call returns, so two milestones in a row
    // compare against the second's value, not the first's; put back if the
    // call fails.
    const before = conversion.value;
    conversion.value = value.fine;
    try {
      await attribution.update(value);
      void storage.setItem(ATTRIBUTION_KEY, JSON.stringify(conversion)).catch(() => {});
      log('debug', `conversion value ${value.fine} (${value.coarse}${value.lock ? ', locked' : ''})`);
    } catch (err) {
      if (conversion.value === value.fine) conversion.value = before;
      log('error', 'conversion value not set', err);
    }
  }

  /** An event against the milestones: the highest one it reaches, if higher than what is set. */
  function reached(name: string, props: Props): void {
    if (optedOut) return;
    if (!conversion?.milestones) {
      if (unchecked.length < 50) unchecked.push({ name, props });
      return;
    }
    if (Date.now() - Date.parse(conversion.since) > ATTRIBUTION_DAYS * 86400000) return;
    let best: Milestone | null = null;
    for (const m of conversion.milestones) {
      if (m.event !== name || m.value <= conversion.value) continue;
      if (m.where && !Object.entries(m.where).every(([k, v]) => props[k] !== undefined && String(props[k]) === v)) continue;
      if (!best || m.value > best.value) best = m;
    }
    if (best) void setConversion({ fine: best.value, coarse: best.coarse, lock: best.lock });
  }

  /** At start: register the install with Apple (value 0) once, then fetch the milestones (cached for 12 hours). */
  async function startAttribution(): Promise<void> {
    if (!attribution || optedOut) return;
    try {
      const saved = await storage.getItem(ATTRIBUTION_KEY);
      conversion = saved ? JSON.parse(saved) : { value: -1, since: new Date().toISOString(), milestones: null, fetchedAt: 0 };
      if (conversion!.value < 0) await setConversion({ fine: 0, coarse: 'low', lock: false });
      if (!conversion!.milestones || Date.now() - conversion!.fetchedAt > CONFIG_MAX_AGE_MS) {
        const res = await doFetch(`${TELEMETRY_URL}/v1/config`, { headers: { Authorization: `Key ${TELEMETRY_KEY}` } }).catch(() => null);
        if (res?.ok) {
          const body = (await res.json()) as { conversion_values?: Milestone[] };
          conversion!.milestones = Array.isArray(body.conversion_values) ? body.conversion_values : [];
          conversion!.fetchedAt = Date.now();
          void storage.setItem(ATTRIBUTION_KEY, JSON.stringify(conversion)).catch(() => {});
        }
      }
      const pending = unchecked;
      unchecked = [];
      for (const e of pending) reached(e.name, e.props);
    } catch (err) {
      log('error', 'attribution did not start', err);
    }
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

  /** `first`: the process's first session, started by init(), which keeps the id its early events carry. */
  function startSession(first = false) {
    commitSession();
    if (!first) sessionId = uuid();
    const claim = heldEntry;
    heldEntry = null;
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
    const at = first ? createdAt : new Date().toISOString();
    const event: QueuedEvent = { id: uuid(), name: 'session_started', at, session: sessionId, props };
    pendingSession = { event, timer: setTimeout(commitSession, ENTRY_WINDOW_MS) };
    if (claim && (claim.beforeInit || Date.now() - claim.at <= ENTRY_WINDOW_MS)) entry(claim.source, { url: claim.url });
  }

  /**
   * How this session began, reported by the screen that knows: the root layout
   * for URLs and notification taps. Claims the held session_started when it is
   * still within the window; after that the app has been open for a while and
   * the tap is an action inside the session, not its entry. A claim with no
   * session yet waits for the next one (see heldEntry).
   */
  function entry(source: Entry, options?: { url?: string } | null): void {
    if (typeof source !== 'string' || !source) return;
    const url = typeof options?.url === 'string' ? options.url : undefined;
    if (!pendingSession) {
      // The first claim wins, as it does on a session: a later one replaces it only once it has expired.
      if (!heldEntry || (!heldEntry.beforeInit && Date.now() - heldEntry.at > ENTRY_WINDOW_MS)) {
        heldEntry = { source, url, at: Date.now(), beforeInit: !ready };
      }
      return;
    }
    pendingSession.event.props.entry = source;
    // A link's campaign tags (utm_*, ref) join the session, never the URL.
    if (url) Object.assign(pendingSession.event.props, campaignOf(url));
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
      // racing process suspension. The queue goes to disk first, in case the
      // send never finishes.
      commitSession();
      persistNow();
      try {
        void Promise.resolve(withBackgroundTask(flushQueued)).catch(() => {});
      } catch {
        // The app's wrapper threw: send without it.
        void flushQueued();
      }
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
   * queued under the launch's session and get the install id at flush time;
   * an entry() made before it is held for that session.
   */
  function init(): Promise<void> {
    if (!enabled) return Promise.resolve();
    // One init, however many callers arrive while the first is still running:
    // a second pass would start a second session and listener, and a caller
    // that arrives late in the first must still wait for its session.
    if (initPromise) return initPromise;
    if (ready) return Promise.resolve();
    initPromise = initOnce().finally(() => {
      initPromise = null;
    });
    return initPromise;
  }

  let initPromise: Promise<void> | null = null;

  /**
   * A stored JSON value, or null when it cannot be read or parsed: a
   * truncated write, or a queue row too big for Android's CursorWindow. The
   * next save overwrites it. Failing init() on it instead would leave
   * telemetry off on every launch from then on, since nothing else writes it.
   */
  async function readStored(key: string): Promise<unknown> {
    try {
      const raw = await storage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (err) {
      log('error', `${key} could not be read: starting it empty`, err);
      return null;
    }
  }

  async function initOnce(): Promise<void> {
    try {
      // The install id, the first-launch marker and the opt-out are small and
      // have no safe default (a guess counts a new install, or ignores the
      // user's choice): failing to read them leaves telemetry off this launch.
      const [stored, first, storedOptOut, storedQueue, storedOnce, storedSessions] = await Promise.all([
        storage.getItem(INSTALL_KEY),
        storage.getItem(FIRST_KEY),
        storage.getItem(OPTOUT_KEY),
        readStored(QUEUE_KEY),
        readStored(ONCE_KEY),
        readStored(SESSIONS_KEY),
      ]);
      installId = stored ?? uuid();
      if (!stored) await storage.setItem(INSTALL_KEY, installId);

      optedOut = choiceBeforeInit ?? storedOptOut === '1';
      choiceBeforeInit = null;
      if (optedOut) {
        // Whatever the app tracked before init knew is dropped, like everything after.
        queue = [];
        earlyOnce.clear();
        void storage.removeItem(QUEUE_KEY).catch(() => {});
      }

      // Once-events tracked before init that an earlier launch already sent go.
      const sent = new Set<string>(Array.isArray(storedOnce) ? storedOnce.filter((k): k is string => typeof k === 'string') : []);
      if (earlyOnce.size) queue = queue.filter((e) => !(earlyOnce.has(e.id) && sent.has(earlyOnce.get(e.id)!)));
      onceKeys = [...sent, ...onceKeys.filter((k) => !sent.has(k))].slice(-MAX_ONCE);
      earlyOnce.clear();
      onceLoaded = true;
      persistOnce();

      // The previous launch's last session reports its foreground time with this one's start.
      if (storedSessions && typeof storedSessions === 'object') {
        const saved = storedSessions as { n?: unknown; fg?: unknown };
        sessionCount = typeof saved.n === 'number' ? saved.n : 0;
        foregroundMs = typeof saved.fg === 'number' ? saved.fg : 0;
      }
      activeSince = 0;

      // An opt-out made while init() was reading finds the old queue still in
      // the read: it stays dropped.
      if (Array.isArray(storedQueue) && !optedOut) {
        const cutoff = Date.now() - MAX_AGE_MS;
        const previous = (storedQueue as QueuedEvent[]).filter(
          (e) => !!e && typeof e === 'object' && typeof e.id === 'string' && Date.parse(e.at) > cutoff,
        );
        queue = [...previous, ...queue].slice(-MAX_QUEUE);
      }

      // From here to the session's start nothing awaits: whoever sees `ready`
      // also sees the session.
      ready = true;
      persistNow(); // the merged queue: the stored events and this launch's early ones
      if (!first) {
        enqueue('app_first_opened');
        void storage.setItem(FIRST_KEY, new Date().toISOString()).catch(() => {});
      }
      startSession(true);
      void startAttribution();

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

  /**
   * The props to send, or null to drop the event, with a warning (logLevel
   * 'error' and up). An event the server would reject whole is dropped here:
   * a nested value (a press event, a navigation object) could also be
   * circular, and then no batch or saved queue could be written at all.
   */
  function checked(name: string, props: Props): Props | null {
    if (typeof name !== 'string' || !EVENT_NAME.test(name)) {
      log('error', `event "${String(name)}" is not snake_case (a-z, 0-9, _; 2-64 chars): dropped`);
      return null;
    }
    if (typeof props !== 'object' || Array.isArray(props)) {
      log('error', `event "${name}": props must be an object: dropped`);
      return null;
    }
    const keys = Object.keys(props);
    if (keys.length > 40) log('error', `event "${name}" has ${keys.length} props; the server keeps at most 40`);
    const out: Props = {};
    for (const k of keys) {
      const v = asFlat(props[k]);
      if (v === NOT_FLAT) {
        log('error', `event "${name}" prop "${k}" is not a string, number, boolean or null (props are one flat level): dropped`);
        return null;
      }
      out[k] = v as Value;
    }
    return out;
  }

  /**
   * Records an event. `once`: at most once per install, ever (`true`), or once
   * per install and key (`once: 'v2_onboarding'`) — for milestones such as
   * `onboarding_completed` that code paths might fire twice.
   */
  function track(name: string, props?: Props | null, options?: { once?: true | string } | null): void {
    const clean = checked(name, props ?? {});
    if (!clean) return;
    if (options?.once) {
      const key = options.once === true ? name : `${name}:${String(options.once)}`;
      if (onceKeys.includes(key)) {
        log('debug', `"${key}" was already sent once: skipped`);
        return;
      }
      const event = enqueue(name, clean, key);
      if (!event) return;
      onceKeys = [...onceKeys, key].slice(-MAX_ONCE);
      if (onceLoaded) persistOnce();
      else earlyOnce.set(event.id, key);
      return;
    }
    enqueue(name, clean);
  }

  /** Props added to every event from now on (an event's own props win). Kept in memory: set them each launch. */
  function setGlobalProps(props: Props): void {
    if (!props || typeof props !== 'object') return;
    const next = { ...globals };
    for (const [k, v] of Object.entries(props)) {
      // One bad value here would sink every event that follows: it is left out instead.
      const flat = asFlat(v);
      if (flat !== NOT_FLAT) next[k] = flat as Value;
      else log('error', `global prop "${k}" is not a string, number, boolean or null: not set`);
    }
    globals = next;
  }

  function removeGlobalProp(key: string): void {
    const { [key]: _removed, ...rest } = globals;
    globals = rest;
  }

  function clearGlobalProps(): void {
    globals = {};
  }

  function screen(name: string): void {
    if (typeof name !== 'string') return;
    enqueue('screen_viewed', { screen: name });
  }

  /**
   * RevenueCat's own anonymous customer id, so purchases can be joined to
   * installs without ever setting an appUserID; and whether the install is on
   * a paid plan. Until `pro` is given, batches carry no flag at all.
   */
  function identify(next: { rcId?: string; pro?: boolean }): void {
    if (typeof next?.rcId === 'string' && next.rcId) rcId = next.rcId;
    if (typeof next?.pro === 'boolean') isPro = next.pro;
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
    if (!ready) choiceBeforeInit = true;
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
    // Before init() the stored choice is not known yet, so this one is
    // recorded (and the stored one removed) even if memory already says in.
    if (!ready) choiceBeforeInit = false;
    else if (!optedOut) return;
    optedOut = false;
    void storage.removeItem(OPTOUT_KEY).catch(() => {});
    log('debug', 'opted in');
    if (ready) startSession();
    // Attribution was never started for an install opted out at launch.
    if (ready && !conversion) void startAttribution();
  }

  /** Whether the user opted out. Read from storage by init(); before it resolves, false unless optOut() was called. */
  function isOptedOut(): boolean {
    return optedOut;
  }

  /**
   * The user's "delete my data": the server deletes everything stored about
   * this install (events, feedback), then the SDK starts over with a new
   * install id, as a fresh install would, but without counting a new one.
   * Offline or refused: nothing changes, and the app can offer to try again.
   */
  function forget(): Promise<ForgetResult> {
    // A second tap while the first is out gets the first's answer.
    forgetRun ??= forgetOnce().finally(() => {
      forgetRun = null;
    });
    return forgetRun;
  }

  type ForgetResult = { ok: boolean; error?: 'unavailable' | 'offline' | 'failed' };
  let forgetRun: Promise<ForgetResult> | null = null;

  async function forgetOnce(): Promise<ForgetResult> {
    if (!enabled) return { ok: false, error: 'unavailable' };
    if (!installId) await init();
    if (!installId) return { ok: false, error: 'failed' };
    // Nothing of this install may reach the server after its delete: a send
    // already out lands first, and no new one starts until this is over.
    forgetting = true;
    try {
      await sending;
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
    } finally {
      forgetting = false;
    }
  }

  /** For dev builds and tests; a user's choice is optOut(). */
  function setEnabled(next: boolean): void {
    enabled = next && TELEMETRY_KEY.length > 0 && TELEMETRY_URL.length > 0;
    if (!enabled) {
      queue = [];
      void storage.removeItem(QUEUE_KEY).catch(() => {});
    }
  }

  async function flushNow(): Promise<void> {
    commitSession();
    await flushQueued();
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
