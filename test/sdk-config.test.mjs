// Remote config in the SDK (sdk/src/core.ts, through sdk/src/index.ts), run
// under Node as sdk.test.mjs runs it: React Native mocked (test/sdk/), the
// clock on Node's mock timers, and /v1/config answered by a small fake of the
// server here, which honours If-None-Match the way the real one does.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { beforeEach, mock, test } from 'node:test';

register('./sdk/hooks.mjs', import.meta.url);

const h = (globalThis.__hush ??= { storage: new Map(), listeners: [] });
let launches = 0;

const ONE = '11111111-1111-4111-8111-111111111111'; // bucket 19 for paywall_variant
const TWO = '22222222-2222-4222-8222-222222222222'; // bucket 71 for paywall_variant

const KEYS = {
  new_home: { type: 'bool', default: false, rules: [{ when: { channel: ['testflight'] }, rollout: 100, value: true }] },
  paywall_copy: { type: 'string', default: 'Start your free week', rules: [{ when: { language: ['de'] }, rollout: 100, value: 'Eine Woche gratis' }] },
  review_prompt_after: { type: 'number', default: 3, rules: [] },
  session_presets: { type: 'json', default: [3, 5, 10], rules: [] },
};
const answer = (keys = KEYS, revision = 'aaaaaaaaaaaaaaaa', conversion_values = []) => ({ conversion_values, config: { revision, keys } });

// The fake server: `body` is what a 200 carries; a request whose
// If-None-Match names its revision gets a 304. `mode` breaks it.
let server;
let configCalls;
let sent;

beforeEach(() => {
  h.storage.clear();
  h.failReads = {};
  h.listeners.length = 0;
  globalThis.__hushReact = [];
  sent = [];
  configCalls = [];
  server = { mode: 'ok', status: 200, body: answer(), honor304: true, pending: [] };
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-02T10:00:00Z') });
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/config') {
      const inm = init?.headers?.['If-None-Match'] ?? null;
      configCalls.push({ inm, at: Date.now(), signal: init?.signal ?? null, auth: init?.headers?.Authorization });
      return respond(inm);
    }
    const body = init?.body ? JSON.parse(init.body) : null;
    sent.push({ path, body });
    return { ok: true, status: 200, json: async () => ({ ok: true, accepted: body?.events?.length ?? 0, duplicate: 0, rejected: 0 }) };
  };
});

function reply(inm) {
  if (server.status !== 200) return { ok: false, status: server.status, json: async () => ({ error: 'nope' }) };
  if (server.mode === 'garbage') {
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    };
  }
  const rev = server.body?.config?.revision;
  if (server.honor304 && inm && typeof rev === 'string' && inm === `"${rev}"`) {
    return {
      ok: false,
      status: 304,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    };
  }
  const body = structuredClone(server.body);
  return { ok: true, status: 200, json: async () => body };
}

function respond(inm) {
  if (server.mode === 'offline') return Promise.reject(new TypeError('Network request failed'));
  if (server.mode === 'hang') return new Promise(() => {});
  if (server.mode === 'held') return new Promise((resolve) => server.pending.push(() => resolve(reply(inm))));
  return Promise.resolve(reply(inm));
}
/** Answers the requests the fake server has been holding. */
const release = () => {
  for (const r of server.pending.splice(0)) r();
};

async function load(config = {}) {
  const now = Date.now();
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  h.listeners.length = 0;
  const sdk = await import(`../sdk/src/index.ts?config=${++launches}`);
  sdk.configure({ url: 'https://hush.test', key: 'hush_app_prod_x', ...config });
  return sdk;
}
async function launch(config = {}) {
  const sdk = await load(config);
  await sdk.init();
  await settle();
  return sdk;
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const advance = async (ms, step = 100) => {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    await settle();
  }
};
const appState = async (state) => {
  for (const fn of h.listeners) fn(state);
  await settle();
};
const stored = (key = 'hush.config.v1') => (h.storage.has(key) ? JSON.parse(h.storage.get(key)) : undefined);
const store = (value, key = 'hush.config.v1') => h.storage.set(key, typeof value === 'string' ? value : JSON.stringify(value));
/** console.warn and console.log, captured: the SDK's 'error' and 'debug' lines. */
function captureConsole() {
  const lines = [];
  const warn = mock.method(console, 'warn', (...a) => void lines.push(['error', a.join(' ')]));
  const info = mock.method(console, 'log', (...a) => void lines.push(['debug', a.join(' ')]));
  return {
    lines,
    restore() {
      warn.mock.restore();
      info.mock.restore();
    },
  };
}
const values = (c) => ({
  new_home: c.bool('new_home', null),
  paywall_copy: c.string('paywall_copy', null),
  review_prompt_after: c.number('review_prompt_after', null),
  session_presets: c.json('session_presets', null),
});
const FALLBACKS = { new_home: null, paywall_copy: null, review_prompt_after: null, session_presets: null };
const SERVED = { new_home: false, paywall_copy: 'Start your free week', review_prompt_after: 3, session_presets: [3, 5, 10] };

