/**
 * hush SDK: anonymous usage analytics and in-app support tickets for Expo /
 * React Native apps, talking to a hush server.
 *
 * The only identifier is an installation UUID this file generates on first
 * launch and keeps in AsyncStorage. No account, no advertising id, no
 * location, nothing a user typed — except the message they write themselves
 * into a support ticket. That is why the app asks for no consent: there is
 * nothing personal to consent to.
 *
 * Nothing here may ever break the app: every call is fire-and-forget, every
 * failure is swallowed, and a queued event that the server refuses is dropped
 * rather than retried forever. If the service is down or the key is missing,
 * the app behaves exactly as it does today.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Localization from 'expo-localization';
import { AppState, Platform, type AppStateStatus } from 'react-native';

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
};

let TELEMETRY_URL = '';
let TELEMETRY_KEY = '';
let INSTALL_KEY = 'hush.install.v1';
let QUEUE_KEY = 'hush.queue.v1';
let FIRST_KEY = 'hush.first.v1';
let withBackgroundTask: (work: () => Promise<void>) => Promise<void> = (work) => work();

/** Call once, before init(). Calling it again replaces the configuration. */
export function configure(config: HushConfig): void {
  TELEMETRY_URL = config.url.replace(/\/+$/, '');
  TELEMETRY_KEY = config.key ?? '';
  const prefix = config.storagePrefix ?? 'hush';
  INSTALL_KEY = `${prefix}.install.v1`;
  QUEUE_KEY = `${prefix}.queue.v1`;
  FIRST_KEY = `${prefix}.first.v1`;
  if (config.runInBackground) withBackgroundTask = config.runInBackground;
  enabled = TELEMETRY_KEY.length > 0;
}

type Value = string | number | boolean | null;
export type Props = Record<string, Value>;

type QueuedEvent = { id: string; name: string; at: string; session: string; props: Props };

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
// The session_started event of the session that just began, held back from
// the queue while its entry can still be claimed. A widget tap, a reminder,
// Siri or a link all report themselves a moment *after* the app is active,
// and init() flushes the queue the instant it is ready, so an event that
// went straight into the queue would already be on the wire when the claim
// arrived. Held out, it leaves with the right entry or, after the window,
// as a plain launch. A process killed inside the window loses that one
// session_started; the window is short enough that this is rare.
let pendingSession: { event: QueuedEvent; timer: ReturnType<typeof setTimeout> } | null = null;
const ENTRY_WINDOW_MS = 2500;

/**
 * Where a session began: the app's own doors (a widget, a quick action, a
 * notification, a deep link...). Any short snake_case string; the dashboard
 * slices sessions by it as it is. `launch` is the default.
 */
export type Entry = 'launch' | 'widget' | 'quick_action' | 'siri' | 'notification' | 'link' | (string & {});

const appVersion = () => Constants.expoConfig?.version ?? '';
const appBuild = () =>
  String(
    Platform.OS === 'ios'
      ? (Constants.expoConfig?.ios?.buildNumber ?? '')
      : (Constants.expoConfig?.android?.versionCode ?? ''),
  );
const osName = () => `${Platform.OS} ${Device.osVersion ?? ''}`.trim();
const deviceName = () => Device.modelId ?? Device.modelName ?? '';

