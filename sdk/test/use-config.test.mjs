// useConfig() under real React 19, in components compiled by
// babel-plugin-react-compiler 1.0.0 as the apps build them (Expo's
// experiments.reactCompiler), and in StrictMode. React Native and Expo are
// stand-ins (hooks.mjs); /v1/config is a small fake that honours
// If-None-Match. Run with `npm test` in sdk/.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { transformSync } from '@babel/core';
import { createRequire } from 'node:module';
import React from 'react';
import TR from 'react-test-renderer';

const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// react-test-renderer still works on React 19; its notice says it will not on 20.
const consoleError = console.error;
console.error = (...args) => {
  if (!String(args[0]).includes('react-test-renderer is deprecated')) consoleError(...args);
};
const rn = (globalThis.__rn ??= { storage: new Map(), app: [] });

const INDEX = new URL('../src/index.ts', import.meta.url).href;
const INSTALL = '11111111-1111-4111-8111-111111111111';
const keys = (kill, presets, copy) => ({
  kill: { type: 'bool', default: kill, rules: [] },
  presets: { type: 'json', default: presets, rules: [] },
  copy: { type: 'string', default: copy, rules: [] },
});
let body;
let configCalls;
let launches = 0;

beforeEach(() => {
  rn.storage.clear();
  rn.app.length = 0;
  rn.storage.set('hush.install.v1', INSTALL);
  rn.storage.set('hush.first.v1', '2026-10-01T00:00:00.000Z');
  body = { conversion_values: [], config: { revision: 'r1r1r1r1r1r1r1r1', keys: keys(false, [3, 5, 10], 'hello') } };
  configCalls = 0;
  // The flush interval would keep the test process alive.
  mock.timers.reset();
  mock.timers.enable({ apis: ['setInterval'] });
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname !== '/v1/config') return { ok: true, status: 200, json: async () => ({ ok: true, accepted: 0 }) };
    configCalls += 1;
    if (init?.headers?.['If-None-Match'] === `"${body.config.revision}"`) return { ok: false, status: 304, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
});

/** A fresh SDK, as an app launch gets one. */
async function launch() {
  const url = `${INDEX}?launch=${++launches}`;
  const hush = await import(url);
  hush.configure({ url: 'https://hush.test', key: 'hush_test_prod_x' });
  return { hush, url };
}

/** Components compiled the way an app's are, importing useConfig from `sdkUrl`. */
async function compile(source, sdkUrl) {
  const { code } = transformSync(source, {
    filename: 'Screen.jsx',
    babelrc: false,
    configFile: false,
    plugins: [
      [require.resolve('babel-plugin-react-compiler'), { target: '19' }],
      [require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }],
    ],
  });
  // The test means nothing unless the compiler memoized these components.
  assert.match(code, /react\/compiler-runtime/);
  return import(`data:text/javascript,${encodeURIComponent(code.replaceAll("'@bavrk/hush'", JSON.stringify(sdkUrl)).replaceAll('"@bavrk/hush"', JSON.stringify(sdkUrl)))}`);
}

const SCREEN = `
import { useConfig } from '@bavrk/hush';

export function Banner() {
  const config = useConfig();
  const on = config.bool('kill', false);
  return <a>{on ? 'killed' : 'live'}</a>;
}

export function Presets() {
  const config = useConfig();
  const presets = config.json('presets', [3, 5, 10]);
  return <b>{presets.join(',')}</b>;
}

export function Copy() {
  const config = useConfig();
  const copy = config.string('copy', 'hi');
  return <c>{copy.toUpperCase()}</c>;
}

export function Flagged() {
  const config = useConfig();
  const flags = { a: config.bool('kill', false) };
  return <e>{String(flags.a)}</e>;
}
`;

async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

const shown = (root) => root.toJSON().map((n) => `${n.type}:${n.children.join('')}`).join(' ');