test('getters return their fallbacks before init(); a stored config gives values right after init(), while the fetch hangs', async () => {
  let sdk = await load();
  assert.deepEqual(values(sdk.config), FALLBACKS);
  assert.equal(sdk.config.revision(), null);

  store({ revision: 'aaaaaaaaaaaaaaaa', keys: KEYS });
  server.mode = 'hang';
  sdk = await launch();
  assert.deepEqual(values(sdk.config), SERVED);
  assert.equal(sdk.config.revision(), 'aaaaaaaaaaaaaaaa');
  assert.equal(configCalls.length, 1, 'the request is out');
  await sdk.config.ready(); // satisfied by the cache, at once
});

test('first launch: ready() waits for the fetch, values follow, and the cache is written under the prefix', async () => {
  server.mode = 'held';
  const sdk = await load();
  let done = false;
  const ready = sdk.config.ready().then(() => (done = true));
  await settle();
  assert.equal(done, false, 'nothing cached: ready() waits for the first answer');
  assert.deepEqual(values(sdk.config), FALLBACKS);
  release();
  await ready;
  assert.deepEqual(values(sdk.config), SERVED);
  assert.deepEqual(stored(), { revision: 'aaaaaaaaaaaaaaaa', keys: KEYS });
  assert.equal(configCalls[0].auth, 'Key hush_app_prod_x');
  assert.equal(configCalls[0].inm, null);

  h.storage.clear();
  server.mode = 'ok';
  const other = await launch({ storagePrefix: 'braele' });
  await other.config.ready();
  assert.deepEqual(stored('braele.config.v1'), { revision: 'aaaaaaaaaaaaaaaa', keys: KEYS });
  assert.equal(stored('hush.config.v1'), undefined);
});

test('ready() with a fetch that hangs resolves at its timeout with fallbacks; values and onChange follow the answer', async () => {
  server.mode = 'held';
  const sdk = await load();
  const changes = [];
  sdk.config.onChange((keys) => changes.push(keys));
  let done = false;
  const ready = sdk.config.ready(500).then(() => (done = true));
  await advance(400);
  assert.equal(done, false);
  await advance(200);
  await ready;
  assert.deepEqual(values(sdk.config), FALLBACKS);
  release();
  await settle();
  assert.deepEqual(values(sdk.config), SERVED);
  assert.deepEqual(changes, [['new_home', 'paywall_copy', 'review_prompt_after', 'session_presets']]);
  await sdk.config.ready(); // satisfied now: at once
});

test('off: an empty key or remoteConfig false makes no request; ready() at once, fallbacks, refresh() says off', async () => {
  for (const config of [{ key: '' }, { remoteConfig: false }]) {
    h.storage.clear();
    store({ revision: 'aaaaaaaaaaaaaaaa', keys: KEYS }); // remoteConfig: false does not even read it
    configCalls = [];
    const sdk = await launch(config);
    await sdk.config.ready(); // no timers advanced: it must not wait
    assert.deepEqual(values(sdk.config), FALLBACKS);
    assert.deepEqual(await sdk.config.refresh(), { status: 'off', changed: [] });
    assert.equal(sdk.config.revision(), null);
    assert.deepEqual(sdk.config.snapshot(), []);
    sdk.identify({ pro: true });
    await settle();
    assert.equal(configCalls.length, 0, JSON.stringify(config));
    assert.deepEqual(stored(), { revision: 'aaaaaaaaaaaaaaaa', keys: KEYS }, 'the cache is neither read nor written');
  }
});

