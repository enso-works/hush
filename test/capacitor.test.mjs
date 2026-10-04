// @bavrk/hush-capacitor's JavaScript: what the app gets from it with the
// native plugin present on iOS (Capacitor's bridge mocked), and without it
// (the web, Android, a web build onto an older binary).
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, beforeEach, mock, test } from 'node:test';

register('./sdk/hooks.mjs', import.meta.url);
let n = 0;
const load = () => import(`../capacitor/src/index.ts?n=${++n}`);

let calls;
beforeEach(() => {
  calls = [];
  delete globalThis.__hushCapacitor;
  // The SDK's send timers must not keep the test process alive.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
afterEach(() => mock.timers.reset());
const bridge = (platform, distribution, overrides = {}) => {
  globalThis.__hushCapacitor = {
    platform,
    plugins: {
      HushCapacitor: {
        distribution: async () => (calls.push(['distribution']), { value: distribution }),
        updateConversionValue: async ({ fine, coarse, lock }) => void calls.push(['cv', fine, coarse, lock]),
        beginBackgroundTask: async () => (calls.push(['begin']), { id: 7 }),
        endBackgroundTask: async ({ id }) => void calls.push(['end', id]),
        ...overrides,
      },
    },
  };
};

test('the channel is TestFlight or the App Store as iOS says; nothing for development builds and the simulator', async () => {
  for (const [d, want] of [['testflight', 'testflight'], ['app_store', 'app_store'], ['development', undefined], ['simulator', undefined]]) {
    bridge('ios', d);
    const m = await load();
    assert.equal(await m.channel(), want, d);
    assert.equal(await m.distribution(), d);
  }
});

test('the distribution crosses the bridge once per launch', async () => {
  bridge('ios', 'testflight');
  const m = await load();
  await Promise.all([m.channel(), m.distribution(), m.channel()]);
  assert.deepEqual(calls, [['distribution']]);
});

test('a distribution the bridge fails or does not know is null', async () => {
  bridge('ios', 'testflight', { distribution: async () => Promise.reject(new Error('bridge')) });
  assert.equal(await (await load()).distribution(), null);
  bridge('ios', 'enterprise');
  const m = await load();
  assert.equal(await m.distribution(), null);
  assert.equal(await m.channel(), undefined);
});

test('the attribution bridge passes the value through, fine, coarse and lock', async () => {
  bridge('ios', 'app_store');
  const m = await load();
  await m.attribution.update({ fine: 63, coarse: 'high', lock: true });
  assert.deepEqual(calls, [['cv', 63, 'high', true]]);
});

test("the attribution bridge lets the plugin's refusal through, as hush-expo does: the SDK keeps the value to retry", async () => {
  bridge('ios', 'app_store', { updateConversionValue: async () => Promise.reject(new Error('neither framework took it')) });
  const m = await load();
  await assert.rejects(m.attribution.update({ fine: 1, coarse: 'low', lock: false }), /neither/);
});

test('runInBackground wraps the work in a background task, and ends it even when the work fails', async () => {
  bridge('ios', 'app_store');
  const m = await load();
  await m.runInBackground(async () => void calls.push(['work']));
  assert.deepEqual(calls, [['begin'], ['work'], ['end', 7]]);
  calls = [];
  await assert.rejects(
    m.runInBackground(async () => {
      throw new Error('offline');
    }),
    /offline/,
  );
  assert.deepEqual(calls, [['begin'], ['end', 7]]);
});

test('an OS that refuses background time, or a bridge that fails, still runs the work, and nothing is ended', async () => {
  for (const begin of [async () => ({ id: -1 }), async () => Promise.reject(new Error('bridge'))]) {
    calls = [];
    bridge('ios', 'app_store', { beginBackgroundTask: begin });
    const m = await load();
    await m.runInBackground(async () => void calls.push(['work']));
    assert.deepEqual(calls, [['work']]);
  }
});

test('an end the bridge fails is not the caller’s error', async () => {
  bridge('ios', 'app_store', { endBackgroundTask: async () => Promise.reject(new Error('bridge')) });
  const m = await load();
  await m.runInBackground(async () => void calls.push(['work']));
  assert.deepEqual(calls, [['begin'], ['work']]);
});

test('without the plugin, on the web and on Android every function is a quiet no-op that never calls the bridge', async () => {
  const cases = {
    'no bridge at all': () => delete globalThis.__hushCapacitor,
    'iOS without the plugin': () => (globalThis.__hushCapacitor = { platform: 'ios', plugins: {} }),
    android: () => bridge('android', 'app_store'),
    web: () => bridge('web', 'app_store'),
  };
  for (const [name, setUp] of Object.entries(cases)) {
    calls = [];
    setUp();
    const m = await load();
    assert.equal(await m.distribution(), null, name);
    assert.equal(await m.channel(), undefined, name);
    await m.attribution.update({ fine: 5, coarse: 'low', lock: false });
    let ran = false;
    await m.runInBackground(async () => void (ran = true));
    assert.equal(ran, true, name);
    assert.deepEqual(calls, [], name);
  }
});

test('with the web SDK: configured at once and again with the channel before init(), then registered at 0 and milestones, through the real bridge', async () => {
  bridge('ios', 'testflight');
  const cap = await load();
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname === '/v1/config') {
      return { ok: true, status: 200, json: async () => ({ conversion_values: [{ value: 6, coarse: 'medium', event: 'first_win', where: null, lock: false }] }) };
    }
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ accepted: 1, duplicate: 0, rejected: 0 }) };
  };
  const { createWebHush } = await import(`../sdk/src/web.ts?capacitor=${n}`);
  const hush = createWebHush({ version: '1.0.0', platform: 'ios' });
  const config = { url: 'https://hush.test', key: 'hush_app_prod_x', attribution: cap.attribution, runInBackground: cap.runInBackground };
  // The README's pattern for an app that cannot await before configure().
  hush.configure({ ...config, channel: 'app_store' });
  hush.track('app_opened');
  hush.configure({ ...config, channel: (await cap.channel()) ?? 'app_store' });
  await hush.init();
  hush.track('first_win');
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.filter((c) => c[0] === 'cv'), [['cv', 0, 'low', false], ['cv', 6, 'medium', false]]);
  await hush.flushNow();
  assert.ok(sent.length > 0, 'a batch went out');
  assert.ok(sent.every((b) => b.context.channel === 'testflight'), 'every batch carries the channel set before init()');
  assert.ok(sent.flatMap((b) => b.events.map((e) => e.name)).includes('app_opened'), 'an event tracked between the two calls is kept');
});
