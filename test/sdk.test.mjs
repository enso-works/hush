// The SDK (sdk/src/index.ts), run as it is under Node: its React Native and
// Expo imports resolve to mocks (test/sdk/), fetch is recorded, and the clock
// is Node's mock timers. Each test loads a fresh copy of the module, the way
// each app launch starts with fresh memory and the same storage.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { beforeEach, mock, test } from 'node:test';

register('./sdk/hooks.mjs', import.meta.url);

const h = (globalThis.__hush ??= { storage: new Map(), listeners: [] });
let sent;
let launches = 0;
let status = 200;

beforeEach(() => {
  h.storage.clear();
  h.listeners.length = 0;
  sent = [];
  status = 200;
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-09-30T10:00:00Z') });
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    sent.push({ path: new URL(url).pathname, body });
    const n = body?.events?.length ?? 0;
    return { ok: status < 300, status, json: async () => ({ ok: true, accepted: n, duplicate: 0, rejected: 0 }) };
  };
});

/** A fresh launch: a new module instance, configured and initialised. */
async function launch(config = {}) {
  h.listeners.length = 0;
  const sdk = await import(`../sdk/src/index.ts?launch=${++launches}`);
  sdk.configure({ url: 'https://hush.test', key: 'hush_app_prod_x', ...config });
  await sdk.init();
  await settle(); // init() starts its first send without waiting for it
  return sdk;
}
// setImmediate is not among the mocked timers, so this lets pending I/O finish.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const events = () => sent.filter((r) => r.path === '/v1/events').flatMap((r) => r.body.events);
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
  sdk.entry('link', { url: 'myapp://open/item/42?utm_source=newsletter&utm_campaign=autumn%20update&token=secret&ref=site#x' });
  await sdk.flushNow();
  assert.deepEqual(named('session_started')[0].props, { entry: 'link', n: 1, utm_source: 'newsletter', utm_campaign: 'autumn update', ref: 'site' });
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
