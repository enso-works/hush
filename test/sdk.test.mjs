// The SDK (sdk/src/index.ts), run as it is under Node: its React Native and
// Expo imports resolve to mocks (test/sdk/), fetch is recorded, and the clock
// is Node's mock timers. Each test loads a fresh copy of the module, the way
// each app launch starts with fresh memory and the same storage.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { register } from 'node:module';
import { beforeEach, mock, test } from 'node:test';

register('./sdk/hooks.mjs', import.meta.url);

const h = (globalThis.__hush ??= { storage: new Map(), listeners: [] });
let sent;
let launches = 0;
let configFetches = 0;
// The catalog's conversion values, as /v1/config serves them.
let milestones = [];
let status = 200;

beforeEach(() => {
  h.storage.clear();
  h.failReads = {};
  h.listeners.length = 0;
  sent = [];
  status = 200;
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-09-30T10:00:00Z') });
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (new URL(url).pathname === '/v1/config') {
      configFetches++;
      return { ok: true, status: 200, json: async () => ({ conversion_values: milestones }) };
    }
    sent.push({ path: new URL(url).pathname, body });
    const n = body?.events?.length ?? 0;
    return { ok: status < 300, status, json: async () => ({ ok: true, accepted: n, duplicate: 0, rejected: 0 }) };
  };
});

/**
 * A fresh process: a new module instance, configured, not yet initialised.
 * The last process's timers die with it, as they do when iOS kills an app.
 */
async function load(config = {}) {
  const now = Date.now();
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  h.listeners.length = 0;
  const sdk = await import(`../sdk/src/index.ts?launch=${++launches}`);
  sdk.configure({ url: 'https://hush.test', key: 'hush_app_prod_x', ...config });
  return sdk;
}
/** A fresh launch: a new process, configured and initialised. */
async function launch(config = {}) {
  const sdk = await load(config);
  await sdk.init();
  await settle(); // init() starts its first send without waiting for it
  return sdk;
}
// setImmediate is not among the mocked timers, so this lets pending I/O finish.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
// Time passing with I/O settling between timers, as on a device: one big
// tick() runs every timer before any request they start has answered.
const advance = async (ms) => {
  for (let t = 0; t < ms; t += 100) {
    mock.timers.tick(100);
    await settle();
  }
};
const events = () => sent.filter((r) => r.path === '/v1/events').flatMap((r) => r.body.events);
const batches = () => sent.filter((r) => r.path === '/v1/events').map((r) => r.body);
const named = (name) => events().filter((e) => e.name === name);
const appState = async (state) => {
  for (const fn of h.listeners) fn(state);
  await Promise.resolve();
};
const minutes = (n) => mock.timers.tick(n * 60_000);

test('a batch carries the SDK version and the build channel; global props join every event', async () => {
  const sdk = await launch({ channel: 'testflight' });
  sdk.setGlobalProps({ paywall_variant: 'b', theme: 'dark' });
  sdk.track('paywall_viewed', { source: 'settings', theme: 'light' });
  sdk.removeGlobalProp('theme');
  sdk.track('purchase_started');
  await sdk.flushNow();
  const batch = sent.find((r) => r.path === '/v1/events').body;
  assert.equal(batch.sdk, sdk.SDK_VERSION);
  assert.equal(batch.context.channel, 'testflight');
  assert.deepEqual(named('paywall_viewed')[0].props, { paywall_variant: 'b', theme: 'light', source: 'settings' }, "the event's own props win");
  assert.deepEqual(named('purchase_started')[0].props, { paywall_variant: 'b' });
  assert.equal(named('session_started')[0].props.paywall_variant, 'b', 'the held session start picks up globals set after it');
  assert.ok(!('once' in named('paywall_viewed')[0]), 'device-only fields never leave the device');
});

test('a channel that is not a plain label is not sent', async () => {
  const sdk = await launch({ channel: 'Test Flight' });
  sdk.track('x_y');
  await sdk.flushNow();
  assert.equal(sent[0].body.context.channel, undefined);
});

test('once: sent at most once per install, across launches, and per key', async () => {
  let sdk = await launch();
  sdk.track('onboarding_completed', {}, { once: true });
  sdk.track('onboarding_completed', {}, { once: true });
  sdk.track('tip_seen', { tip: 'a' }, { once: 'a' });
  sdk.track('tip_seen', { tip: 'b' }, { once: 'b' });
  await sdk.flushNow();
  assert.equal(named('onboarding_completed').length, 1);
  assert.equal(named('tip_seen').length, 2);

  // Next launch, tracked before init() has read what was sent: still once.
  sent = [];
  const next = await import(`../sdk/src/index.ts?launch=${++launches}`);
  next.configure({ url: 'https://hush.test', key: 'hush_app_prod_x' });
  next.track('onboarding_completed', {}, { once: true });
  await next.init();
  next.track('tip_seen', {}, { once: 'a' });
  await next.flushNow();
  assert.equal(named('onboarding_completed').length, 0);
  assert.equal(named('tip_seen').length, 0);
  sdk = next;
});

test('sessions are numbered and report the previous one\'s time in the foreground', async () => {
  let sdk = await launch();
  await sdk.flushNow();
  assert.deepEqual(named('session_started')[0].props, { entry: 'launch', n: 1 });

  minutes(2); // two minutes in the app
  await appState('background');
  minutes(31); // long enough to be a new session
  await appState('active');
  await sdk.flushNow();
  const second = named('session_started')[1].props;
  assert.equal(second.n, 2);
  assert.equal(second.prev_fg_s, 120);

  // A cold start: the last session's time comes from storage.
  minutes(3);
  await appState('background');
  sent = [];
  sdk = await launch();
  await sdk.flushNow();
  const third = named('session_started')[0].props;
  assert.equal(third.n, 3);
  assert.equal(third.prev_fg_s, 180);
});

test('a link entry keeps its campaign tags and nothing else from the URL', async () => {
  const sdk = await launch();
  sdk.entry('link', { url: 'myapp://open/item/42?utm_source=meta&utm_campaign=autumn%20update&utm_term=broad&token=secret&fbclid=x&ref=site#x' });
  await sdk.flushNow();
  assert.deepEqual(named('session_started')[0].props, { entry: 'link', n: 1, utm_source: 'meta', utm_campaign: 'autumn update', utm_term: 'broad', ref: 'site' });
});

