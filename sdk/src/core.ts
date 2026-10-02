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
 * A feedback ticket sent with an email never carries it: the server hands
 * back a key for that one ticket instead (see createTicket).
 * Nothing here may ever break the app: every call is fire-and-forget, every
 * failure is swallowed, and a batch the server refuses is dropped rather than
 * retried forever.
 *
 * Remote config (`config`): values the server's catalog declares and its
 * dashboard changes, fetched from /v1/config with nothing the SDK adds about
 * the user (the request still has the device's IP address and User-Agent),
 * kept in storage, and evaluated here by evaluate.js, the same file the
 * server's "preview as" runs.
 */
import { bucket, evaluateAll } from './evaluate.js';

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
   * Prefix for the storage keys (install id, queue, first-open marker, and
   * the rest). Changing it gives every install a new id, so an app moving
   * from a copied SDK to this package must pass the prefix it used before.
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
  /**
   * Remote config: values declared in the server's catalog and changed on its
   * dashboard, evaluated on the device. Fetched at init() and, at most every
   * refreshMinutes, on returning to the foreground and while in it. false:
   * no config request and no cache, and every getter returns its fallback;
   * an attribution bridge still fetches its milestones from /v1/config on
   * its own, as in 2.3 (at init(), when its copy is over 12 hours old).
   */
  remoteConfig?: boolean | RemoteConfigOptions;
};

export type ConfigType = 'bool' | 'number' | 'string' | 'json';

export type RemoteConfigOptions = {
  /** How often to fetch again, at most: on returning to the foreground, and while in it. Default 15; 1 to 1440. */
  refreshMinutes?: number;
  /**
   * The language the app shows, for language rules: a language or a locale
   * ('es', 'pt-BR'). Read at each evaluation, which this function does not
   * cause: after an in-app switch, identify({ language }) evaluates at once.
   * A language given to identify() wins. Missing, throwing, or not a
   * non-empty string: the phone's first locale. It never leaves the device.
   */
  language?: () => string;
};

export type ConfigRefreshResult = {
  /** The HTTP status, 'offline' when the request failed or passed 15 s, 'off' when the SDK or remote config is off. */
  status: number | 'offline' | 'off';
  /** Keys whose value for this device changed. */
  changed: string[];
};

export type ConfigSnapshotEntry = {
  key: string;
  type: string;
  /** Missing when the key has no usable value: the getters return their fallback. */
  value?: unknown;
  /** The rule that decided it, -1 for the default. */
  rule: number;
  /** This install's bucket for the key, 0-99; null before init() has the install id. */
  bucket: number | null;
};

export type HushRemoteConfig = {
  bool(key: string, fallback: boolean): boolean;
  number(key: string, fallback: number): number;
  string(key: string, fallback: string): string;
  /** An object or an array, frozen: the same reference until the value changes. Its shape is not checked. */
  json<T = unknown>(key: string, fallback: T): T;
  /** Resolves once values are usable (from the cache, or the first fetch). Calls init(). Never rejects. */
  ready(timeoutMs?: number): Promise<void>;
  /** Called with the keys whose value changed. Returns a function that removes the listener. */
  onChange(listener: (keys: string[]) => void): () => void;
  /** Fetches now, whatever refreshMinutes says; a fetch in flight is shared. Never rejects. */
  refresh(): Promise<ConfigRefreshResult>;
  /** The revision in use, or null (nothing loaded yet, an older server, or off). */
  revision(): string | null;
  /** Every key with its value for this device, sorted by key: for a debug screen. */
  snapshot(): ConfigSnapshotEntry[];
};

export type { ConfigContext, ConfigEntry, ConfigRule, ConfigWhen } from './evaluate.js';

/** A conversion value: the fine value (0-63), the coarse one, and whether it ends the current window. */
export type ConversionValue = { fine: number; coarse: 'low' | 'medium' | 'high'; lock: boolean };

/** What a native module gives the SDK to set Apple's conversion value. */
export type AttributionBridge = { update(value: ConversionValue): Promise<void> | void };

/** A milestone from the catalog: reached when `event` happens with `where` matching its props. */
type Milestone = { value: number; coarse: ConversionValue['coarse']; event: string; where: Record<string, string> | null; lock: boolean };

/** The config as the server sent it, kept under `<prefix>.config.v1`. revision null: a server without remote config. */
type StoredConfig = { revision: string | null; keys: Record<string, unknown> };

/**
 * Which server and key a stored config came from: FNV-1a over `<url> <key>`,
 * so the key itself is not written next to it. Two apps on one web origin
 * with the default prefix share the storage key, not the config.
 */