function context() {
  return {
    version: appVersion(),
    build: appBuild(),
    platform: Platform.OS,
    os: osName(),
    device: deviceName(),
    // The phone's language, not the app's override: it says which
    // translations are worth having, which is what the number is for.
    locale: Localization.getLocales()[0]?.languageTag ?? '',
    rc_id: rcId,
    pro: isPro,
  };
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // Oldest first out: a queue this long means the service has been
    // unreachable for days, and the recent events are the useful ones.
    void AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE))).catch(() => {});
  }, 1000);
}

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`${TELEMETRY_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Key ${TELEMETRY_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function flush(): Promise<void> {
  if (!enabled || !ready || flushing || queue.length === 0 || Date.now() < retryAfter) return;
  flushing = true;
  try {
    const batch = queue.slice(0, BATCH);
    const res = await post('/v1/events', {
      sent_at: new Date().toISOString(),
      sdk: '1',
      context: context(),
      events: batch.map((e) => ({ ...e, install: installId })),
    });
    if (res && (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429))) {
      // 2xx means stored; a 4xx that is not a rate limit means the server will
      // never accept these events, so keeping them would block the queue.
      queue = queue.slice(batch.length);
      failures = 0;
      persistSoon();
    } else {
      failures += 1;
      retryAfter = Date.now() + Math.min(5000 * 2 ** (failures - 1), 5 * 60_000);
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

function enqueue(name: string, props: Props = {}): QueuedEvent | null {
  if (!enabled) return null;
  const event: QueuedEvent = { id: uuid(), name, at: new Date().toISOString(), session: sessionId, props };
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
  if (!enabled) return;
  const event: QueuedEvent = { id: uuid(), name: 'session_started', at: new Date().toISOString(), session: sessionId, props: { entry: 'launch' } };
  pendingSession = { event, timer: setTimeout(commitSession, ENTRY_WINDOW_MS) };
}

/**
 * How this session began, reported by the screen that knows: the root layout
 * for URLs and notification taps. Claims the held session_started when it is
 * still within the window; after that the app has been open for a while and
 * the tap is an action inside the session, not its entry.
 */
export function entry(source: Entry): void {
  if (!pendingSession) return;
  pendingSession.event.props.entry = source;
  commitSession();
}

function onAppState(state: AppStateStatus) {
  if (state === 'background' || state === 'inactive') {
    backgroundedAt = Date.now();
    // Leaving is the deadline: whatever entry the session has by now is the
    // one it gets, and it goes out with everything else, through
    // runInBackground so an app can give the fetch real runway instead of
    // racing process suspension.
    commitSession();
    void withBackgroundTask(flush);
    return;
  }
  if (state === 'active' && backgroundedAt && Date.now() - backgroundedAt > SESSION_GAP_MS) {
    startSession();
  }
}

/**
 * Safe to call more than once and safe to call before anything else; it never
 * throws and never blocks a render. Events tracked before it resolves are
 * queued and get the install id at flush time.
 */
export function init(): Promise<void> {
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
    const [stored, storedQueue, first] = await Promise.all([
      AsyncStorage.getItem(INSTALL_KEY),
      AsyncStorage.getItem(QUEUE_KEY),
      AsyncStorage.getItem(FIRST_KEY),
    ]);
    installId = stored ?? uuid();
    if (!stored) await AsyncStorage.setItem(INSTALL_KEY, installId);

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
      await AsyncStorage.setItem(FIRST_KEY, new Date().toISOString());
    }
    startSession();

    AppState.addEventListener('change', onAppState);
    flushTimer ??= setInterval(() => void flush(), FLUSH_MS);
    void flush();
  } catch {
    // Anything failing here just leaves telemetry off for this launch.
  }
}

export function track(name: string, props: Props = {}): void {
  enqueue(name, props);
}

export function screen(name: string): void {
  enqueue('screen_viewed', { screen: name });
}

/** RevenueCat's own anonymous customer id, so purchases can be joined to installs without ever setting an appUserID; and whether the install is on a paid plan. */
export function identify(next: { rcId?: string; pro?: boolean }): void {
  if (next.rcId) rcId = next.rcId;
  if (typeof next.pro === 'boolean') isPro = next.pro;
}

export function installationId(): string {
  return installId;
}

/** For dev builds and tests. There is no user-facing toggle: nothing personal is collected. */
export function setEnabled(next: boolean): void {
  enabled = next && TELEMETRY_KEY.length > 0;
  if (!enabled) {
    queue = [];
    void AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
  }
}

export async function flushNow(): Promise<void> {
  commitSession();
  await flush();
}

// --- support tickets

export async function createTicket(input: {
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
    diag: { version: appVersion(), build: appBuild(), os: osName(), device: deviceName(), pro: isPro },
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
export async function replyToTicket(
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

export async function listTickets(): Promise<Ticket[]> {
  if (!enabled) return [];
  if (!installId) await init();
  try {
    const res = await fetch(`${TELEMETRY_URL}/v1/tickets?install=${encodeURIComponent(installId)}`, {
      headers: { Authorization: `Key ${TELEMETRY_KEY}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { tickets: Ticket[] };
    return body.tickets ?? [];
  } catch {
    return [];
  }
}

export const telemetryAvailable = (): boolean => enabled;