test('opting out is remembered: nothing queued or sent until opting back in', async () => {
  let sdk = await launch();
  sent = []; // init() already sent app_first_opened, before the user said anything
  sdk.optOut();
  sdk.track('paywall_viewed');
  await sdk.flushNow();
  assert.equal(events().length, 0, 'the held session start is dropped too');
  assert.equal(sdk.isOptedOut(), true);

  sdk = await launch();
  assert.equal(sdk.isOptedOut(), true);
  sdk.track('paywall_viewed');
  await sdk.flushNow();
  assert.equal(events().length, 0);

  sdk.optIn();
  sdk.track('paywall_viewed');
  await sdk.flushNow();
  assert.equal(named('paywall_viewed').length, 1);
  assert.equal(named('session_started').length, 1, 'opting in starts a session');
});

test('forget: the server deletes the install, the SDK starts over with a new id', async () => {
  let sdk = await launch();
  sdk.track('onboarding_completed', {}, { once: true });
  await sdk.flushNow();
  const before = sdk.installationId();
  sent = [];
  const r = await sdk.forget();
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(sent[0], { path: '/v1/forget', body: { install: before } });
  assert.notEqual(sdk.installationId(), before);
  sdk.track('onboarding_completed', {}, { once: true });
  await sdk.flushNow();
  assert.equal(named('onboarding_completed').length, 1, 'a new identity has sent nothing yet');
  assert.equal(named('app_first_opened').length, 0, 'but it is not a new install');
  assert.ok(events().every((e) => e.install === sdk.installationId()));

  sdk = await launch();
  assert.equal(sdk.installationId(), (await sdk.getInstallationId()), 'the new id is the stored one');
  assert.notEqual(sdk.installationId(), before);
});

test('forget offline changes nothing', async () => {
  const sdk = await launch();
  const before = sdk.installationId();
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await sdk.forget(), { ok: false, error: 'offline' });
  assert.equal(sdk.installationId(), before);
});

test('onFlush reports each send; a server error keeps the batch for a retry', async () => {
  const results = [];
  status = 503;
  const sdk = await launch({ onFlush: (r) => results.push(r) }); // init's own send fails
  sdk.track('first_thing');
  await sdk.flushNow(); // inside the backoff: not sent
  assert.equal(results[0].willRetry, true);
  assert.equal(results[0].status, 503);
  status = 200;
  minutes(1); // past the backoff: the SDK's own timer sends
  await settle();
  await sdk.flushNow();
  const last = results.at(-1);
  assert.equal(last.willRetry, false);
  assert.equal(results.reduce((n, r) => n + r.accepted, 0), 3, 'app_first_opened, session_started and first_thing, all delivered once');
});

test('pause holds events until resume; an invalid name never leaves the device', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const sdk = await launch({ logLevel: 'error' });
  sent = [];
  sdk.pause();
  sdk.track('Bad Name');
  sdk.track('fine_name');
  await sdk.flushNow();
  assert.equal(events().length, 0);
  sdk.resume();
  await sdk.flushNow();
  assert.equal(named('fine_name').length, 1);
  assert.equal(events().some((e) => e.name === 'Bad Name'), false);
  assert.match(String(warn.mock.calls[0].arguments.join(' ')), /not snake_case/);
  warn.mock.restore();
});

test('with an empty key the SDK is off: no storage, no requests', async () => {
  const sdk = await launch({ key: '' });
  sdk.track('anything');
  await sdk.flushNow();
  assert.equal(sent.length, 0);
  assert.equal(h.storage.size, 0);
  assert.deepEqual(await sdk.forget(), { ok: false, error: 'unavailable' });
});

test('the core runs on any platform: storage, lifecycle and device come from the caller', async () => {
  const { createHush } = await import(`../sdk/src/core.ts?launch=${++launches}`);
  const store = new Map();
  let lifecycle;
  const hush = createHush({
    storage: { getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => void store.set(k, v), removeItem: async (k) => void store.delete(k) },
    onAppState: (fn) => (lifecycle = fn),
    device: () => ({ version: '9.9.9', build: '1', platform: 'web', os: 'macOS', device: 'browser', locale: 'de-DE' }),
    isDev: () => true,
  });
  hush.configure({ url: 'https://hush.test', key: 'hush_web_prod_x' });
  await hush.init();
  hush.track('page_viewed');
  lifecycle('background'); // leaving: commits the session and sends
  await settle();
  const batch = sent.at(-1).body;
  assert.equal(batch.context.platform, 'web');
  assert.equal(batch.context.channel, 'dev', 'isDev() gives the default channel');
  assert.deepEqual(events().map((e) => e.name).sort(), ['app_first_opened', 'page_viewed', 'session_started']);
  assert.ok(store.has('hush.install.v1'));
});

test('SDK_VERSION is the published package version', async () => {
  const { SDK_VERSION } = await import(`../sdk/src/core.ts?launch=${++launches}`);
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(SDK_VERSION, pkg.version);
});