test('a type mismatch, an unknown type, a missing key, no usable value: the fallback and one line per key and reason', async () => {
  const out = captureConsole();
  try {
    server.mode = 'held';
    const sdk = await load({ logLevel: 'error' });
    void sdk.init();
    await settle();
    // Nothing loaded yet: fallbacks, no line.
    assert.equal(sdk.config.string('new_home', 'x'), 'x');
    assert.equal(sdk.config.bool('nothing_here', true), true);
    server.body = answer({
      ...KEYS,
      accent: { type: 'color', default: '#fff', rules: [] },
      broken: { type: 'number', default: 'three', rules: [{ when: { pro: true }, value: 4 }] },
    });
    release();
    await sdk.config.ready();
    for (let i = 0; i < 3; i++) {
      assert.equal(sdk.config.string('new_home', 'fb'), 'fb');
      assert.equal(sdk.config.string('accent', 'fb'), 'fb');
      assert.equal(sdk.config.number('nothing_here', 7), 7);
      assert.equal(sdk.config.number('broken', 8), 8);
      assert.equal(sdk.config.bool(42, true), true, 'a key that is not a string');
    }
    assert.deepEqual(out.lines, [
      ['error', '[hush] config "new_home" is a bool, read as string: using the fallback'],
      ['error', '[hush] config "accent" has type "color", which this SDK does not read: using the fallback'],
      ['error', `[hush] config "nothing_here" is not in the server's config: using the fallback`],
      ['error', '[hush] config "broken" has no usable value: using the fallback'],
    ]);
  } finally {
    out.restore();
  }
});

test('an older server: fallbacks and no lines; after a newer one, its cache stays until a 200 brings config again', async () => {
  const out = captureConsole();
  try {
    server.body = { conversion_values: [] };
    let sdk = await launch({ logLevel: 'debug' });
    await sdk.config.ready();
    assert.deepEqual(values(sdk.config), FALLBACKS);
    assert.deepEqual(stored(), { revision: null, keys: {} });
    assert.equal(sdk.config.revision(), null);
    assert.equal(
      out.lines.filter(([, l]) => l.includes('using the fallback')).length,
      0,
      'nothing to say about a server without remote config',
    );
    sdk = await launch({ logLevel: 'debug' });
    assert.equal(configCalls.length, 2);
    assert.equal(configCalls[1].inm, null, 'no revision to send');

    // The server is upgraded, then rolled back to a build from before remote config.
    server.body = answer({ ...KEYS, review_prompt_after: { type: 'number', default: 0, rules: [] } });
    await sdk.config.refresh();
    assert.equal(sdk.config.number('review_prompt_after', 9), 0, 'a kill switch set on the dashboard');
    server.body = { conversion_values: [] };
    out.lines.length = 0;
    const result = await sdk.config.refresh();
    assert.deepEqual(result, { status: 200, changed: [] });
    assert.equal(sdk.config.number('review_prompt_after', 9), 0, 'it must not turn back on');
    assert.equal(stored().revision, 'aaaaaaaaaaaaaaaa');
    await sdk.config.refresh();
    assert.equal(out.lines.filter(([level, l]) => level === 'debug' && l.includes('without config')).length, 1, 'said once');
    assert.equal(configCalls.at(-2).inm, '"aaaaaaaaaaaaaaaa"', 'sent before the rollback was seen');
    assert.equal(configCalls.at(-1).inm, null, 'not after it');

    server.body = answer({ ...KEYS, review_prompt_after: { type: 'number', default: 0, rules: [] } }, 'bbbbbbbbbbbbbbbb');
    await sdk.config.refresh();
    await sdk.config.refresh();
    assert.equal(configCalls.at(-1).inm, '"bbbbbbbbbbbbbbbb"', 'back once a 200 brings config');
  } finally {
    out.restore();
  }
});

