// @bavrk/hush-expo's JavaScript: what the app gets from it with the native
// module present (mocked), and without it (Android, web, Expo Go, an update
// onto an older build), plus the config plugin's Info.plist keys.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { register } from 'node:module';
import { afterEach, beforeEach, mock, test } from 'node:test';

register('./sdk/hooks.mjs', import.meta.url);
const require = createRequire(import.meta.url);
let n = 0;
const load = () => import(`../expo/src/index.ts?n=${++n}`);

let calls;
beforeEach(() => {
  calls = [];
  delete globalThis.__hushExpoNative;
  // The SDK's send timers must not keep the test process alive.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
afterEach(() => mock.timers.reset());
const native = (distribution, overrides = {}) => {
  globalThis.__hushExpoNative = {
    distribution,
    updateConversionValue: async (fine, coarse, lock) => void calls.push(['cv', fine, coarse, lock]),
    beginBackgroundTask: async () => (calls.push(['begin']), 7),
    endBackgroundTask: async (id) => void calls.push(['end', id]),
    ...overrides,
  };
};

test('the channel is TestFlight or the App Store as iOS says; nothing for development builds and the simulator', async () => {
  for (const [d, want] of [['testflight', 'testflight'], ['app_store', 'app_store'], ['development', undefined], ['simulator', undefined]]) {
    native(d);
    const m = await load();
    assert.equal(m.channel(), want, d);
    assert.equal(m.distribution(), d);
  }
});

test('the attribution bridge passes the value through, fine, coarse and lock', async () => {
  native('app_store');
  const m = await load();
  await m.attribution.update({ fine: 63, coarse: 'high', lock: true });
  assert.deepEqual(calls, [['cv', 63, 'high', true]]);
});

test('runInBackground wraps the work in a background task, and ends it even when the work fails', async () => {
  native('app_store');
  const m = await load();
  await m.runInBackground(async () => void calls.push(['work']));
  assert.deepEqual(calls, [['begin'], ['work'], ['end', 7]]);
  calls = [];
  await assert.rejects(m.runInBackground(async () => {
    throw new Error('offline');
  }));
  assert.deepEqual(calls, [['begin'], ['end', 7]]);
});

test('an OS that refuses background time still runs the work, and nothing is ended', async () => {
  native('app_store', { beginBackgroundTask: async () => -1 });
  const m = await load();
  await m.runInBackground(async () => void calls.push(['work']));
  assert.deepEqual(calls, [['work']]);
});

test('without the native module every function is a quiet no-op', async () => {
  const m = await load();
  assert.equal(m.distribution(), null);
  assert.equal(m.channel(), undefined);
  await m.attribution.update({ fine: 5, coarse: 'low', lock: false });
  let ran = false;
  await m.runInBackground(async () => void (ran = true));
  assert.equal(ran, true);
});

test('with the SDK: registered at 0, then milestones, through the real bridge', async () => {
  native('testflight');
  const expo = await load();
  const h = (globalThis.__hush ??= { storage: new Map(), listeners: [] });
  h.storage.clear();
  globalThis.fetch = async (url) =>
    new URL(url).pathname === '/v1/config'
      ? { ok: true, status: 200, json: async () => ({ conversion_values: [{ value: 6, coarse: 'medium', event: 'first_win', where: null, lock: false }] }) }
      : { ok: true, status: 200, json: async () => ({ accepted: 1, duplicate: 0, rejected: 0 }) };
  const sdk = await import(`../sdk/src/index.ts?expo=${n}`);
  sdk.configure({ url: 'https://hush.test', key: 'hush_app_prod_x', attribution: expo.attribution, channel: expo.channel() });
  await sdk.init();
  sdk.track('first_win');
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.filter((c) => c[0] === 'cv'), [['cv', 0, 'low', false], ['cv', 6, 'medium', false]]);
});

test('the config plugin writes both Info.plist keys, keeps what else AdAttributionKit has, and refuses a path', () => {
  const { applyEndpoint } = require('../expo/app.plugin.js');
  const plist = applyEndpoint({ AdAttributionKit: { OptInForReengagementPostbackCopies: true } }, 'https://bavrk.com');
  assert.deepEqual(plist, {
    NSAdvertisingAttributionReportEndpoint: 'https://bavrk.com',
    AdAttributionKit: { OptInForReengagementPostbackCopies: true, AttributionCopyEndpoint: 'https://bavrk.com' },
  });
  assert.throws(() => applyEndpoint({}, 'https://bavrk.com/.well-known/'), /nothing after it/);
  assert.throws(() => applyEndpoint({}, 'http://bavrk.com'), /https/);
  const withHushExpo = require('../expo/app.plugin.js');
  const config = { name: 'x' };
  assert.equal(withHushExpo(config, {}), config, 'no endpoint, no change');
});