test('the web entry: localStorage, the page hiding as leaving, the device from the user agent, keepalive sends', async () => {
  const store = new Map();
  const doc = { visibilityState: 'visible', listeners: [], addEventListener: (_t, fn) => doc.listeners.push(fn) };
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
  globalThis.document = doc;
  const inits = [];
  const recording = globalThis.fetch;
  globalThis.fetch = (url, init) => (inits.push(init), recording(url, init));
  try {
    const { createWebHush, fromUserAgent } = await import(`../sdk/src/web.ts?launch=${++launches}`);
    const hush = createWebHush({ version: '1.4.0', build: '2609301200', platform: 'ios', dev: false });
    hush.configure({ url: 'https://hush.test', key: 'hush_game_prod_x', channel: 'testflight' });
    await hush.init();
    await settle();
    hush.track('match_finished', { won: true });
    doc.visibilityState = 'hidden';
    for (const fn of doc.listeners) fn();
    await settle();
    const batch = sent.at(-1).body;
    assert.deepEqual(
      { version: batch.context.version, build: batch.context.build, platform: batch.context.platform, channel: batch.context.channel },
      { version: '1.4.0', build: '2609301200', platform: 'ios', channel: 'testflight' },
    );
    assert.ok(named('match_finished').length === 1, 'hiding the page sends');
    assert.ok(inits.every((i) => i.keepalive === true));
    assert.ok([...store.keys()].some((k) => k.startsWith('hush.')), 'the install id is kept in localStorage');

    const capacitorIphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    assert.deepEqual(fromUserAgent(capacitorIphone), { platform: 'ios', os: 'ios 18.2', device: 'iPhone' });
    const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
    assert.deepEqual(fromUserAgent(macChrome), { platform: 'web', os: 'macOS 10.15.7', device: 'Mac' });
    assert.deepEqual(fromUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile'), { platform: 'android', os: 'android 15', device: 'Android phone' });
  } finally {
    delete globalThis.localStorage;
    delete globalThis.document;
  }
});

test("Apple's conversion value: registered at 0 once, raised as the catalog's milestones happen, never lowered", async () => {
  milestones = [
    { value: 1, coarse: 'low', event: 'onboarding_completed', where: null, lock: false },
    { value: 20, coarse: 'medium', event: 'purchase_result', where: { result: 'purchased' }, lock: false },
    { value: 63, coarse: 'high', event: 'purchase_result', where: { result: 'purchased', product: 'lifetime' }, lock: true },
  ];
  configFetches = 0;
  const updates = [];
  const attribution = { update: async (v) => void updates.push(v) };
  let sdk = await launch({ attribution });
  assert.deepEqual(updates, [{ fine: 0, coarse: 'low', lock: false }], 'the install registers');
  sdk.track('onboarding_completed');
  sdk.track('purchase_result', { result: 'cancelled' });
  sdk.track('purchase_result', { result: 'purchased', product: 'lifetime' });
  sdk.track('onboarding_completed'); // lower than what is set: ignored
  await settle();
  assert.deepEqual(updates.map((u) => u.fine), [0, 1, 63]);
  assert.deepEqual(updates.at(-1), { fine: 63, coarse: 'high', lock: true });

  // The next launch neither registers again nor fetches the milestones again (cached for 12 hours).
  sdk = await launch({ attribution });
  assert.equal(updates.length, 3);
  assert.equal(configFetches, 1);

  // After Apple's 35 days, nothing is set.
  const late = [];
  h.storage.clear();
  sdk = await launch({ attribution: { update: async (v) => void late.push(v) } });
  mock.timers.tick(36 * 86400000);
  sdk.track('onboarding_completed');
  await settle();
  assert.deepEqual(late.map((u) => u.fine), [0]);
});

test('an opted-out user sets no conversion value; events before the milestones arrive still count', async () => {
  milestones = [{ value: 5, coarse: 'low', event: 'tutorial_done', where: null, lock: false }];
  const updates = [];
  const sdk = await import(`../sdk/src/index.ts?launch=${++launches}`);
  sdk.configure({ url: 'https://hush.test', key: 'hush_app_prod_x', attribution: { update: (v) => void updates.push(v) } });
  sdk.track('tutorial_done'); // before init: checked once the milestones are in
  await sdk.init();
  await settle();
  assert.deepEqual(updates.map((u) => u.fine), [0, 5]);

  h.storage.clear();
  const quiet = [];
  const next = await launch({ attribution: { update: (v) => void quiet.push(v) } });
  next.optOut();
  next.track('tutorial_done');
  await settle();
  assert.deepEqual(quiet.map((u) => u.fine), [0], 'registered before the choice, nothing after');
});

test('a native call that fails is taken back, and the same milestone is tried again later', async () => {
  milestones = [{ value: 3, coarse: 'low', event: 'tutorial_done', where: null, lock: false }];
  let fail = true;
  const calls = [];
  const bridge = {
    update: async (v) => {
      calls.push(v.fine);
      if (fail && v.fine === 3) throw new Error('SKANErrorDomain 10');
    },
  };
  const sdk = await launch({ attribution: bridge });
  sdk.track('tutorial_done');
  await settle();
  fail = false;
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0, 3, 3], 'the failed 3 did not count as set');
});

test('offline at start: the milestones come on the next launch, and nothing breaks meanwhile', async () => {
  milestones = [{ value: 7, coarse: 'medium', event: 'tutorial_done', where: null, lock: false }];
  const calls = [];
  const bridge = { update: async (v) => void calls.push(v.fine) };
  const online = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname === '/v1/config') throw new Error('offline');
    return online(url, init);
  };
  let sdk = await launch({ attribution: bridge });
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0], 'registered; no milestones yet');
  globalThis.fetch = online;
  sdk = await launch({ attribution: bridge });
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0, 7]);
});

test('opting back in starts attribution for an install that was opted out at launch', async () => {
  milestones = [{ value: 9, coarse: 'medium', event: 'tutorial_done', where: null, lock: false }];
  const calls = [];
  const bridge = { update: async (v) => void calls.push(v.fine) };
  let sdk = await launch({ attribution: bridge });
  sdk.optOut();
  sdk = await launch({ attribution: bridge });
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0], 'nothing while opted out');
  sdk.optIn();
  await settle();
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0, 9]);
});

test('forget keeps the conversion value: it is the device, not the identity, that Apple attributes', async () => {
  milestones = [{ value: 4, coarse: 'low', event: 'tutorial_done', where: null, lock: false }];
  const calls = [];
  const sdk = await launch({ attribution: { update: async (v) => void calls.push(v.fine) } });
  sdk.track('tutorial_done');
  await settle();
  await sdk.forget();
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0, 4], 'not registered again, not lowered');
});

test('without a bridge nothing is fetched or set, and the web entry takes one too', async () => {
  configFetches = 0;
  const sdk = await launch();
  sdk.track('tutorial_done');
  await settle();
  assert.equal(configFetches, 0);
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
  globalThis.document = { visibilityState: 'visible', addEventListener() {} };
  try {
    milestones = [{ value: 2, coarse: 'low', event: 'level_up', where: null, lock: false }];
    const calls = [];
    const { createWebHush } = await import(`../sdk/src/web.ts?launch=${++launches}`);
    const web = createWebHush({ version: '1.0.0' });
    web.configure({ url: 'https://hush.test', key: 'hush_web_prod_x', attribution: { update: (v) => void calls.push(v.fine) } });
    await web.init();
    web.track('level_up');
    await settle();
    assert.deepEqual(calls, [0, 2]);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.document;
  }
});

// --- Timing and input: what an app gets right without knowing the SDK's internals

test('an entry reported before init() resolves names the cold start, with its link tags', async () => {
  const sdk = await load();
  void sdk.init(); // the root layout's effect
  // Linking.getInitialURL() answers before init() has read storage.
  sdk.entry('link', { url: 'https://braele.app/pricing?utm_source=meta&utm_campaign=autumn' });
  await settle();
  await sdk.flushNow();
  assert.deepEqual(named('session_started')[0].props, { entry: 'link', n: 1, utm_source: 'meta', utm_campaign: 'autumn' });

  // Behind a slow gate (fonts, consent) the claim still waits for the session.
  sent = [];
  const late = await load();
  late.entry('widget');
  await advance(5000);
  await late.init();
  await late.flushNow();
  assert.equal(named('session_started')[0].props.entry, 'widget');
});