test('If-None-Match carries the cached revision; a 304 and a 200 with the same revision change nothing', async () => {
  let sdk = await launch();
  await sdk.config.ready();
  sdk = await launch();
  const changes = [];
  sdk.config.onChange((keys) => changes.push(keys));
  await settle();
  assert.equal(configCalls[1].inm, '"aaaaaaaaaaaaaaaa"');
  assert.deepEqual(await sdk.config.refresh(), { status: 304, changed: [] });
  assert.deepEqual(values(sdk.config), SERVED);
  server.honor304 = false;
  assert.deepEqual(await sdk.config.refresh(), { status: 200, changed: [] });
  assert.deepEqual(changes, []);

  // A revision that is not a plain token is never put in a header.
  h.storage.clear();
  store({ revision: 'a"b\r\nX-Evil: 1', keys: KEYS });
  sdk = await launch();
  assert.equal(configCalls.at(-1).inm, null);
});

test('a new revision: onChange gets exactly the changed keys, sorted; unsubscribing works; a throwing listener does not stop the next', async () => {
  const sdk = await launch();
  await sdk.config.ready();
  const seen = [];
  const removed = [];
  sdk.config.onChange(() => {
    throw new Error('app bug');
  });
  sdk.config.onChange((keys) => seen.push(keys));
  const off = sdk.config.onChange((keys) => removed.push(keys));
  off();
  const { new_home: _gone, ...rest } = KEYS;
  server.body = answer(
    {
      ...rest,
      session_presets: { type: 'json', default: [3, 5, 10], rules: [] }, // equal: not a change
      review_prompt_after: { type: 'number', default: 5, rules: [] },
      onboarding_variant: { type: 'string', default: 'short', rules: [] },
    },
    'bbbbbbbbbbbbbbbb',
  );
  const result = await sdk.config.refresh();
  assert.deepEqual(result, { status: 200, changed: ['new_home', 'onboarding_variant', 'review_prompt_after'] });
  assert.deepEqual(seen, [['new_home', 'onboarding_variant', 'review_prompt_after']]);
  assert.deepEqual(removed, []);
  assert.equal(sdk.config.bool('new_home', true), true, 'a key that went: its fallback');
});

test('timing: "active" fetches only when refreshMinutes have passed, and the foreground interval too', async () => {
  const sdk = await launch();
  assert.equal(configCalls.length, 1, 'init() fetches');
  await appState('background');
  mock.timers.tick(5 * 60_000);
  await appState('active');
  assert.equal(configCalls.length, 1, 'five minutes: not due');
  await appState('background');
  mock.timers.tick(10 * 60_000);
  await appState('active');
  assert.equal(configCalls.length, 2, 'fifteen minutes: due');
  await appState('active');
  assert.equal(configCalls.length, 2);
  // While in the foreground, the 30 s interval fetches once it is due again.
  await advance(15 * 60_000 + 30_000, 30_000);
  assert.equal(configCalls.length, 3);
  void sdk;
});

test('timing: refreshMinutes is clamped to 1..1440, anything else is 15', async () => {
  for (const [option, minutes] of [[0, 1], [5000, 1440], ['x', 15], [Number.NaN, 15], [2.5, 2.5]]) {
    configCalls = [];
    h.storage.clear();
    await launch({ remoteConfig: { refreshMinutes: option } });
    await appState('background');
    mock.timers.tick(minutes * 60_000 - 1000);
    await appState('active');
    assert.equal(configCalls.length, 1, `${option}: not yet at ${minutes} minutes`);
    await appState('background');
    mock.timers.tick(1000);
    await appState('active');
    assert.equal(configCalls.length, 2, `${option}: due at ${minutes} minutes`);
  }
});

test('timing: offline at the first launch tries again after 1, 2, 4 minutes in the foreground, never past refreshMinutes; an answer resets it', async () => {
  server.mode = 'offline';
  const start = Date.now();
  const sdk = await launch({ remoteConfig: { refreshMinutes: 5 } });
  await sdk.config.ready();
  assert.deepEqual(values(sdk.config), FALLBACKS);
  await advance(13 * 60_000, 30_000);
  const at = () => configCalls.map((c) => (c.at - start) / 60_000);
  assert.deepEqual(at(), [0, 1, 3, 7, 12], 'then 8 is capped at 5');
  server.mode = 'ok';
  await advance(5 * 60_000, 30_000);
  assert.deepEqual(at(), [0, 1, 3, 7, 12, 17], 'an answer');
  await advance(6 * 60_000, 30_000);
  assert.deepEqual(at(), [0, 1, 3, 7, 12, 17, 22], 'refreshMinutes after a 200');
  server.status = 503;
  await advance(4 * 60_000, 30_000);
  assert.deepEqual(at().slice(7), [27, 28], 'a 5xx backs off from a minute again');
  await advance(2 * 60_000, 30_000);
  server.status = 401;
  await advance(4 * 60_000, 30_000);
  await advance(5 * 60_000, 30_000);
  assert.deepEqual(at().slice(7), [27, 28, 30, 34, 39], 'then 2, then 4; a 401 waits refreshMinutes');
});