function configSource(url: string, key: string): string {
  let h = 0x811c9dc5;
  const s = `${url} ${key}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** One key's evaluation for this device, with its value frozen. */
type ConfigSlot = { type: string; has: boolean; value: unknown; rule: number };

const CONFIG_TYPES = ['bool', 'number', 'string', 'json'];
// What may go into If-None-Match: anything else in a cache is not sent.
const REVISION_RE = /^[A-Za-z0-9._-]{1,64}$/;
// React Native's Android client has no timeout and iOS waits 60 s: a stalled
// request would otherwise hold the one slot every later fetch waits on.
const CONFIG_TIMEOUT_MS = 15_000;
const READ_FAILED = Symbol('read failed');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Equal as JSON, key order ignored. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameJson(x, b[i]));
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Freezes an object or array and everything in it, in place. `seen`: an app's fallback may be circular. */
function deepFreeze<T>(v: T, seen: Set<object> = new Set()): T {
  if (typeof v !== 'object' || v === null || seen.has(v)) return v;
  seen.add(v);
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k], seen);
  return v;
}

/** One send's outcome. `willRetry`: the batch stays queued and goes again later. */
export type FlushResult = {
  status: number | 'offline';
  accepted: number;
  duplicate: number;
  rejected: number;
  willRetry: boolean;
};

/** Sent with every batch, and stored on the install: which SDK spoke. */
export const SDK_VERSION = '2.4.0';

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

// A ticket's thread key, as the server mints it: 32 random bytes, base64url.
const THREAD_KEY = /^[A-Za-z0-9_-]{43}$/;
// The most thread keys one request may name (the server's limit).
const MAX_THREADS = 50;
// Ticket ids are bigint strings: by length, then by digits, is numeric order.
const newestFirst = (a: string, b: string) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0);

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
  let THREADS_KEY = 'hush.threads.v1';
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
    THREADS_KEY = `${prefix}.threads.v1`;
    unsaved = Object.create(null);
    ATTRIBUTION_KEY = `${prefix}.attribution.v1`;
    attribution = config.attribution && typeof config.attribution.update === 'function' ? config.attribution : undefined;
    if (typeof config.runInBackground === 'function') withBackgroundTask = config.runInBackground;
    LOG_LEVEL = config.logLevel === 'error' || config.logLevel === 'debug' ? config.logLevel : 'silent';
    onFlush = typeof config.onFlush === 'function' ? config.onFlush : undefined;
    const channel = config.channel ?? (isDev() ? 'dev' : undefined);
    CHANNEL = typeof channel === 'string' && CHANNEL_RE.test(channel) ? channel : undefined;
    if (channel && !CHANNEL) log('error', `channel "${String(channel)}" is not a short snake_case label; not sent`);
    CONFIG_KEY = `${prefix}.config.v1`;
    configOn = config.remoteConfig !== false;
    const rc: RemoteConfigOptions = isRecord(config.remoteConfig) ? config.remoteConfig : {};
    const minutes = typeof rc.refreshMinutes === 'number' && Number.isFinite(rc.refreshMinutes) ? Math.min(1440, Math.max(1, rc.refreshMinutes)) : 15;
    refreshMs = minutes * 60_000;
    appLanguage = typeof rc.language === 'function' ? rc.language : undefined;
    enabled = TELEMETRY_KEY.length > 0 && TELEMETRY_URL.length > 0;
    CONFIG_SOURCE = configSource(TELEMETRY_URL, TELEMETRY_KEY);
    // Another server or key: its config is not this one's.
    if (cache && cacheSource !== CONFIG_SOURCE) {
      cache = null;
      configMissing = false;
      evaluateConfig();
    }
    // The channel or the language may differ now.
    if (cache) evaluateConfig();
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
  // yet), since when, and the catalog's milestones as last fetched, with the
  // config revision of the answer they came in (none from 2.3, which did not
  // keep it; null from a server without remote config).
  let conversion: { value: number; since: string; milestones: Milestone[] | null; fetchedAt: number; revision?: string | null } | null = null;
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

  /** Events seen before the milestones arrived, checked against them now (or kept for later). */
  function checkUnchecked(): void {
    const pending = unchecked;
    unchecked = [];
    for (const e of pending) reached(e.name, e.props);
  }

  /**
   * At start: register the install with Apple (value 0) once, then get the
   * milestones. With remote config on they come with the config request
   * (configRequest); with it off, from a request of attribution's own, cached
   * for 12 hours, as in 2.3. `saved`: the state init() already read. Up to
   * that read nothing here awaits, so init() sees `conversion` at once.
   */
  async function startAttribution(saved?: string | null | typeof READ_FAILED): Promise<void> {
    if (!attribution || optedOut) return;
    try {
      const raw = saved === undefined ? await storage.getItem(ATTRIBUTION_KEY) : saved;
      if (raw === READ_FAILED) throw new Error(`${ATTRIBUTION_KEY} could not be read`);
      conversion = raw ? JSON.parse(raw) : { value: -1, since: new Date().toISOString(), milestones: null, fetchedAt: 0 };
      const registered = conversion!.value < 0 ? setConversion({ fine: 0, coarse: 'low', lock: false }) : undefined;
      if (configOn) {
        if (conversion!.milestones) checkUnchecked();
        await registered;
        return;
      }
      await registered;
      if (!conversion!.milestones || Date.now() - conversion!.fetchedAt > CONFIG_MAX_AGE_MS) {
        const res = await doFetch(`${TELEMETRY_URL}/v1/config`, { headers: { Authorization: `Key ${TELEMETRY_KEY}` } }).catch(() => null);
        if (res?.ok) {
          const body = (await res.json()) as { conversion_values?: Milestone[] };
          conversion!.milestones = Array.isArray(body.conversion_values) ? body.conversion_values : [];
          conversion!.fetchedAt = Date.now();
          void storage.setItem(ATTRIBUTION_KEY, JSON.stringify(conversion)).catch(() => {});
        }
      }
      checkUnchecked();
    } catch (err) {
      log('error', 'attribution did not start', err);
    }
  }

  const attributionRuns = () => !!attribution && !optedOut;

  /** The milestones are missing, or came with another answer than the config in use. */
  const milestonesBehind = () => !conversion?.milestones || !cache || conversion.revision !== cache.revision;

  /**
   * After optIn(): milestones from before the opt-out, or none, are fetched
   * again. A request already out may have gone with If-None-Match (attribution
   * was not running when it left); its 304 brings no milestones, so once more.
   */
  async function catchUpMilestones(): Promise<void> {
    if (!configOn || !attributionRuns() || !milestonesBehind()) return;
    const first = await refresh();
    if (first.status === 304 && attributionRuns() && milestonesBehind()) await refresh();
  }

  // --- remote config

  let CONFIG_KEY = 'hush.config.v1';
  let CONFIG_SOURCE = '';
  let configOn = true;
  let refreshMs = 15 * 60_000;
  let appLanguage: (() => string) | undefined;
  // What the server last sent (or the stored copy), null until init() has read
  // storage; and the configSource() it came from.
  let cache: StoredConfig | null = null;
  let cacheSource = '';
  // identify()'s language: the language the app shows, as of this process.
  let identifiedLanguage: string | undefined;
  // The context of the last evaluation.
  let evaluatedWith: ReturnType<typeof configContext> | undefined;
  // The paid flag to store with the cache: identify()'s, kept for the next
  // launch's pro rules before identify() runs there. Never sent.
  let storedPro: boolean | undefined;
  // Each key's evaluation for this device. No prototype: a key named
  // "constructor" must not find anything inherited.
  let slots: Record<string, ConfigSlot> = Object.create(null);
  const configListeners = new Set<(keys: string[]) => void>();
  // Lines logged once per process: per key and reason, or per kind of answer.
  const loggedOnce = new Set<string>();
  // The last 200 in this process came without `config` while the cache has a
  // revision: the server was rolled back. No If-None-Match until one has it again.
  let configMissing = false;
  let configInFlight: Promise<ConfigRefreshResult> | null = null;
  // init() has read storage and started its own request: from then on
  // 'active' and the interval may fetch.
  let configStarted = false;
  let nextConfigAt = 0;
  let configFailures = 0;
  let usable = false;
  let usableWaiters: (() => void)[] = [];

  function logOnce(level: 'error' | 'debug', id: string, message: string) {
    if (loggedOnce.has(id)) return;
    loggedOnce.add(id);
    log(level, message);
  }

  const proInUse = () => isPro ?? storedPro;

  function configContext() {
    const d = platform.device();
    let language: unknown = identifiedLanguage;
    try {
      language ??= appLanguage?.();
    } catch {
      // The app's function failed: the phone's locale instead.
    }
    return {
      platform: d.platform,
      version: d.version,
      channel: CHANNEL,
      language: typeof language === 'string' && language.trim() ? language : d.locale,
      pro: proInUse(),
    };
  }

  function writeConfig(): void {
    if (!configOn || !cache) return;
    try {
      const data: StoredConfig & { pro?: boolean; source: string } = { revision: cache.revision, keys: cache.keys, source: cacheSource };
      if (typeof storedPro === 'boolean') data.pro = storedPro;
      void storage.setItem(CONFIG_KEY, JSON.stringify(data)).catch(() => {});
    } catch (err) {
      log('error', 'config not saved', err);
    }
  }

  /** Evaluates every key for this device, keeps equal values' references, and tells the listeners what changed. */
  function evaluateConfig(): string[] {
    const keys = configOn && cache ? cache.keys : {};
    const context = configContext();
    evaluatedWith = context;
    const results = evaluateAll(keys, context, installId || null);
    const next: Record<string, ConfigSlot> = Object.create(null);
    const changed: string[] = [];
    for (const key of Object.keys(results)) {
      if (!hasOwn(keys, key)) continue;
      const entry = keys[key];
      const result = results[key];
      const has = hasOwn(result, 'value');
      const before = hasOwn(slots, key) ? slots[key] : undefined;
      let value = result.value;
      if (has && before?.has && sameJson(before.value, value)) value = before.value;
      else if (has) value = deepFreeze(value);
      next[key] = { type: String(isRecord(entry) ? entry.type : undefined), has, value, rule: result.rule };
      if (before ? before.has !== has || (has && before.value !== value) : has) changed.push(key);
    }
    for (const key of Object.keys(slots)) if (!hasOwn(next, key) && slots[key].has) changed.push(key);
    slots = next;
    changed.sort();
    if (changed.length) {
      for (const listener of [...configListeners]) {
        try {
          listener([...changed]);
        } catch {
          // One listener's mistake never keeps the others from hearing.
        }
      }
    }
    return changed;
  }

  function markUsable(): void {
    if (usable) return;
    usable = true;
    const waiters = usableWaiters;
    usableWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * The stored config as init() read it; anything malformed, or stored for
   * another server or key, is no cache, and the next 200 overwrites it.
   */
  function loadConfig(raw: unknown): void {
    if (!isRecord(raw) || !isRecord(raw.keys) || (raw.revision !== null && typeof raw.revision !== 'string')) return;
    if (raw.source !== CONFIG_SOURCE) return;
    cache = { revision: raw.revision, keys: raw.keys };
    cacheSource = CONFIG_SOURCE;
    const filePro = typeof raw.pro === 'boolean' ? raw.pro : undefined;
    // identify() before init() is newer than the stored flag.
    if (isPro !== undefined) {
      storedPro = isPro;
      if (isPro !== filePro) writeConfig();
    } else storedPro = filePro;
    evaluateConfig();
    markUsable();
  }

  /** If-None-Match is safe: the device holds everything a 200 would give it. */
  function mayRevalidate(): boolean {
    if (!cache || cache.revision === null || configMissing || !REVISION_RE.test(cache.revision)) return false;
    // Milestones from an older answer must not be kept fresh by a 304.
    return !attributionRuns() || (!!conversion?.milestones && conversion.revision === cache.revision);
  }

  type Answer = { status: number | 'offline'; ok: boolean; parsed: boolean; body?: unknown };

  /** A GET limited to CONFIG_TIMEOUT_MS, the body included. Past it: offline, and whatever arrives later is ignored. */
  function getWithin(url: string, headers: Record<string, string>): Promise<Answer> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (answer: Answer) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(answer);
      };
      timer = setTimeout(() => {
        finish({ status: 'offline', ok: false, parsed: false });
        try {
          controller?.abort();
        } catch {
          // Nothing to stop.
        }
      }, CONFIG_TIMEOUT_MS);
      (async () => {
        const res = await doFetch(url, controller ? { headers, signal: controller.signal } : { headers });
        if (!res.ok) return finish({ status: res.status, ok: false, parsed: false });
        let body: unknown;
        let parsed = true;
        try {
          body = await res.json();
        } catch {
          parsed = false;
        }
        finish({ status: res.status, ok: true, parsed, body });
      })().catch(() => finish({ status: 'offline', ok: false, parsed: false }));
    });
  }

  /** One /v1/config request at a time; callers meanwhile share it. Never rejects. */
  function configRequest(): Promise<ConfigRefreshResult> {
    if (configInFlight) return configInFlight;
    if (!enabled || !configOn) return Promise.resolve({ status: 'off', changed: [] });
    configInFlight = runConfigRequest().finally(() => {
      configInFlight = null;
    });
    return configInFlight;
  }

  async function runConfigRequest(): Promise<ConfigRefreshResult> {
    const startedAt = Date.now();
    const source = CONFIG_SOURCE;
    const headers: Record<string, string> = { Authorization: `Key ${TELEMETRY_KEY}` };
    if (mayRevalidate()) headers['If-None-Match'] = `"${cache!.revision}"`;
    const answer = await getWithin(`${TELEMETRY_URL}/v1/config`, headers);
    let result: ConfigRefreshResult = { status: answer.status, changed: [] };
    try {
      // configure() pointed the SDK at another server or key meanwhile: the answer is not for it.
      if (source === CONFIG_SOURCE) result = applyAnswer(answer);
    } catch (err) {
      log('error', 'config not applied', err);
    }
    // A wrong key does not get better by asking every minute; a network or a
    // server that is down may, soon.
    const failed = answer.status === 'offline' || answer.status === 429 || answer.status >= 500;
    configFailures = failed ? configFailures + 1 : 0;
    nextConfigAt = startedAt + (failed ? Math.min(60_000 * 2 ** (configFailures - 1), refreshMs) : refreshMs);
    markUsable();
    return result;
  }

  function applyAnswer(answer: Answer): ConfigRefreshResult {
    const status = answer.status;
    if (status === 304) {
      if (attributionRuns() && conversion?.milestones) {
        conversion.fetchedAt = Date.now();
        void storage.setItem(ATTRIBUTION_KEY, JSON.stringify(conversion)).catch(() => {});
      }
      log('debug', 'config: not modified');
      return { status, changed: [] };
    }
    if (!answer.ok) {
      log('debug', `config: ${status === 'offline' ? 'offline or timed out' : `status ${status}`}; keeping what the app has`);
      return { status, changed: [] };
    }
    const body = answer.body;
    if (!answer.parsed || !isRecord(body)) {
      logOnce('error', 'answer:unreadable', 'config: the answer could not be read; keeping what the app has');
      return { status, changed: [] };
    }
    const config = body.config;
    const valid = isRecord(config) && isRecord(config.keys);
    const revision = valid && typeof config.revision === 'string' ? config.revision : null;
    if (attributionRuns() && conversion) {
      conversion.milestones = Array.isArray(body.conversion_values) ? (body.conversion_values as Milestone[]) : [];
      conversion.fetchedAt = Date.now();
      conversion.revision = revision;
      void storage.setItem(ATTRIBUTION_KEY, JSON.stringify(conversion)).catch(() => {});
      checkUnchecked();
    }
    if (valid) {
      configMissing = false;
      if (cache && cache.revision !== null && cache.revision === revision) return { status, changed: [] };
      cache = { revision, keys: config.keys as Record<string, unknown> };
      cacheSource = CONFIG_SOURCE;
      writeConfig();
      return { status, changed: evaluateConfig() };
    }
    if (config === undefined) {
      if (!cache || cache.revision === null) {
        // A server from before remote config, from the start: nothing to read, cached so ready() is quick next time.
        cache = { revision: null, keys: {} };
        cacheSource = CONFIG_SOURCE;
        writeConfig();
        return { status, changed: evaluateConfig() };
      }
      // A cache with a revision came from a newer server: this one was rolled
      // back. Keeping it keeps a kill switch set on the dashboard off.
      configMissing = true;
      logOnce('debug', 'answer:rollback', 'config: the server answered without config (rolled back?); keeping the cached config');
      return { status, changed: [] };
    }
    logOnce('error', 'answer:malformed', 'config: the answer has a config without keys; keeping what the app has');
    return { status, changed: [] };
  }

  /** 'active' and the foreground interval: a request when the next one is due, once init() has made its own. */
  function configDue(): void {
    if (configStarted && enabled && configOn && !configInFlight && Date.now() >= nextConfigAt) void configRequest();
  }

  /** The value for a getter, or the fallback with one line per key and reason. */
  function readConfig(getter: ConfigType, key: string, fallback: unknown): unknown {
    if (typeof key !== 'string' || !configOn || !cache) return fallback;
    const slot = hasOwn(slots, key) ? slots[key] : undefined;
    if (!slot) {
      if (cache.revision !== null) logOnce('error', `missing:${key}`, `config "${key}" is not in the server's config: using the fallback`);
      return fallback;
    }
    if (!CONFIG_TYPES.includes(slot.type)) {
      logOnce('error', `type:${key}`, `config "${key}" has type "${slot.type}", which this SDK does not read: using the fallback`);
    } else if (slot.type !== getter) {
      logOnce('error', `as:${getter}:${key}`, `config "${key}" is a ${slot.type}, read as ${getter}: using the fallback`);
    } else if (!slot.has) {
      logOnce('error', `none:${key}`, `config "${key}" has no usable value: using the fallback`);
    } else return slot.value;
    return fallback;
  }

  function refresh(): Promise<ConfigRefreshResult> {
    const off: ConfigRefreshResult = { status: 'off', changed: [] };
    if (!enabled || !configOn) return Promise.resolve(off);
    return init()
      .then(() => (ready || configStarted ? configRequest() : off))
      .catch(() => off);
  }

  const config: HushRemoteConfig = {
    bool: (key, fallback) => readConfig('bool', key, fallback) as boolean,
    number: (key, fallback) => readConfig('number', key, fallback) as number,
    string: (key, fallback) => readConfig('string', key, fallback) as string,
    json<T = unknown>(key: string, fallback: T): T {
      const value = readConfig('json', key, undefined);
      if (value !== undefined) return value as T;
      // Code that sorts or pushes into the result fails in development, not
      // only in production once a served (frozen) value arrives.
      if (typeof fallback === 'object' && fallback !== null && isDev()) deepFreeze(fallback);
      return fallback;
    },
    ready(timeoutMs = 3000) {
      if (!enabled || !configOn) return Promise.resolve();
      const ms = typeof timeoutMs === 'number' && !Number.isNaN(timeoutMs) ? Math.min(60_000, Math.max(0, timeoutMs)) : 3000;
      void init();
      if (usable) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          usableWaiters = usableWaiters.filter((w) => w !== done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        usableWaiters.push(done);
      });
    },
    onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      // Wrapped, so the same function added twice is removed one at a time.
      const entry = (keys: string[]) => listener(keys);
      configListeners.add(entry);
      return () => void configListeners.delete(entry);
    },
    refresh,
    revision: () => (configOn && cache ? cache.revision : null),
    snapshot() {
      if (!configOn || !cache) return [];
      return Object.keys(slots)
        .sort()
        .map((key) => {
          const slot = slots[key];
          const entry: ConfigSnapshotEntry = { key, type: slot.type, rule: slot.rule, bucket: installId ? bucket(installId, key) : null };
          if (slot.has) entry.value = slot.value;
          return entry;
        });
    },
  };


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
      configDue();
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
    // Remote config needs none of the reads below that may fail init(): it
    // starts with or without them.
    const configRead = configOn ? readStored(CONFIG_KEY) : Promise.resolve(null);
    try {
      // The install id, the first-launch marker and the opt-out are small and
      // have no safe default (a guess counts a new install, or ignores the
      // user's choice): failing to read them leaves telemetry off this launch.
      // The config and the attribution state are read here too: the config
      // request at the end of init() depends on both (If-None-Match), and a
      // 200 applied before the stored config would be overwritten by it.
      const [stored, first, storedOptOut, storedQueue, storedOnce, storedSessions, storedConfig, storedAttribution] = await Promise.all([
        storage.getItem(INSTALL_KEY),
        storage.getItem(FIRST_KEY),
        storage.getItem(OPTOUT_KEY),
        readStored(QUEUE_KEY),
        readStored(ONCE_KEY),
        readStored(SESSIONS_KEY),
        configRead,
        attribution ? storage.getItem(ATTRIBUTION_KEY).catch((): typeof READ_FAILED => READ_FAILED) : undefined,
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
      // An earlier init() that failed has the config already, maybe newer
      // than storage; the install id is new to it, and with it the buckets.
      if (configOn && !configStarted) loadConfig(storedConfig);
      else if (cache) evaluateConfig();
      void startAttribution(storedAttribution ?? null);
      if (configOn) {
        configStarted = true;
        void configRequest();
      }

      platform.onAppState(onAppState);
      flushTimer ??= setInterval(() => {
        // Also keeps the foreground time on disk for a process killed mid-session.
        persistSessions();
        void flush();
        if (activeSince > 0) configDue();
      }, FLUSH_MS);
      log('debug', `ready: install ${installId}, sdk ${SDK_VERSION}, channel ${CHANNEL ?? '(none)'}${optedOut ? ', opted out' : ''}`);
      void flush();
    } catch {
      // Anything failing here just leaves telemetry off for this launch. The
      // config does not depend on it: the stored one is read and one request
      // made, without an install id (rollouts below 100 do not match), and
      // refresh() fetches again. A later init() (refresh() calls it) may still
      // start the rest.
      if (configOn && !configStarted) {
        try {
          loadConfig(await configRead);
          configStarted = true;
          void configRequest();
        } catch {
          // Nothing more to try this launch.
        }
      }
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
   * `language`: the language the app shows, for remote config's language
   * rules, ahead of remoteConfig.language; '' goes back to it. Never sent.
   * A `pro` or `language` that changes what a rule sees evaluates the config
   * again at once, and onChange hears the keys that changed: call it from
   * an in-app language switch.
   */
  function identify(next: { rcId?: string; pro?: boolean; language?: string }): void {
    if (typeof next?.rcId === 'string' && next.rcId) rcId = next.rcId;
    if (typeof next?.pro === 'boolean') {
      isPro = next.pro;
      if (configOn && storedPro !== next.pro) {
        // With no cache yet it waits in memory for the first write.
        storedPro = next.pro;
        writeConfig();
      }
    }
    // Never sent and never stored: it is only for language rules.
    if (typeof next?.language === 'string') identifiedLanguage = next.language.trim() || undefined;
    // Against what the last evaluation saw, so a remoteConfig.language that
    // moved since is caught up too.
    if (cache) {
      const now = configContext();
      if (now.pro !== evaluatedWith?.pro || now.language !== evaluatedWith?.language) evaluateConfig();
    }
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
   * No usage data is queued or sent until optIn(); what was queued is
   * dropped. The app still asks /v1/config for its config: nothing the SDK
   * adds about the user, though like any request it carries the device's IP
   * address and User-Agent (remoteConfig: false stops it). Feedback keeps
   * working, since a user sends that on purpose.
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
    if (ready && !conversion) void startAttribution().then(catchUpMilestones);
    else if (ready) void catchUpMilestones();
  }

  /** Whether the user opted out. Read from storage by init(); before it resolves, false unless optOut() was called. */
  function isOptedOut(): boolean {
    return optedOut;
  }

  /**
   * The user's "delete my data": the server deletes the tickets sent with an
   * email whose keys this device holds, then everything stored about this
   * install (events, feedback), and the SDK starts over with a new install
   * id, as a fresh install would, but without counting a new one. Offline or
   * refused: the install and its data stay, and the app can offer to try
   * again; tickets with an email already deleted on the way stay deleted, and
   * a retry finishes the rest.
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
      // The tickets sent with an email first, by their keys, in requests of
      // their own: the install id and the keys never travel together. A key
      // is dropped once the server has deleted its ticket.
      const map = await readThreads();
      // Keys that cannot be read now may still be stored: forgetting the
      // install without them would report done while those tickets stay.
      if (!map) return { ok: false, error: 'failed' };
      const ids = Object.keys(map);
      for (let i = 0; i < ids.length; i += MAX_THREADS) {
        const chunk = ids.slice(i, i + MAX_THREADS);
        const sent = await post('/v1/forget', { threads: chunk.map((id) => map[id]) });
        if (!sent) return { ok: false, error: 'offline' };
        if (!sent.ok) return { ok: false, error: 'failed' };
        for (const id of chunk) delete unsaved[id];
        await updateThreads((stored) => {
          for (const id of chunk) delete stored[id];
        });
      }
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
      // The config stays (every install gets the same answer), without the
      // paid flag; rollouts re-bucket as for a new install.
      storedPro = undefined;
      if (cache) {
        writeConfig();
        evaluateConfig();
      }
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

  // Tickets sent with an email: ticket id -> thread key, the app's only handle
  // on them, kept in storage and read again on every use. A copy held in
  // memory went stale (a second tab on the web, a read that failed once) and
  // the next save wrote it over every other key, which loses those tickets
  // for good.
  //
  // Keys the server handed out in this process and not saved yet, because
  // the write or the read before it failed: part of every read, and saved by
  // the next write that works.
  let unsaved: Record<string, string> = Object.create(null);
  // Writes go one at a time, each on a fresh read.
  let threadsWrite: Promise<unknown> = Promise.resolve();

  /**
   * The stored keys and the unsaved ones. Null when storage could not be read:
   * unlike a value that does not parse, that is no reason to start over, so
   * nothing is written on it and the next call reads again.
   */
  async function readThreads(): Promise<Record<string, string> | null> {
    let raw: string | null;
    try {
      raw = await storage.getItem(THREADS_KEY);
    } catch (err) {
      log('error', `${THREADS_KEY} could not be read`, err);
      return null;
    }
    let stored: unknown = null;
    try {
      stored = raw == null ? null : JSON.parse(raw);
    } catch (err) {
      log('error', `${THREADS_KEY} could not be parsed: starting it empty`, err);
    }
    // No prototype: an id such as "constructor" must not find a key.
    const out: Record<string, string> = Object.create(null);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [id, key] of Object.entries(stored)) {
        if (/^[1-9][0-9]*$/.test(id) && typeof key === 'string' && THREAD_KEY.test(key)) out[id] = key;
      }
    }
    return Object.assign(out, unsaved);
  }

  /** Applies `change` to a fresh read and saves the result. False when it could not read or write. */
  function updateThreads(change: (map: Record<string, string>) => void): Promise<boolean> {
    const run = threadsWrite.then(async () => {
      const map = await readThreads();
      if (!map) return false;
      change(map);
      try {
        await storage.setItem(THREADS_KEY, JSON.stringify(map));
      } catch (err) {
        log('error', `${THREADS_KEY} could not be saved`, err);
        return false;
      }
      for (const id of Object.keys(unsaved)) if (map[id] === unsaved[id]) delete unsaved[id];
      return true;
    });
    threadsWrite = run.catch(() => false);
    return run;
  }

  /**
   * Sends feedback. With an email the ticket is contact info, so it must not
   * be joinable to this install's usage data: it goes without the install id
   * and RevenueCat's id, no ticket_opened marks the moment, and the server
   * answers with a thread key for it, kept on the device. A server from
   * before SDK 2.3.0 refuses a ticket without an install; that is `failed`,
   * and the SDK does not retry with the install. Without an email the install
   * id is how the answer finds its way back, as before.
   */
  async function createTicket(input: {
    kind: TicketKind;
    email?: string;
    subject?: string;
    message: string;
  }): Promise<{ ok: boolean; id?: string; error?: string }> {
    if (!enabled) return { ok: false, error: 'unavailable' };
    // Version, build, OS, device and the paid flag describe the build, not the person.
    const diag = (({ version, build, os, device }) => ({ version, build, os, device, pro: isPro }))(platform.device());
    if (input.email) {
      const res = await post('/v1/tickets', {
        kind: input.kind,
        email: input.email,
        subject: input.subject || undefined,
        message: input.message,
        diag,
      });
      if (!res) return { ok: false, error: 'offline' };
      if (res.status === 429) return { ok: false, error: 'too_many' };
      if (!res.ok) return { ok: false, error: 'failed' };
      const created = (await res.json().catch(() => null)) as { id?: string | number; thread?: unknown } | null;
      const id = created?.id !== undefined ? String(created.id) : undefined;
      if (id && typeof created?.thread === 'string' && THREAD_KEY.test(created.thread)) {
        unsaved[id] = created.thread;
        await updateThreads(() => {});
      }
      return { ok: true, id };
    }
    if (!installId) await init();
    const res = await post('/v1/tickets', {
      install: installId,
      kind: input.kind,
      // The RevenueCat customer id as of this moment, stored on the ticket
      // itself: a report from a paying user should be recognisable as one
      // without asking them who they are.
      rc_id: rcId,
      subject: input.subject || undefined,
      message: input.message,
      diag,
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
   * new message instead. On a ticket sent with an email it goes by that
   * ticket's thread key, and no ticket_replied is tracked.
   */
  async function replyToTicket(
    id: string,
    body: string,
  ): Promise<{ ok: boolean; error?: 'unavailable' | 'offline' | 'closed' | 'too_many' | 'failed' }> {
    if (!enabled) return { ok: false, error: 'unavailable' };
    const thread = ((await readThreads()) ?? unsaved)[String(id)];
    if (!thread && !installId) await init();
    const res = await post(`/v1/tickets/${encodeURIComponent(id)}/reply`, thread ? { thread, body } : { install: installId, body });
    if (!res) return { ok: false, error: 'offline' };
    if (res.status === 409) return { ok: false, error: 'closed' };
    if (res.status === 429) return { ok: false, error: 'too_many' };
    if (!res.ok) return { ok: false, error: 'failed' };
    if (!thread) enqueue('ticket_replied');
    return { ok: true };
  }

  /** One list request: its status (0 offline) and the tickets in it. */
  async function fetchTickets(path: string, body?: unknown): Promise<{ status: number; tickets: Ticket[] }> {
    try {
      const res = await doFetch(`${TELEMETRY_URL}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { Authorization: `Key ${TELEMETRY_KEY}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      });
      if (!res.ok) return { status: res.status, tickets: [] };
      const json = (await res.json()) as { tickets?: Ticket[] };
      return { status: res.status, tickets: Array.isArray(json?.tickets) ? json.tickets : [] };
    } catch {
      return { status: 0, tickets: [] };
    }
  }

  /**
   * This install's own tickets, with the install in the body: in a URL, a
   * proxy's access log would put it next to a reply on a ticket sent with an
   * email, from the same address. A server from before 2.3.0 has no such
   * route (404); there the install goes in the query, as it always did.
   */
  async function ownTickets(): Promise<Ticket[]> {
    const listed = await fetchTickets('/v1/tickets/list', { install: installId });
    if (listed.status !== 404) return listed.tickets;
    return (await fetchTickets(`/v1/tickets?install=${encodeURIComponent(installId)}`)).tickets;
  }

  /**
   * This install's tickets and the ones it sent with an email, newest first.
   * Two requests, never one: the install's by its id, the others by their
   * thread keys (the newest 50), so no request carries both.
   */
  async function listTickets(): Promise<Ticket[]> {
    if (!enabled) return [];
    if (!installId) await init();
    const stored = await readThreads();
    // Storage reads again: a good moment to save a key a failed write left behind.
    if (stored && Object.keys(unsaved).length) void updateThreads(() => {});
    const map = stored ?? unsaved;
    const keys = Object.keys(map).sort(newestFirst).slice(0, MAX_THREADS).map((id) => map[id]);
    const [own, keyed] = await Promise.all([
      ownTickets(),
      keys.length ? fetchTickets('/v1/tickets/threads', { threads: keys }).then((r) => r.tickets) : [],
    ]);
    const byId = new Map<string, Ticket>();
    for (const t of [...own, ...keyed]) if (t && !byId.has(String(t.id))) byId.set(String(t.id), t);
    return [...byId.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
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
    config,
  };
}