test('a claim after the session has begun keeps the 2.5 s window', async () => {
  const sdk = await launch();
  await advance(3000); // the session went out as a plain launch
  sdk.entry('notification'); // a tap inside the session, not its entry
  await appState('background');
  minutes(31);
  await appState('active'); // a new session, long after that tap
  await sdk.flushNow();
  assert.deepEqual(named('session_started').map((e) => e.props.entry), ['launch', 'launch']);
});

test('a warm return: the URL arriving just before "active" still names the new session', async () => {
  const sdk = await launch();
  await advance(3000);
  await appState('background');
  minutes(31);
  sdk.entry('widget'); // iOS delivers openURL before didBecomeActive
  await appState('active');
  await sdk.flushNow();
  assert.deepEqual(named('session_started').map((e) => e.props.entry), ['launch', 'widget']);
});

test('a cold launch is one session: events tracked before init() share its id, and its start sorts first', async () => {
  const sdk = await load();
  sdk.screen('today'); // a child's effect runs before the root layout's
  mock.timers.tick(200); // the first render took a while
  void sdk.init();
  sdk.track('habit_checked');
  await settle();
  sdk.track('habit_checked');
  await sdk.flushNow();
  assert.deepEqual([...new Set(events().map((e) => e.name))].sort(), ['app_first_opened', 'habit_checked', 'screen_viewed', 'session_started']);
  assert.equal(new Set(events().map((e) => e.session)).size, 1, 'app_first_opened, the early events and session_started carry one id');
  const start = named('session_started')[0].at;
  assert.ok(events().every((e) => e.at >= start), 'campaign funnels count steps from the session start');

  // The next session in the same process gets an id of its own.
  await appState('background');
  minutes(31);
  await appState('active');
  await sdk.flushNow();
  assert.equal(new Set(events().map((e) => e.session)).size, 2);
});

test("events tracked before init() never replace the previous launch's unsent queue", async () => {
  status = 503; // the first launch never gets through
  let sdk = await launch();
  sdk.track('habit_checked');
  await advance(3000);
  await appState('background');
  await advance(1500);
  const stored = JSON.parse(h.storage.get('hush.queue.v1')).map((e) => e.id);
  assert.equal(stored.length, 3);

  status = 200;
  sent = [];
  sdk = await load();
  sdk.track('early_event');
  await advance(1500); // init() behind a splash screen: the save timer would fire first
  assert.deepEqual(JSON.parse(h.storage.get('hush.queue.v1')).map((e) => e.id), stored, 'nothing is written before init() has read it');
  await sdk.init();
  await settle();
  await sdk.flushNow();
  const ids = events().map((e) => e.id);
  assert.ok(stored.every((id) => ids.includes(id)), "the previous launch's events are delivered");
  assert.equal(ids.length, new Set(ids).size, 'and nothing twice');
  assert.equal(named('early_event').length, 1);
});

test('pro is left out until identify() says so, so a batch that does not know never downgrades a paid install', async () => {
  const sdk = await launch(); // init() sends app_first_opened at once
  assert.ok(!('pro' in batches()[0].context), 'no flag before identify()');
  await sdk.createTicket({ kind: 'issue', message: 'It froze' });
  assert.ok(!('pro' in sent.find((r) => r.path === '/v1/tickets').body.diag), 'nor on a ticket');
  sdk.identify({ pro: true });
  sdk.track('x_y');
  await sdk.flushNow();
  assert.equal(batches().at(-1).context.pro, true);
  sdk.identify({ pro: false });
  sdk.track('x_y');
  await sdk.flushNow();
  assert.equal(batches().at(-1).context.pro, false, 'an explicit false still goes out');
});

test('never throws into the app: a missing url or key turns the SDK off and says why; bad arguments are ignored', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const sdk = await import(`../sdk/src/index.ts?launch=${++launches}`);
    assert.doesNotThrow(() => sdk.configure({ url: undefined, key: 'hush_app_prod_x', logLevel: 'error' }));
    assert.equal(sdk.telemetryAvailable(), false);
    assert.match(warn.mock.calls.at(-1).arguments.join(' '), /url is missing or not a string: telemetry is off/);
    assert.doesNotThrow(() => sdk.configure({ url: 42, key: 'hush_app_prod_x' }));
    assert.equal(sdk.telemetryAvailable(), false);
    assert.doesNotThrow(() => sdk.configure({ url: 'https://hush.test', key: undefined, logLevel: 'error' }));
    assert.equal(sdk.telemetryAvailable(), false);
    assert.match(warn.mock.calls.at(-1).arguments.join(' '), /key is missing or not a string/);
    assert.doesNotThrow(() => sdk.configure(undefined));
    assert.doesNotThrow(() => sdk.configure(null));
    assert.equal(sdk.telemetryAvailable(), false);
    // An empty key is the documented off switch (url and key both '' before
    // the server exists): off, and quiet even at logLevel 'error'.
    const warned = warn.mock.callCount();
    sdk.configure({ url: '', key: '', logLevel: 'error' });
    sdk.configure({ url: 'https://hush.test', key: '', logLevel: 'error' });
    assert.equal(sdk.telemetryAvailable(), false);
    assert.equal(warn.mock.callCount(), warned);
    await sdk.init();
    sdk.track('x_y');
    await sdk.flushNow();
    assert.equal(sent.length, 0, 'off: nothing is sent');

    const on = await launch();
    assert.doesNotThrow(() => on.track('x_y', null));
    assert.doesNotThrow(() => on.track('x_y', undefined, null));
    assert.doesNotThrow(() => on.identify(undefined));
    assert.doesNotThrow(() => on.identify(null));
    assert.doesNotThrow(() => on.entry('link', null));
    assert.doesNotThrow(() => on.setGlobalProps(null));
    await on.flushNow();
    assert.equal(named('x_y').length, 2);
    assert.equal(named('session_started')[0].props.entry, 'link');
  } finally {
    warn.mock.restore();
  }
});

test('every event the SDK sends by itself is one the server knows for any app', async () => {
  // Not catalog.mjs: it pulls in pg, and the publish workflow runs this file
  // without the server's dependencies.
  const { COMMON } = await import('../src/common.mjs');
  const sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'It froze' });
  await sdk.replyToTicket('1', 'Still frozen');
  await sdk.flushNow();
  const own = [...new Set(events().map((e) => e.name))].sort();
  assert.deepEqual(own, ['app_first_opened', 'session_started', 'ticket_opened', 'ticket_replied']);
  assert.deepEqual(own.filter((n) => !COMMON.includes(n)), [], 'none of them shows under unknown events');
});