test('"active" and the interval do nothing before init(); refresh() before init() waits for it and shares its request', async () => {
  store({ revision: 'aaaaaaaaaaaaaaaa', keys: KEYS });
  const sdk = await load();
  await appState('active');
  await advance(60_000, 30_000);
  assert.equal(configCalls.length, 0);
  const result = await sdk.config.refresh();
  assert.equal(configCalls.length, 1, 'one request: init()\'s');
  assert.equal(configCalls[0].inm, '"aaaaaaaaaaaaaaaa"', 'made after the stored config was read');
  assert.deepEqual(result, { status: 304, changed: [] });
});

test('failures keep the cache and the values: offline, 500, 401, a body that does not parse, a config without keys', async () => {
  const sdk = await launch();
  await sdk.config.ready();
  const before = stored();
  const changes = [];
  sdk.config.onChange((k) => changes.push(k));
  const cases = [
    ['offline', () => (server.mode = 'offline'), 'offline'],
    ['500', () => (server.status = 500), 500],
    ['401', () => (server.status = 401), 401],
    ['garbage', () => (server.mode = 'garbage'), 200],
    ['no keys', () => (server.body = { conversion_values: [], config: { revision: 'cccccccccccccccc' } }), 200],
    ['keys a list', () => (server.body = { conversion_values: [], config: { revision: 'cccccccccccccccc', keys: [] } }), 200],
    ['not an object', () => (server.body = [1, 2]), 200],
  ];
  for (const [name, breakIt, status] of cases) {
    server.mode = 'ok';
    server.status = 200;
    server.body = answer();
    breakIt();
    assert.deepEqual(await sdk.config.refresh(), { status, changed: [] }, name);
    assert.deepEqual(values(sdk.config), SERVED, name);
    assert.deepEqual(stored(), before, name);
  }
  assert.deepEqual(changes, []);

  // A request that never answers frees the slot after 15 s, and is aborted.
  server.mode = 'hang';
  server.status = 200;
  let result;
  void sdk.config.refresh().then((r) => (result = r));
  await advance(14_900);
  assert.equal(result, undefined);
  await advance(200);
  assert.deepEqual(result, { status: 'offline', changed: [] });
  assert.equal(configCalls.at(-1).signal?.aborted, true);
  const n = configCalls.length;
  server.mode = 'ok';
  await sdk.config.refresh();
  assert.equal(configCalls.length, n + 1, 'the next trigger makes a new request');
  assert.deepEqual(values(sdk.config), SERVED);
});

test('rollouts use the install id: buckets 19 and 71 under a 20% rule; snapshot() shows them', async () => {
  const keys = { paywall_variant: { type: 'string', default: 'a', rules: [{ rollout: 20, value: 'b' }] } };
  server.body = answer(keys);
  for (const [install, value, place] of [[ONE, 'b', 19], [TWO, 'a', 71]]) {
    h.storage.clear();
    h.storage.set('hush.install.v1', install);
    const sdk = await launch();
    await sdk.config.ready();
    assert.equal(sdk.config.string('paywall_variant', 'fallback'), value);
    assert.deepEqual(sdk.config.snapshot(), [{ key: 'paywall_variant', type: 'string', value, rule: value === 'b' ? 0 : -1, bucket: place }]);
  }
});