test('compiled components that derive from a getter show the first fetch and a dashboard change', async () => {
  const { hush, url } = await launch();
  const C = await compile(SCREEN, url);
  const e = React.createElement;
  let root;
  await TR.act(async () => {
    root = TR.create(e(React.Fragment, null, e(C.Banner), e(C.Presets), e(C.Copy), e(C.Flagged)));
  });
  assert.equal(shown(root), 'a:live b:3,5,10 c:HI e:false', 'before init: the fallbacks');

  await TR.act(async () => {
    await hush.init();
    await hush.config.ready();
    await settle();
  });
  assert.equal(shown(root), 'a:live b:3,5,10 c:HELLO e:false', 'the first fetch');

  body = { conversion_values: [], config: { revision: 'r2r2r2r2r2r2r2r2', keys: keys(true, [1, 2], 'bye') } };
  await TR.act(async () => {
    await hush.config.refresh();
  });
  assert.equal(shown(root), 'a:killed b:1,2 c:BYE e:true', 'a change on the dashboard');
  await TR.act(async () => root.unmount());
});

test('useConfig() returns one frozen object until a value changes, then a new one that reads the same as config', async () => {
  const { hush } = await launch();
  const seen = [];
  function Probe() {
    seen.push(hush.useConfig());
    return null;
  }
  let root;
  await TR.act(async () => {
    root = TR.create(React.createElement(Probe));
  });
  await TR.act(async () => {
    await hush.init();
    await hush.config.ready();
    await settle();
  });
  const loaded = seen.at(-1);
  assert.ok(Object.isFrozen(loaded));
  assert.notEqual(loaded, seen[0], 'the first fetch is a change');
  assert.equal(loaded.string('copy', '?'), 'hello');
  assert.equal(loaded.revision(), hush.config.revision());
  assert.deepEqual(loaded.snapshot(), hush.config.snapshot());

  await TR.act(async () => root.update(React.createElement(Probe)));
  assert.equal(seen.at(-1), loaded, 'a render without a change: the same object');

  body = { conversion_values: [], config: { revision: 'r2r2r2r2r2r2r2r2', keys: keys(false, [3, 5, 10], 'bye') } };
  await TR.act(async () => {
    await hush.config.refresh();
  });
  assert.notEqual(seen.at(-1), loaded);
  assert.equal(seen.at(-1).string('copy', '?'), 'bye');
  assert.equal(loaded.string('copy', '?'), 'bye', 'an older object reads the current values too');
  await TR.act(async () => root.unmount());
});

test('StrictMode: no render for a refresh that changes nothing, one per change, every subscription removed on unmount', async () => {
  rn.storage.set('hush.config.v1', JSON.stringify({ revision: 'r1r1r1r1r1r1r1r1', keys: keys(true, [3, 5, 10], 'hello') }));
  body.config.keys = keys(true, [3, 5, 10], 'hello');
  const { hush } = await launch();
  let live = 0;
  const onChange = hush.config.onChange;
  hush.config.onChange = (listener) => {
    live += 1;
    const off = onChange(listener);
    return () => {
      live -= 1;
      off();
    };
  };
  let renders = 0;
  function A() {
    renders += 1;
    return React.createElement('a', null, String(hush.useConfig().bool('kill', false)));
  }
  let root;
  await TR.act(async () => {
    root = TR.create(React.createElement(React.StrictMode, null, React.createElement(A)));
  });
  await TR.act(async () => {
    await hush.init();
    await settle();
  });
  assert.deepEqual(root.toJSON(), { type: 'a', props: {}, children: ['true'] }, 'the stored config');
  assert.equal(live, 1);

  const before = renders;
  const calls = configCalls;
  await TR.act(async () => {
    assert.equal((await hush.config.refresh()).status, 304);
  });
  assert.equal(configCalls, calls + 1);
  assert.equal(renders, before, 'a 304: no render');

  body = { conversion_values: [], config: { revision: 'r2r2r2r2r2r2r2r2', keys: keys(true, [3, 5, 10], 'hello') } };
  await TR.act(async () => {
    assert.deepEqual((await hush.config.refresh()).changed, []);
  });
  assert.equal(renders, before, 'a new revision with the same values: no render');

  body = { conversion_values: [], config: { revision: 'r3r3r3r3r3r3r3r3', keys: keys(false, [3, 5, 10], 'hello') } };
  await TR.act(async () => {
    await hush.config.refresh();
  });
  assert.deepEqual(root.toJSON(), { type: 'a', props: {}, children: ['false'] });
  assert.ok(renders > before && renders - before <= 2, 'one render per change (StrictMode renders twice)');

  await TR.act(async () => root.unmount());
  assert.equal(live, 0, 'subscribe and unsubscribe balance');
});