test('a second init() while the first is still running resolves only once the session exists', async () => {
  const { createHush } = await import(`../sdk/src/core.ts?launch=${++launches}`);
  const store = new Map();
  let release;
  const slow = new Promise((r) => (release = r));
  const hush = createHush({
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      // The first-launch marker is written slowly, as storage under load can be.
      setItem: async (k, v) => {
        if (k === 'hush.first.v1') await slow;
        store.set(k, v);
      },
      removeItem: async (k) => void store.delete(k),
    },
    onAppState() {},
    device: () => ({ version: '1.0.0', build: '1', platform: 'ios', os: 'ios 18.6', device: 'iPhone17,1', locale: 'en-US' }),
    isDev: () => false,
  });
  hush.configure({ url: 'https://hush.test', key: 'hush_app_prod_x' });
  const first = hush.init(); // the root layout
  await settle(); // past reading storage
  let started;
  const second = hush.init().then(async () => {
    // A screen that awaited init() itself: the session must be there.
    await hush.flushNow();
    started = named('session_started').length;
  });
  await settle();
  release();
  await Promise.all([first, second]);
  assert.equal(started, 1);
});

test('forget() with a send in flight: nothing of the old install lands after the delete, nothing new is dropped', async () => {
  // A server that deletes on /v1/forget, and one slow /v1/events request.
  const server = [];
  let slow = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body) : null;
    if (path === '/v1/events' && slow) {
      slow = false;
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    }
    if (path === '/v1/forget') server.splice(0, server.length, ...server.filter((e) => e.install !== body.install));
    if (path === '/v1/events') server.push(...body.events);
    return { ok: true, status: 200, json: async () => ({ accepted: body?.events?.length ?? 0, duplicate: 0, rejected: 0 }) };
  };
  const sdk = await launch();
  await advance(6000); // the session start goes out
  const old = sdk.installationId();
  sdk.track('journal_written');
  slow = true;
  mock.timers.tick(3000); // the send soon after: it is slow
  assert.deepEqual(await sdk.forget(), { ok: true });
  sdk.track('settings_viewed');
  for (let i = 0; i < 3; i++) await settle();
  await sdk.flushNow();
  assert.deepEqual(server.filter((e) => e.install === old).map((e) => e.name), [], 'no batch of the old install lands after the delete');
  assert.deepEqual(server.map((e) => e.name).sort(), ['session_started', 'settings_viewed'], 'the new identity loses nothing');
});

test('a send removes what it sent by id: events queued while it was out stay queued', async () => {
  let slow = false;
  const recording = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (slow && new URL(url).pathname === '/v1/events') {
      slow = false;
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    }
    return recording(url, init);
  };
  const sdk = await launch();
  await advance(6000);
  sdk.track('journal_written');
  slow = true;
  mock.timers.tick(3000); // the send soon after: it is slow
  sdk.optOut(); // the user changes their mind twice while it is out, which replaces the queue
  sdk.optIn();
  sdk.track('settings_viewed');
  for (let i = 0; i < 3; i++) await settle();
  await sdk.flushNow();
  assert.equal(named('settings_viewed').length, 1);
});

test("the user's choice made before init() has read storage is the one that holds", async () => {
  let sdk = await launch();
  sdk.optOut();
  sdk = await load();
  sdk.optIn(); // the app applies a newer choice at startup
  await sdk.init();
  assert.equal(sdk.isOptedOut(), false);
  sdk = await launch();
  assert.equal(sdk.isOptedOut(), false, 'and it is remembered');

  sdk = await load();
  const ready = sdk.init();
  sdk.optOut(); // while init() is still reading
  await ready;
  sent = [];
  sdk.track('journal_written');
  await sdk.flushNow();
  assert.equal(sdk.isOptedOut(), true);
  assert.equal(events().length, 0);
  assert.ok(!h.storage.get('hush.queue.v1')?.includes('session_started'), 'nothing from before the choice is kept on disk');
});

test('a prop that is not a flat value is dropped on the device and never wedges the queue', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const sdk = await launch({ logLevel: 'error' });
    const press = { type: 'press' };
    press.target = { press }; // circular, like a press event
    sdk.track('card_tapped', { e: press });
    sdk.track('list_viewed', { ids: [1, 2] });
    sdk.setGlobalProps({ nav: press, theme: 'dark' });
    sdk.track('habit_checked');
    await assert.doesNotReject(advance(1500)); // the save timer
    await sdk.flushNow();
    assert.deepEqual(named('habit_checked').map((e) => e.props), [{ theme: 'dark' }]);
    assert.equal(named('card_tapped').length + named('list_viewed').length, 0);
    const said = warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
    assert.match(said, /event "card_tapped" prop "e" is not a string, number, boolean or null .*: dropped/);
    assert.match(said, /global prop "nav" .*: not set/);
  } finally {
    warn.mock.restore();
  }
});

test('a send that succeeds is on disk at once, so a process killed right after does not send it again', async () => {
  let sdk = await launch();
  await advance(5000);
  sdk.track('habit_checked');
  await advance(1200);
  await appState('background'); // the leaving send succeeds; iOS suspends the app, then kills it
  await settle();
  const delivered = new Set(events().map((e) => e.id));
  assert.ok(named('habit_checked').length === 1);
  sent = [];
  sdk = await launch();
  await sdk.flushNow();
  assert.deepEqual(events().filter((e) => delivered.has(e.id)).map((e) => e.name), []);
});

test('a Date prop is sent as its ISO string, as JSON writes it, and the event is kept', async () => {
  const sdk = await launch();
  const time = new Date('2026-10-01T08:00:00Z');
  sdk.track('reminder_set', { time, kind: 'daily' });
  time.setUTCHours(9); // the event keeps the value it was tracked with
  sdk.setGlobalProps({ installed_on: new Date('2026-09-01T00:00:00Z') });
  sdk.track('habit_checked');
  await sdk.flushNow();
  assert.deepEqual(named('reminder_set')[0].props, { time: '2026-10-01T08:00:00.000Z', kind: 'daily' });
  assert.equal(named('habit_checked')[0].props.installed_on, '2026-09-01T00:00:00.000Z');
});