test('pro: identify() changes a pro rule and fires onChange; unknown matches neither side; the stored flag serves the next launch until forget()', async () => {
  const keys = {
    streak_freeze: { type: 'bool', default: false, rules: [{ when: { pro: true }, value: true }] },
    upsell: { type: 'bool', default: false, rules: [{ when: { pro: false }, value: true }] },
  };
  server.body = answer(keys);
  let sdk = await launch();
  await sdk.config.ready();
  assert.deepEqual([sdk.config.bool('streak_freeze', null), sdk.config.bool('upsell', null)], [false, false], 'unknown: neither');
  const changes = [];
  sdk.config.onChange((k) => changes.push(k));
  sdk.identify({ pro: true });
  assert.deepEqual(changes, [['streak_freeze']]);
  assert.equal(sdk.config.bool('streak_freeze', null), true);
  assert.equal(stored().pro, true, 'kept for the next launch');
  sdk.identify({ pro: true });
  assert.equal(changes.length, 1, 'no change, no call');
  sdk.identify({ pro: false });
  assert.deepEqual(changes.at(-1), ['streak_freeze', 'upsell']);
  sdk.identify({ pro: true });
  sdk.track('opened_x');
  await sdk.flushNow();
  assert.equal(sent.at(-1).body.context.pro, true);

  // The next launch: the stored flag before identify() runs; batches still leave pro out until then.
  server.mode = 'hang';
  sdk = await launch();
  assert.equal(sdk.config.bool('streak_freeze', null), true);
  sdk.track('opened_x');
  await sdk.flushNow();
  assert.equal(sent.at(-1).body.context.pro, undefined, 'the stored flag is for evaluation only');

  // forget() drops it.
  server.mode = 'ok';
  sdk = await launch();
  assert.equal((await sdk.forget()).ok, true);
  assert.equal(stored().pro, undefined);
  assert.equal(sdk.config.bool('streak_freeze', null), false, 'unknown again');
  assert.deepEqual(stored().keys, keys, 'the rest of the cache stays');
});

test('remoteConfig.language wins over the phone\'s locale; one that throws or returns "" falls back to it', async () => {
  const { createHush } = await import(`../sdk/src/core.ts?config=${++launches}`);
  const keys = { greeting: { type: 'string', default: 'hello', rules: [{ when: { language: ['es'] }, value: 'hola' }, { when: { language: ['ca'] }, value: 'hola (ca)' }] } };
  server.body = answer(keys);
  const make = async (language) => {
    const mem = new Map();
    const hush = createHush({
      storage: { getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => void mem.set(k, v), removeItem: async (k) => void mem.delete(k) },
      onAppState() {},
      device: () => ({ version: '2.1.0', build: '1', platform: 'ios', os: 'ios 18', device: 'iPhone', locale: 'ca-ES' }),
      isDev: () => false,
    });
    hush.configure({ url: 'https://hush.test', key: 'hush_app_prod_x', remoteConfig: language === undefined ? undefined : { language } });
    await hush.config.ready();
    return hush.config.string('greeting', 'fallback');
  };
  assert.equal(await make(undefined), 'hola (ca)', "the phone's first locale");
  assert.equal(await make(() => 'es'), 'hola', "the app's language");
  assert.equal(await make(() => 'es-419'), 'hola');
  assert.equal(
    await make(() => {
      throw new Error('i18n not ready');
    }),
    'hola (ca)',
  );
  assert.equal(await make(() => ''), 'hola (ca)');
  assert.equal(await make(() => 42), 'hola (ca)');
});

test('forget(): a new install id, the cache kept, values evaluated again, onChange for what changed', async () => {
  h.storage.set('hush.install.v1', ONE);
  server.body = answer({
    paywall_variant: { type: 'string', default: 'a', rules: [{ rollout: 20, value: 'b' }] },
    review_prompt_after: { type: 'number', default: 3, rules: [] },
  });
  const sdk = await launch();
  await sdk.config.ready();
  assert.equal(sdk.config.string('paywall_variant', ''), 'b');
  const changes = [];
  sdk.config.onChange((k) => changes.push(k));
  const uuid = mock.method(globalThis.crypto, 'randomUUID', () => TWO);
  try {
    assert.equal((await sdk.forget()).ok, true);
  } finally {
    uuid.mock.restore();
  }
  assert.equal(sdk.installationId(), TWO);
  assert.equal(sdk.config.string('paywall_variant', ''), 'a', 'bucket 71 now');
  assert.deepEqual(changes, [['paywall_variant']]);
  assert.equal(stored().revision, 'aaaaaaaaaaaaaaaa');
  assert.equal(sdk.config.snapshot()[0].bucket, 71);
});

test('optOut(): config still loads and fetches, and the cache stays', async () => {
  let sdk = await launch();
  sdk.optOut();
  server.body = answer(KEYS, 'bbbbbbbbbbbbbbbb');
  await sdk.config.refresh();
  assert.equal(sdk.config.revision(), 'bbbbbbbbbbbbbbbb');
  sdk = await launch();
  assert.equal(sdk.isOptedOut(), true);
  assert.deepEqual(values(sdk.config), SERVED);
  assert.equal(configCalls.length, 3);
  assert.equal(configCalls[2].inm, '"bbbbbbbbbbbbbbbb"');
  assert.equal(stored().revision, 'bbbbbbbbbbbbbbbb');
  assert.equal(sent.filter((r) => r.path === '/v1/events').length, 1, 'only the batch from before the opt-out');
});

test('attribution with remote config: one request per init() serves both; no If-None-Match while the milestones are missing; a 304 keeps them', async () => {
  const milestones = [{ value: 6, coarse: 'medium', event: 'tutorial_done', where: null, lock: false }];
  server.body = answer(KEYS, 'aaaaaaaaaaaaaaaa', milestones);
  // A config cached by a launch without the bridge, or by 2.3's state: the milestones are missing.
  store({ revision: 'aaaaaaaaaaaaaaaa', keys: KEYS });
  const calls = [];
  const attribution = { update: async (v) => void calls.push(v.fine) };
  let sdk = await launch({ attribution });
  assert.equal(configCalls.length, 1, 'one request');
  assert.equal(configCalls[0].inm, null, 'no If-None-Match: the milestones would not come with a 304');
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0, 6]);
  assert.equal(JSON.parse(h.storage.get('hush.attribution.v1')).revision, 'aaaaaaaaaaaaaaaa');
  assert.deepEqual(values(sdk.config), SERVED);

  // The next launch revalidates both and keeps them; the 304 refreshes fetchedAt.
  mock.timers.tick(60_000);
  calls.length = 0;
  h.storage.set('hush.attribution.v1', JSON.stringify({ ...JSON.parse(h.storage.get('hush.attribution.v1')), value: 0 }));
  sdk = await launch({ attribution });
  assert.equal(configCalls.length, 2);
  assert.equal(configCalls[1].inm, '"aaaaaaaaaaaaaaaa"');
  assert.equal(JSON.parse(h.storage.get('hush.attribution.v1')).fetchedAt, Date.now());
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [6], 'the milestones kept through the 304');
});

test('opted out at launch, the conversion values change, then optIn(): one 200 without If-None-Match, and the new milestone is set', async () => {
  const calls = [];
  const attribution = { update: async (v) => void calls.push(v.fine) };
  server.body = answer(KEYS, 'aaaaaaaaaaaaaaaa', [{ value: 3, coarse: 'low', event: 'tutorial_done', where: null, lock: false }]);
  let sdk = await launch({ attribution });
  sdk.optOut();
  server.body = answer(KEYS, 'bbbbbbbbbbbbbbbb', [{ value: 9, coarse: 'medium', event: 'tutorial_done', where: null, lock: false }]);
  sdk = await launch({ attribution });
  assert.equal(configCalls.at(-1).inm, '"aaaaaaaaaaaaaaaa"', 'attribution does not run: the config alone decides');
  assert.equal(sdk.config.revision(), 'bbbbbbbbbbbbbbbb');
  const before = configCalls.length;
  sdk.optIn();
  await settle();
  assert.equal(configCalls.length, before + 1, 'one request');
  assert.equal(configCalls.at(-1).inm, null, 'without If-None-Match');
  sdk.track('tutorial_done');
  await settle();
  assert.deepEqual(calls, [0, 9]);
});

test('json(): frozen, the same reference across calls and across a new revision with an equal value; the fallback frozen only in development', async () => {
  server.body = answer({ presets: { type: 'json', default: { short: [3, 5], long: { minutes: 30 } }, rules: [] } });
  let sdk = await launch();
  await sdk.config.ready();
  const first = sdk.config.json('presets', null);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.short) && Object.isFrozen(first.long));
  assert.equal(sdk.config.json('presets', null), first);
  assert.throws(() => first.short.push(7), TypeError);
  server.body = answer({ presets: { type: 'json', default: { long: { minutes: 30 }, short: [3, 5] }, rules: [] } }, 'bbbbbbbbbbbbbbbb');
  assert.deepEqual(await sdk.config.refresh(), { status: 200, changed: [] });
  assert.equal(sdk.config.json('presets', null), first, 'an equal value keeps its reference');

  const prod = [1, { a: 2 }];
  assert.equal(sdk.config.json('absent', prod), prod);
  assert.equal(Object.isFrozen(prod), false, 'production: untouched');

  globalThis.__DEV__ = true;
  try {
    sdk = await launch();
    const dev = [1, { a: 2 }];
    assert.equal(sdk.config.json('absent', dev), dev);
    assert.ok(Object.isFrozen(dev) && Object.isFrozen(dev[1]), 'development: frozen, so .sort() fails here too');
  } finally {
    delete globalThis.__DEV__;
  }
});