test('a saved value that cannot be read or parsed starts over empty, and telemetry stays on', async () => {
  await launch();
  // Writes cut short: the next launch must not stay off because of them.
  h.storage.set('hush.queue.v1', '[{"id":"trunc');
  h.storage.set('hush.once.v1', '{');
  h.storage.set('hush.sessions.v1', '{"n":');
  sent = [];
  let sdk = await launch();
  sdk.track('habit_checked');
  await sdk.flushNow();
  assert.equal(named('habit_checked').length, 1);
  assert.ok(Array.isArray(JSON.parse(h.storage.get('hush.queue.v1'))), 'the queue on disk is replaced');
  assert.ok(Array.isArray(JSON.parse(h.storage.get('hush.once.v1'))));

  // A queue too big to read (Android rejects a row over its CursorWindow).
  h.storage.get = function (k) {
    if (k === 'hush.queue.v1') throw new Error('Row too big to fit into CursorWindow');
    return Map.prototype.get.call(this, k);
  };
  try {
    sent = [];
    sdk = await launch();
    sdk.track('habit_checked');
    await sdk.flushNow();
    assert.equal(named('habit_checked').length, 1);
    await sdk.createTicket({ kind: 'issue', message: 'It froze' });
    assert.ok(sent.find((r) => r.path === '/v1/tickets').body.install, 'feedback has the install id');
  } finally {
    delete h.storage.get;
  }
});

test('forget() holds every send until the server has answered, and a second tap gets the first answer', async () => {
  const waiting = [];
  const recording = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname === '/v1/forget') await new Promise((r) => waiting.push(r));
    return recording(url, init);
  };
  const sdk = await launch();
  await advance(6000);
  sent = [];
  sdk.track('journal_written');
  const first = sdk.forget();
  const second = sdk.forget();
  await advance(31_000); // past the send soon after and the 30 s interval
  assert.deepEqual(sent, [], 'nothing goes out while the delete is pending');
  for (const release of waiting.splice(0)) release();
  await settle();
  for (const release of waiting.splice(0)) release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(await second, await first);
  assert.equal(sent.filter((r) => r.path === '/v1/forget').length, 1, 'one request');
});

test("an opt-out while init() is reading keeps the last launch's unsent queue out, on the wire and on disk", async () => {
  status = 503; // the last launch never got through
  let sdk = await launch();
  sdk.track('journal_written');
  await appState('background');
  await settle();
  const stored = JSON.parse(h.storage.get('hush.queue.v1')).map((e) => e.id);
  assert.ok(stored.length > 0);
  status = 200;
  sent = [];
  sdk = await load();
  const ready = sdk.init();
  sdk.optOut(); // after init() has read the queue, before it is done
  await ready;
  await advance(1500);
  assert.ok(!stored.some((id) => (h.storage.get('hush.queue.v1') ?? '').includes(id)), 'not written back');
  sdk.optIn();
  await sdk.flushNow();
  assert.deepEqual(events().filter((e) => stored.includes(e.id)), [], 'nor sent after optIn()');
});

test('the first entry held for a session wins, as it does on a session', async () => {
  const sdk = await load();
  sdk.entry('widget');
  sdk.entry('link', { url: 'https://braele.app/?utm_source=meta' }); // a second report of the same launch
  await sdk.init();
  await sdk.flushNow();
  assert.deepEqual(named('session_started')[0].props, { entry: 'widget', n: 1 });
});

test('the queue is on disk as the app leaves, before the send that may never finish', async () => {
  status = 503;
  const sdk = await launch();
  sdk.track('journal_written');
  await appState('background');
  // No timer has run: the 1 s save would be too late for a process suspended now.
  assert.match(h.storage.get('hush.queue.v1') ?? '', /journal_written/);
});

test("init() saves the merged queue at once: the last launch's events and this one's early ones", async () => {
  status = 503;
  let sdk = await launch();
  sdk.track('habit_checked');
  await appState('background');
  await settle();
  const stored = JSON.parse(h.storage.get('hush.queue.v1')).map((e) => e.id);
  sdk = await load();
  sdk.track('early_event');
  await sdk.init();
  await settle();
  // No timer has run, and the failed send saved nothing.
  const onDisk = JSON.parse(h.storage.get('hush.queue.v1'));
  assert.deepEqual(onDisk.slice(0, stored.length).map((e) => e.id), stored);
  assert.equal(onDisk.at(-1).name, 'early_event');
});

test('flushNow() with a send in flight waits for it, then sends what is queued now', async () => {
  let slow = false;
  const recording = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (slow && new URL(url).pathname === '/v1/events') {
      slow = false;
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    }
    return recording(url, init);
  };
  const sdk = await launch();
  await advance(6000);
  sdk.track('journal_written');
  slow = true;
  mock.timers.tick(3000); // the send soon after starts, and is slow
  sdk.track('settings_viewed');
  await sdk.flushNow();
  assert.equal(named('journal_written').length, 1);
  assert.equal(named('settings_viewed').length, 1, 'sent by the time flushNow() resolves');
});

test('a runInBackground that throws still sends as the app leaves', async () => {
  const sdk = await launch({
    runInBackground: () => {
      throw new Error('no background task');
    },
  });
  await advance(3000);
  sdk.track('journal_written');
  await assert.doesNotReject(appState('background'));
  await settle();
  assert.equal(named('journal_written').length, 1);
});

/**
 * A hush server for tickets, as 2.3.0 talks to it: a ticket without an
 * install gets a thread key, and the key reads, answers and forgets it.
 * `legacy`: a server from before that, which wants an install on every ticket.
 */