test('useConfig() subscribes through onChange; the snapshot it reads moves with a change; it returns config', async () => {
  const sdk = await launch();
  await sdk.config.ready();
  assert.equal(sdk.useConfig(), sdk.config);
  const { subscribe, getSnapshot } = globalThis.__hushReact.at(-1);
  const before = getSnapshot();
  let renders = 0;
  const unsubscribe = subscribe(() => renders++);
  assert.equal(getSnapshot(), before, 'stable while nothing changes');
  server.body = answer({ ...KEYS, review_prompt_after: { type: 'number', default: 5, rules: [] } }, 'bbbbbbbbbbbbbbbb');
  await sdk.config.refresh();
  assert.equal(renders, 1);
  assert.notEqual(getSnapshot(), before);
  unsubscribe();
  server.body = answer({ ...KEYS, review_prompt_after: { type: 'number', default: 6, rules: [] } }, 'cccccccccccccccc');
  await sdk.config.refresh();
  assert.equal(renders, 1, 'unsubscribed');
});

test('the web entry: config in localStorage, If-None-Match on the next page load', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  globalThis.document = { visibilityState: 'visible', addEventListener() {} };
  try {
    const page = async () => {
      const { createWebHush } = await import(`../sdk/src/web.ts?config=${++launches}`);
      const hush = createWebHush({ version: '2.1.0', platform: 'web' });
      hush.configure({ url: 'https://hush.test', key: 'hush_web_prod_x' });
      await hush.config.ready();
      return hush;
    };
    let hush = await page();
    assert.deepEqual(values(hush.config), SERVED);
    assert.deepEqual(JSON.parse(mem.get('hush.config.v1')), { revision: 'aaaaaaaaaaaaaaaa', keys: KEYS });
    hush = await page();
    await settle();
    assert.equal(configCalls.at(-1).inm, '"aaaaaaaaaaaaaaaa"');
    assert.deepEqual(values(hush.config), SERVED);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.document;
  }
});

test('a stored config that does not parse, or is not one, is ignored and overwritten by the next 200', async () => {
  for (const bad of ['{"revision":"aaaa', '[1,2]', JSON.stringify({ revision: 5, keys: {} }), JSON.stringify({ revision: 'x', keys: [] }), JSON.stringify({ revision: 'x', keys: KEYS, pro: 'yes' })]) {
    h.storage.clear();
    store(bad);
    server.mode = 'held';
    const sdk = await launch();
    const usable = bad.includes('"pro":"yes"');
    assert.deepEqual(values(sdk.config), usable ? SERVED : FALLBACKS, bad);
    release();
    await settle();
    assert.deepEqual(values(sdk.config), SERVED, bad);
    assert.deepEqual(stored(), { revision: 'aaaaaaaaaaaaaaaa', keys: KEYS }, `${bad}: a pro that is not a boolean is not kept`);
    server.mode = 'ok';
  }
});

test('a key named after an Object property that the config does not have returns the fallback', async () => {
  const sdk = await launch();
  await sdk.config.ready();
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(sdk.config.string(key, 'fb'), 'fb', key);
    assert.equal(sdk.config.json(key, null), null, key);
  }
  // From an untrusted cache: a "__proto__" key never becomes a prototype.
  h.storage.clear();
  store(`{"revision":"aaaaaaaaaaaaaaaa","keys":{"__proto__":{"type":"string","default":"x","rules":[]}}}`);
  server.mode = 'hang';
  const next = await launch();
  assert.equal(next.config.string('constructor', 'fb'), 'fb');
  assert.equal(next.config.string('type', 'fb'), 'fb');
});