function ticketServer({ legacy = false } = {}) {
  const tickets = [];
  const calls = [];
  // Every thread key handed out, deleted or not.
  const minted = [];
  let next = 1;
  let offline = null;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    if (offline?.(u.pathname, body)) throw new Error('offline');
    calls.push({ method, path: u.pathname, query: u.search, body });
    sent.push({ path: u.pathname, body });
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    const view = ({ install: _i, thread: _t, ...t }) => t;
    if (u.pathname === '/v1/events') return reply(200, { accepted: body.events.length, duplicate: 0, rejected: 0 });
    if (u.pathname === '/v1/tickets' && method === 'POST') {
      if (legacy ? !body.install : !body.install && !body.email) return reply(400, { error: 'invalid install' });
      const id = String(next++);
      const t = {
        id, install: body.install ?? null, thread: body.install ? null : randomBytes(32).toString('base64url'),
        kind: body.kind, subject: body.subject ?? null, message: body.message, status: 'open',
        created_at: new Date(Date.now() + Number(id) * 1000).toISOString(), unread: false, replies: [],
      };
      tickets.push(t);
      if (t.thread) minted.push(t.thread);
      return reply(201, { id, created_at: t.created_at, status: 'open', ...(t.thread ? { thread: t.thread } : {}) });
    }
    if (u.pathname === '/v1/tickets') {
      const install = u.searchParams.get('install');
      return reply(200, { tickets: tickets.filter((t) => t.install === install).reverse().map(view) });
    }
    if (u.pathname === '/v1/tickets/threads') {
      if (legacy) return reply(404, { error: 'not found' });
      return reply(200, { tickets: tickets.filter((t) => t.thread && body.threads.includes(t.thread)).reverse().map(view) });
    }
    const m = /^\/v1\/tickets\/(\d+)\/reply$/.exec(u.pathname);
    if (m) {
      const t = tickets.find((x) => x.id === m[1] && (body.thread ? x.thread === body.thread : x.install === body.install));
      if (!t) return reply(404, { error: 'not found' });
      t.replies.push({ author: 'user', body: body.body, at: new Date().toISOString() });
      return reply(201, { id: '1', created_at: new Date().toISOString(), status: 'open' });
    }
    if (u.pathname === '/v1/forget') {
      const gone = tickets.filter((t) => (body.threads ? body.threads.includes(t.thread) : t.install === body.install));
      for (const t of gone) tickets.splice(tickets.indexOf(t), 1);
      return reply(200, { ok: true, deleted: body.threads ? { tickets: gone.length } : { events: 0, tickets: gone.length, installs: 1 } });
    }
    return reply(404, { error: 'not found' });
  };
  // The requests that carried the install id and a thread key together: there must be none.
  const together = (installId) =>
    calls.filter((c) => {
      const text = `${c.query} ${JSON.stringify(c.body)}`;
      return text.includes(installId) && minted.some((k) => text.includes(k));
    });
  return { tickets, calls, together, goOffline: (when) => (offline = when) };
}
const storedThreads = () => JSON.parse(h.storage.get('hush.threads.v1') ?? '{}');

test('a ticket with an email goes without the install id or RevenueCat id, tracks nothing, and keeps its thread key', async () => {
  const server = ticketServer();
  const sdk = await launch();
  sdk.identify({ rcId: '$RCAnonymousID:abc', pro: true });
  const r = await sdk.createTicket({ kind: 'issue', message: 'It froze', email: 'sam@example.com', subject: 'Timer' });
  assert.deepEqual(r, { ok: true, id: '1' });
  const call = server.calls.find((c) => c.path === '/v1/tickets');
  assert.deepEqual(Object.keys(call.body).sort(), ['diag', 'email', 'kind', 'message', 'subject']);
  assert.deepEqual(call.body.diag, { version: '1.2.3', build: '45', os: 'ios 18.6', device: 'iPhone17,1', pro: true }, 'the build, not the person');
  assert.deepEqual(storedThreads(), { 1: server.tickets[0].thread });
  await sdk.flushNow();
  assert.equal(named('ticket_opened').length, 0, 'no event marks the moment');
  assert.ok(server.calls.some((c) => c.path === '/v1/events'), 'events went out meanwhile');
  assert.deepEqual(server.together(sdk.installationId()), []);
});

test('without an email nothing changes: the install id and RevenueCat id go with the ticket, and ticket_opened is tracked', async () => {
  const server = ticketServer();
  const sdk = await launch();
  sdk.identify({ rcId: '$RCAnonymousID:abc' });
  const r = await sdk.createTicket({ kind: 'feature', message: 'Dark mode please' });
  assert.equal(r.ok, true);
  const call = server.calls.find((c) => c.path === '/v1/tickets');
  assert.equal(call.body.install, sdk.installationId());
  assert.equal(call.body.rc_id, '$RCAnonymousID:abc');
  assert.ok(!('email' in call.body));
  assert.equal(h.storage.has('hush.threads.v1'), false);
  await sdk.flushNow();
  assert.deepEqual(named('ticket_opened').map((e) => e.props), [{ kind: 'feature' }]);
});

test('listTickets: the install\'s tickets and the ones sent with an email, newest first, in two requests, across launches', async () => {
  const server = ticketServer();
  let sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'one, by install' });
  await sdk.createTicket({ kind: 'issue', message: 'two, with an email', email: 'sam@example.com' });
  await sdk.createTicket({ kind: 'love', message: 'three, by install' });
  server.calls.length = 0;
  const list = await sdk.listTickets();
  assert.deepEqual(list.map((t) => t.message), ['three, by install', 'two, with an email', 'one, by install']);
  assert.ok(list.every((t) => !('thread' in t) && !('install' in t)), 'the Ticket type gains no identifier');
  const [byInstall, byThread] = [server.calls.find((c) => c.method === 'GET'), server.calls.find((c) => c.path === '/v1/tickets/threads')];
  assert.equal(byInstall.query, `?install=${sdk.installationId()}`);
  assert.deepEqual(byThread.body, { threads: [server.tickets[1].thread] });
  assert.deepEqual(server.together(sdk.installationId()), []);

  sdk = await launch(); // the keys are on the device
  assert.equal((await sdk.listTickets()).length, 3);
});

test('without stored thread keys listTickets makes the one request it always made', async () => {
  const server = ticketServer();
  const sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'by install' });
  server.calls.length = 0;
  assert.equal((await sdk.listTickets()).length, 1);
  assert.deepEqual(server.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/tickets']);
});

test('replyToTicket: by the thread key on a ticket sent with an email, with no ticket_replied; by the install otherwise', async () => {
  const server = ticketServer();
  const sdk = await launch();
  const keyed = await sdk.createTicket({ kind: 'issue', message: 'with an email', email: 'sam@example.com' });
  const own = await sdk.createTicket({ kind: 'issue', message: 'by install' });
  server.calls.length = 0;
  assert.deepEqual(await sdk.replyToTicket(keyed.id, 'Still frozen'), { ok: true });
  assert.deepEqual(server.calls.at(-1).body, { thread: server.tickets[0].thread, body: 'Still frozen' });
  assert.deepEqual(await sdk.replyToTicket(own.id, 'Thanks'), { ok: true });
  assert.deepEqual(server.calls.at(-1).body, { install: sdk.installationId(), body: 'Thanks' });
  await sdk.flushNow();
  assert.equal(named('ticket_replied').length, 1, 'only the reply by install');
  assert.deepEqual(server.together(sdk.installationId()), []);
  assert.deepEqual(await sdk.replyToTicket('constructor', 'x'), { ok: false, error: 'failed' }, 'an id that is not a ticket finds no key');
});

test('forget(): the tickets sent with an email go by their keys in a request of their own, then the install', async () => {
  const server = ticketServer();
  const sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'with an email', email: 'sam@example.com' });
  await sdk.createTicket({ kind: 'issue', message: 'by install' });
  const before = sdk.installationId();
  const key = server.tickets[0].thread;
  server.calls.length = 0;
  assert.deepEqual(await sdk.forget(), { ok: true });
  const forgets = server.calls.filter((c) => c.path === '/v1/forget').map((c) => c.body);
  assert.deepEqual(forgets, [{ threads: [key] }, { install: before }]);
  assert.deepEqual(server.tickets, [], 'both deleted on the server');
  assert.deepEqual(storedThreads(), {}, 'and the keys gone from the device');
  server.calls.length = 0;
  assert.deepEqual(await sdk.listTickets(), []);
  assert.ok(!server.calls.some((c) => c.path === '/v1/tickets/threads'));
});

test('forget() that fails on the install after the keys: those tickets stay deleted, and a retry finishes', async () => {
  const server = ticketServer();
  const sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'with an email', email: 'sam@example.com' });
  await sdk.createTicket({ kind: 'issue', message: 'by install' });
  const before = sdk.installationId();
  server.goOffline((path, body) => path === '/v1/forget' && 'install' in body);
  assert.deepEqual(await sdk.forget(), { ok: false, error: 'offline' });
  assert.equal(sdk.installationId(), before);
  assert.deepEqual(server.tickets.map((t) => t.message), ['by install'], 'the one with an email is gone already');
  assert.deepEqual(storedThreads(), {});
  server.goOffline(null);
  assert.deepEqual(await sdk.forget(), { ok: true });
  assert.deepEqual(server.tickets, []);
});

test('forget() offline on the keys changes nothing: the install id and the keys stay', async () => {
  const server = ticketServer();
  const sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'with an email', email: 'sam@example.com' });
  const before = sdk.installationId();
  server.goOffline((path) => path === '/v1/forget');
  assert.deepEqual(await sdk.forget(), { ok: false, error: 'offline' });
  assert.equal(sdk.installationId(), before);
  assert.equal(Object.keys(storedThreads()).length, 1);
  assert.equal(server.tickets.length, 1);
});

test('optOut() leaves feedback alone: the keys stay, and tickets still list and send', async () => {
  ticketServer();
  const sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'with an email', email: 'sam@example.com' });
  sdk.optOut();
  assert.equal(Object.keys(storedThreads()).length, 1);
  assert.equal((await sdk.listTickets()).length, 1);
  assert.equal((await sdk.createTicket({ kind: 'love', message: 'still here', email: 'sam@example.com' })).ok, true);
  assert.equal(Object.keys(storedThreads()).length, 2);
});

test('an older server refuses a ticket without an install: failed, and the SDK does not send the install instead', async () => {
  const server = ticketServer({ legacy: true });
  const sdk = await launch();
  assert.deepEqual(await sdk.createTicket({ kind: 'issue', message: 'with an email', email: 'sam@example.com' }), { ok: false, error: 'failed' });
  const tries = server.calls.filter((c) => c.path === '/v1/tickets');
  assert.equal(tries.length, 1);
  assert.ok(!('install' in tries[0].body));
  assert.equal(server.tickets.length, 0);
  assert.equal(h.storage.has('hush.threads.v1'), false);
  assert.equal((await sdk.createTicket({ kind: 'issue', message: 'without an email' })).ok, true, 'without an email it works as before');
});

test('saved thread keys that cannot be read start over empty; malformed entries are dropped', async () => {
  const server = ticketServer();
  h.storage.set('hush.threads.v1', '{"1":');
  let sdk = await launch();
  assert.equal((await sdk.createTicket({ kind: 'issue', message: 'with an email', email: 'sam@example.com' })).ok, true);
  assert.deepEqual(storedThreads(), { 1: server.tickets[0].thread }, 'the unreadable value is replaced');

  h.storage.set('hush.threads.v1', JSON.stringify({ 1: server.tickets[0].thread, 2: 'short', x: server.tickets[0].thread, 3: 42 }));
  sdk = await launch();
  server.calls.length = 0;
  assert.equal((await sdk.listTickets()).length, 1);
  assert.deepEqual(server.calls.find((c) => c.path === '/v1/tickets/threads').body, { threads: [server.tickets[0].thread] });
});

test('thread keys that cannot be read this time are not taken for none: nothing is written over them, and forget() fails', async () => {
  const server = ticketServer();
  let sdk = await launch();
  await sdk.createTicket({ kind: 'issue', message: 'first', email: 'sam@example.com' });
  const first = server.tickets[0].thread;

  sdk = await launch();
  h.failReads['hush.threads.v1'] = 1;
  assert.equal((await sdk.createTicket({ kind: 'issue', message: 'second', email: 'sam@example.com' })).ok, true);
  assert.deepEqual(storedThreads(), { 1: first }, 'the stored key is not written over');
  const second = server.tickets[1].thread;
  assert.deepEqual(await sdk.replyToTicket('2', 'and more'), { ok: true }, 'the new key is held in memory meanwhile');
  assert.deepEqual(server.calls.at(-1).body, { thread: second, body: 'and more' });

  // The next read works: both tickets list, and the new key is saved with the first.
  assert.deepEqual((await sdk.listTickets()).map((t) => t.message), ['second', 'first']);
  await settle();
  assert.deepEqual(storedThreads(), { 1: first, 2: second });

  const before = sdk.installationId();
  h.failReads['hush.threads.v1'] = 1;
  assert.deepEqual(await sdk.forget(), { ok: false, error: 'failed' }, 'not done while keys may be stored');
  assert.equal(sdk.installationId(), before);
  assert.equal(server.tickets.length, 2);
  assert.deepEqual(await sdk.forget(), { ok: true });
  assert.deepEqual(server.tickets, []);
  assert.deepEqual(storedThreads(), {});
});

test('two writers on one storage (two tabs on the web) keep each other\'s keys', async () => {
  const server = ticketServer();
  const tabA = await launch();
  const tabB = await launch();
  await tabA.createTicket({ kind: 'issue', message: 'from A', email: 'sam@example.com' });
  await tabB.createTicket({ kind: 'issue', message: 'from B', email: 'sam@example.com' });
  await tabA.createTicket({ kind: 'issue', message: 'from A again', email: 'sam@example.com' });
  assert.deepEqual(Object.keys(storedThreads()).sort(), ['1', '2', '3']);
  assert.equal(server.tickets.length, 3);
  assert.equal((await tabB.listTickets()).length, 3);
});
