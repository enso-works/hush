// Remote config on the server: the catalog's keys, the /v1/config answer
// with its revision, ETag and 304, the dashboard's overrides with their
// history and conflicts, overrides the catalog no longer fits, preview as,
// and the CLI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonical } from '../src/config-schema.mjs';
import { bucket } from '../src/evaluate.mjs';
import { addApp, admin, client, freshDatabase, startServer } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every catalog file gets a name of its own: other checkouts run this suite
// at the same time.
const files = [];
function catalogFile(data) {
  const file = join(tmpdir(), `hush-rc-catalog-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(data));
  files.push(file);
  return file;
}
after(() => {
  for (const f of files) rmSync(f, { force: true });
});

const SHOP_CONFIG = {
  session_presets: { type: 'json', default: [3, 5, 10], description: 'Session lengths on the start screen, in minutes.' },
  new_home: {
    type: 'bool', default: false, description: 'The redesigned home screen.',
    rules: [
      { when: { channel: ['testflight', 'dev'] }, value: true, note: 'Testers see it first' },
      // Written out of order: the answer puts platform first.
      { when: { version: '>=2.1.0', platform: ['ios'] }, rollout: 20, value: true },
    ],
  },
  paywall_copy: { type: 'string', default: 'Start your free week', description: 'The paywall headline.', rules: [{ when: { language: ['de'] }, value: 'Eine Woche gratis' }] },
  review_prompt_after: { type: 'number', default: 3, description: 'Sessions before the app asks for a review.' },
  theme: { type: 'json', default: { accent: 'blue', size: 2 }, description: 'Colours.' },
};
const SHOP_KEYS = {
  new_home: {
    type: 'bool', default: false,
    rules: [
      { when: { channel: ['testflight', 'dev'] }, rollout: 100, value: true },
      { when: { platform: ['ios'], version: '>=2.1.0' }, rollout: 20, value: true },
    ],
  },
  paywall_copy: { type: 'string', default: 'Start your free week', rules: [{ when: { language: ['de'] }, rollout: 100, value: 'Eine Woche gratis' }] },
  review_prompt_after: { type: 'number', default: 3, rules: [] },
  session_presets: { type: 'json', default: [3, 5, 10], rules: [] },
  theme: { type: 'json', default: { accent: 'blue', size: 2 }, rules: [] },
};
// Two string keys that can each serve about 40 KB: together over 64 KB.
const BIG_CONFIG = {
  big_a: { type: 'string', default: '', description: 'Big A.' },
  big_b: { type: 'string', default: '', description: 'Big B.' },
};
const bigRules = (ch, n = 20) => Array.from({ length: n }, (_, i) => ({ when: { channel: [`c${i}`] }, value: ch.repeat(2000) }));
const CATALOG = {
  shop: { events: ['checkout'], conversion_values: [{ value: 10, coarse: 'medium', event: 'checkout', label: 'Bought' }], config: SHOP_CONFIG },
  plain: { events: ['checkout'] },
  big: { config: BIG_CONFIG },
};

let db, srv, shopKey, plainKey, nocatKey;
before(async () => {
  db = await freshDatabase('hush_rc');
  srv = await startServer(db, { CATALOG_FILE: catalogFile(CATALOG) });
  shopKey = await addApp(db, 'shop', 'Shop');
  plainKey = await addApp(db, 'plain', 'Plain');
  nocatKey = await addApp(db, 'nocat', 'No catalog');
  await addApp(db, 'big', 'Big');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

const view = async (app = 'shop', s = srv) => (await admin(s.base).get(`/admin/apps/${app}/config`)).json;
const keyOf = async (key, app = 'shop', s = srv) => (await view(app, s)).keys.find((k) => k.key === key);
const changeOf = async (key, app = 'shop', s = srv) => {
  const v = await view(app, s);
  return (v.keys.find((k) => k.key === key) ?? v.orphans.find((k) => k.key === key))?.change ?? 0;
};
const set = async (key, body, app = 'shop', s = srv) =>
  admin(s.base).post(`/admin/apps/${app}/config/${key}`, { base: await changeOf(key, app, s), ...body });
const revert = async (key, app = 'shop', s = srv) =>
  admin(s.base).delete(`/admin/apps/${app}/config/${key}`, { base: await changeOf(key, app, s) });
const served = async (key = shopKey, s = srv) => (await client(s.base, key).get('/v1/config')).json.config;

describe('GET /v1/config', () => {
  test('an app with config: the merged keys in wire form, sorted, with the revision as ETag', async () => {
    const r = await client(srv.base, shopKey).get('/v1/config');
    assert.equal(r.status, 200);
    const revision = r.json.config.revision;
    assert.match(revision, /^[0-9a-f]{16}$/);
    assert.equal(r.headers.get('etag'), `"${revision}"`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    // The exact text: conversion values first, keys sorted, no description
    // or notes, rollout always there, when's fields in their order.
    assert.equal(r.text, JSON.stringify({
      conversion_values: [{ value: 10, coarse: 'medium', event: 'checkout', where: null, lock: false }],
      config: { revision, keys: SHOP_KEYS },
    }));
  });

  test('an app without config keys, and one with no catalog entry: an empty config, still with a revision', async () => {
    for (const key of [plainKey, nocatKey]) {
      const r = await client(srv.base, key).get('/v1/config');
      assert.match(r.json.config.revision, /^[0-9a-f]{16}$/);
      assert.deepEqual(r.json, { conversion_values: [], config: { revision: r.json.config.revision, keys: {} } });
      assert.equal(r.headers.get('etag'), `"${r.json.config.revision}"`);
    }
  });

  test('If-None-Match: the current revision, weak, in a list, or * is a 304 without a body; another is a 200', async () => {
    const c = client(srv.base, shopKey);
    const { revision } = await served();
    for (const header of [`"${revision}"`, `W/"${revision}"`, `"0000000000000000", "${revision}"`, '*']) {
      const r = await c.get('/v1/config', { 'If-None-Match': header });
      assert.equal(r.status, 304, header);
      assert.equal(r.text, '');
      assert.equal(r.headers.get('etag'), `"${revision}"`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    const other = await c.get('/v1/config', { 'If-None-Match': '"0000000000000000"' });
    assert.equal(other.status, 200);
    assert.equal(other.json.config.revision, revision);
    assert.equal((await c.get('/v1/config', { 'If-None-Match': revision })).status, 200, 'unquoted is not the ETag');
  });

  test('the revision moves with a write and comes back with the revert; equal json in another key order changes nothing', async () => {
    const { revision } = await served();
    assert.equal((await set('review_prompt_after', { default: 5 })).status, 200);
    const changed = await served();
    assert.notEqual(changed.revision, revision);
    assert.equal(changed.keys.review_prompt_after.default, 5, 'served at once, no 10 s wait');
    assert.equal((await revert('review_prompt_after')).status, 200);
    assert.equal((await served()).revision, revision);

    const same = await set('theme', { default: { size: 2, accent: 'blue' } });
    assert.equal(same.status, 200);
    assert.equal(same.json.revision, revision);
    assert.equal((await served()).revision, revision);
    assert.equal((await revert('theme')).status, 200);
  });

  test('CORS: the preflight allows If-None-Match, and every answer exposes ETag', async () => {
    const pre = await fetch(`${srv.base}/v1/config`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization, if-none-match' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, If-None-Match');
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST');
    const r = await client(srv.base, shopKey).get('/v1/config', { Origin: 'https://app.example' });
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('access-control-expose-headers'), 'ETag');
  });
});

describe('catalog errors stop the boot, naming the path', () => {
  const key = (k) => ({ type: 'bool', default: false, description: 'A key.', ...k });
  const rule = (r) => key({ rules: [{ value: true, ...r }] });
  const deep = (n) => JSON.parse('['.repeat(n) + ']'.repeat(n));
  const P = 'catalog.shop.config';
  const CASES = [
    ['config not an object', [], `${P}: expected an object keyed by config key`],
    ['over 100 keys', Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, key()])), `${P}: up to 100 keys`],
    ['a key name that is not one', { Bad: key() }, `${P}["Bad"]: not a key name: a-z, 0-9 and _, starting with a letter, 2 to 64 characters`],
    ['a key that is not an object', { ab: true }, `${P}.ab: expected an object with type, default and description`],
    ['an unknown field', { ab: key({ rule: [] }) }, `${P}.ab: unknown field "rule"; a key has type, default, description and rules`],
    ['no type', { ab: key({ type: 'boolean' }) }, `${P}.ab.type: bool, number, string or json`],
    ['no default', { ab: { type: 'bool', description: 'd' } }, `${P}.ab.default: required`],
    ['a bool default of 0', { ab: key({ default: 0 }) }, `${P}.ab.default: expected true or false`],
    ['a number default of "3"', { ab: key({ type: 'number', default: '3' }) }, `${P}.ab.default: expected a number`],
    ['a string default of null', { ab: key({ type: 'string', default: null }) }, `${P}.ab.default: expected text of up to 2000 characters`],
    ['a string of 2001 characters', { ab: key({ type: 'string', default: 'x'.repeat(2001) }) }, `${P}.ab.default: expected text of up to 2000 characters`],
    ['a json default that is a string', { ab: key({ type: 'json', default: 'x' }) }, `${P}.ab.default: expected an object or an array, up to 8 KB as JSON and 32 levels deep`],
    ['a json default over 8 KB', { ab: key({ type: 'json', default: ['x'.repeat(8190)] }) }, `${P}.ab.default: expected an object or an array, up to 8 KB as JSON and 32 levels deep`],
    ['a json default 33 levels deep', { ab: key({ type: 'json', default: deep(33) }) }, `${P}.ab.default: expected an object or an array, up to 8 KB as JSON and 32 levels deep`],
    ['a NUL in a string default', { ab: key({ type: 'string', default: 'a\u0000b' }) }, `${P}.ab.default: text may not contain a NUL character or a lone surrogate`],
    ['a lone surrogate in a json value', { ab: key({ type: 'json', default: { a: ['\ud800'] } }) }, `${P}.ab.default: text may not contain a NUL character or a lone surrogate`],
    ['no description', { ab: { type: 'bool', default: false } }, `${P}.ab.description: required, 1 to 200 characters`],
    ['a description of 201 characters', { ab: key({ description: 'd'.repeat(201) }) }, `${P}.ab.description: required, 1 to 200 characters`],
    ['rules that are not a list', { ab: key({ rules: {} }) }, `${P}.ab.rules: expected a list of up to 20 rules`],
    ['over 20 rules', { ab: key({ rules: Array.from({ length: 21 }, () => ({ value: true })) }) }, `${P}.ab.rules: expected a list of up to 20 rules`],
    ['a rule that is not an object', { ab: key({ rules: [true] }) }, `${P}.ab.rules[0]: expected an object with a value`],
    ['a rule with an unknown field', { ab: rule({ vaule: true }) }, `${P}.ab.rules[0]: unknown field "vaule"; a rule has when, rollout, value and note`],
    ['a rule without a value', { ab: key({ rules: [{ rollout: 5 }] }) }, `${P}.ab.rules[0].value: required`],
    ['a rule value of the wrong type', { ab: rule({ value: 'yes' }) }, `${P}.ab.rules[0].value: expected true or false`],
    ['a NUL in a rule\'s string value', { ab: key({ type: 'string', default: '', rules: [{ value: '\u0000' }] }) }, `${P}.ab.rules[0].value: text may not contain a NUL character or a lone surrogate`],
    ['when that is not an object', { ab: rule({ when: ['ios'] }) }, `${P}.ab.rules[0].when: expected an object of conditions`],
    ['an unknown condition', { ab: rule({ when: { country: ['DE'] } }) }, `${P}.ab.rules[0].when: unknown condition "country"; platform, version, channel, language or pro`],
    ['a platform that is not one', { ab: rule({ when: { platform: ['iOS'] } }) }, `${P}.ab.rules[0].when.platform: expected a list of 1 to 10 platforms, such as ios, android, web`],
    ['an empty platform list', { ab: rule({ when: { platform: [] } }) }, `${P}.ab.rules[0].when.platform: expected a list of 1 to 10 platforms, such as ios, android, web`],
    ['a version without an operator', { ab: rule({ when: { version: '2.1.0' } }) }, `${P}.ab.rules[0].when.version: expected a range such as ">=2.1.0 <3": >=, >, <=, < or = and a version, separated by spaces`],
    ['a version with x', { ab: rule({ when: { version: '>=2.x' } }) }, `${P}.ab.rules[0].when.version: expected a range such as ">=2.1.0 <3": >=, >, <=, < or = and a version, separated by spaces`],
    ['=2.1', { ab: rule({ when: { version: '=2.1' } }) }, `${P}.ab.rules[0].when.version: "=2.1" matches 2.1.0 only: write =2.1.0, or >=2.1 <2.2 for every 2.1 release`],
    ['=2', { ab: rule({ when: { version: '>=1 =2' } }) }, `${P}.ab.rules[0].when.version: "=2" matches 2.0.0 only: write =2.0.0, or >=2 <3 for every 2.x release`],
    ['>=3 <2', { ab: rule({ when: { version: '>=3 <2' } }) }, `${P}.ab.rules[0].when.version: no version satisfies this range`],
    ['>1.0.0 <1.0.1', { ab: rule({ when: { version: '>1.0.0 <1.0.1' } }) }, `${P}.ab.rules[0].when.version: no version satisfies this range`],
    ['a channel that is not one', { ab: rule({ when: { channel: ['App Store'] } }) }, `${P}.ab.rules[0].when.channel: expected a list of 1 to 10 channels, such as app_store, testflight`],
    ['a language that is a locale', { ab: rule({ when: { language: ['pt-BR'] } }) }, `${P}.ab.rules[0].when.language: expected a list of 1 to 50 languages, such as en, de, pt`],
    ['pro as a string', { ab: rule({ when: { pro: 'true' } }) }, `${P}.ab.rules[0].when.pro: expected true or false`],
    ['a rollout of 50.5', { ab: rule({ rollout: 50.5 }) }, `${P}.ab.rules[0].rollout: a whole number from 0 to 100`],
    ['a rollout of 101', { ab: rule({ rollout: 101 }) }, `${P}.ab.rules[0].rollout: a whole number from 0 to 100`],
    ['a note of 201 characters', { ab: rule({ note: 'n'.repeat(201) }) }, `${P}.ab.rules[0].note: up to 200 characters`],
    ['a NUL in a note', { ab: rule({ note: 'a\u0000' }) }, `${P}.ab.rules[0].note: text may not contain a NUL character or a lone surrogate`],
    ['over 64 KB served', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, key({ type: 'string', default: 'x'.repeat(2000) })])), /catalog\.shop\.config: \d+ KB as JSON; the limit is 64 KB/],
  ];
  // The catalog is read at import, before the database: a server that gets
  // past it fails on the unreachable database instead.
  const boot = (config) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none', PORT: '0', CATALOG_FILE: catalogFile({ shop: { config } }) },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

  test('each error, at its path, with its message', async () => {
    const results = await Promise.all(CASES.map(([, config]) => boot(config)));
    for (const [i, [name, , expected]] of CASES.entries()) {
      const { code, out } = results[i];
      assert.notEqual(code, 0, name);
      if (expected instanceof RegExp) assert.match(out, expected, name);
      else assert.ok(out.includes(expected), `${name}: expected ${JSON.stringify(expected)} in\n${out}`);
    }
  });

  test('what passes: 32 levels of json, every condition, =2.1.0 and a range', async () => {
    const { code, out } = await boot({
      ab: key({ type: 'json', default: deep(32), rules: [{ when: { platform: ['ios'], version: '>=2.1 <2.2', channel: ['dev'], language: ['de'], pro: true }, rollout: 0, value: {} }] }),
      cd: rule({ when: { version: '=2.1.0' }, note: '  ' }),
    });
    assert.notEqual(code, 0);
    assert.match(out, /startup failed/, 'past the catalog, to the database');
    assert.doesNotMatch(out, /catalog\./);
  });
});

describe('the admin API', () => {
  test('GET: keys sorted with catalog, override, effective, source, problem, fits, change; the limits and the size', async () => {
    assert.equal((await set('new_home', { rules: [{ when: { pro: true }, value: true, note: 'Paid first' }], note: 'Pro first' })).status, 200);
    const v = await view();
    assert.equal(v.app, 'shop');
    assert.equal(v.revision, (await served()).revision);
    assert.deepEqual(v.limits, { keys: 100, rules: 20, string_chars: 2000, json_bytes: 8192, total_bytes: 65536, note_chars: 200 });
    assert.equal(v.size_bytes, Buffer.byteLength(canonical((await served()).keys)));
    assert.deepEqual(v.keys.map((k) => k.key), ['new_home', 'paywall_copy', 'review_prompt_after', 'session_presets', 'theme']);
    assert.deepEqual(v.orphans, []);
    const home = v.keys[0];
    assert.equal(home.type, 'bool');
    assert.equal(home.description, 'The redesigned home screen.');
    assert.deepEqual(home.catalog.rules[0], { when: { channel: ['testflight', 'dev'] }, rollout: 100, value: true, note: 'Testers see it first' });
    assert.deepEqual(Object.keys(home.catalog.rules[1].when), ['platform', 'version']);
    assert.deepEqual(home.override.rules, [{ when: { pro: true }, rollout: 100, value: true, note: 'Paid first' }]);
    assert.equal(home.override.default, undefined, 'only the rules are overridden');
    assert.equal(home.override.note, 'Pro first');
    assert.match(home.override.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(home.effective, { default: false, rules: home.override.rules });
    assert.deepEqual(home.source, { default: 'catalog', rules: 'override' });
    assert.equal(home.problem, null);
    assert.equal(home.fits, true);
    assert.ok(home.change > 0);
    const copy = v.keys[1];
    assert.equal(copy.override, null);
    assert.deepEqual(copy.source, { default: 'catalog', rules: 'catalog' });
    assert.equal(copy.change, 0);
    assert.equal((await revert('new_home')).status, 200);
  });

  test('an app that is not registered is a 404 on every config route', async () => {
    const a = admin(srv.base);
    for (const r of [
      await a.get('/admin/apps/nope/config'),
      await a.get('/admin/apps/nope/config/history'),
      await a.get('/admin/apps/nope/config/preview'),
      await a.post('/admin/apps/nope/config/new_home', { base: 0, default: true }),
      await a.delete('/admin/apps/nope/config/new_home', { base: 0 }),
    ]) assert.deepEqual([r.status, r.json], [404, { error: 'unknown app' }]);
  });

  test('POST: each error, with its status and body', async () => {
    const a = admin(srv.base);
    const post = (key, body) => a.post(`/admin/apps/shop/config/${key}`, body);
    const err = (path, message) => ({ error: path ? `${path}: ${message}` : message, path, message });
    const BASE = err('base', 'the change id the editor started from, a whole number');
    const NUL = 'text may not contain a NUL character or a lone surrogate';
    const changes = async () => (await db.query("SELECT count(*)::int AS n FROM config_changes WHERE app = 'shop'")).rows[0].n;
    const before = await changes();
    for (const [name, key, body, status, expected] of [
      ['not an object', 'new_home', '[1]', 400, { error: 'expected a JSON object' }],
      ['no base', 'new_home', { default: true }, 400, BASE],
      ['a negative base', 'new_home', { base: -1, default: true }, 400, BASE],
      ['a base as text', 'new_home', { base: '0', default: true }, 400, BASE],
      ['a key the catalog lacks', 'old_key', { base: 0, default: true }, 404, { error: 'no such key in the catalog' }],
      ['neither part', 'new_home', { base: 0, note: 'x' }, 400, err('', 'override the default, the rules or both')],
      ['a default of the wrong type', 'review_prompt_after', { base: 0, default: '5' }, 400, err('default', 'expected a number')],
      ['=2.1', 'new_home', { base: 0, rules: [{ value: true }, { when: { version: '=2.1' }, value: true }] }, 400, err('rules[1].when.version', '"=2.1" matches 2.1.0 only: write =2.1.0, or >=2.1 <2.2 for every 2.1 release')],
      ['an unknown condition', 'new_home', { base: 0, rules: [{ when: { country: ['DE'] }, value: true }] }, 400, err('rules[0].when', 'unknown condition "country"; platform, version, channel, language or pro')],
      ['a NUL in the change note', 'review_prompt_after', { base: 0, default: 4, note: 'a\u0000b' }, 400, err('note', NUL)],
      ['a note of 201 characters', 'review_prompt_after', { base: 0, default: 4, note: 'n'.repeat(201) }, 400, err('note', 'up to 200 characters')],
      ['a NUL in a rule\'s string value', 'paywall_copy', { base: 0, rules: [{ value: 'a\u0000' }] }, 400, err('rules[0].value', NUL)],
      ['a lone surrogate in a json value', 'theme', { base: 0, default: { accent: '\ud800' } }, 400, err('default', NUL)],
      ['null as a default', 'theme', { base: 0, default: null }, 400, err('default', 'expected an object or an array, up to 8 KB as JSON and 32 levels deep')],
    ]) {
      // The current base, so a 409 cannot hide the error under test.
      const current = typeof body === 'object' && body.base === 0 ? { ...body, base: await changeOf(key) } : body;
      const r = await post(key, current);
      assert.deepEqual([r.status, r.json], [status, expected], name);
    }
    assert.equal(await changes(), before, 'nothing written');
  });

  test('POST: the override and one set row; a partial override keeps the catalog\'s other part', async () => {
    const before = await changeOf('paywall_copy');
    const r = await set('paywall_copy', { default: 'Try it free', note: '  Shorter  ' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.revision, (await served()).revision);
    assert.equal(r.json.key.key, 'paywall_copy');
    assert.deepEqual(r.json.key.source, { default: 'override', rules: 'catalog' });
    assert.ok(r.json.key.change > before);
    const s = (await served()).keys.paywall_copy;
    assert.deepEqual(s, { type: 'string', default: 'Try it free', rules: SHOP_KEYS.paywall_copy.rules });
    const { rows } = await db.query("SELECT * FROM config_changes WHERE app = 'shop' AND key = 'paywall_copy' ORDER BY id");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'set');
    assert.equal(Number(rows[0].id), r.json.key.change);
    assert.equal(rows[0].override_before, null);
    assert.deepEqual(rows[0].override_after, { default: 'Try it free' });
    assert.deepEqual(rows[0].effective_before, { default: 'Start your free week', rules: [{ when: { language: ['de'] }, rollout: 100, value: 'Eine Woche gratis' }] });
    assert.deepEqual(rows[0].effective_after, { default: 'Try it free', rules: [{ when: { language: ['de'] }, rollout: 100, value: 'Eine Woche gratis' }] });
    assert.equal(rows[0].note, 'Shorter');
    const { rows: [o] } = await db.query("SELECT default_value, rules, note, orphaned_at FROM config_overrides WHERE app = 'shop' AND key = 'paywall_copy'");
    assert.deepEqual(o, { default_value: 'Try it free', rules: null, note: 'Shorter', orphaned_at: null });
    // An empty rules list is an override too: no rules at all.
    const none = await set('paywall_copy', { default: 'Try it free', rules: [] });
    assert.equal(none.status, 200);
    assert.deepEqual((await served()).keys.paywall_copy.rules, []);
    const h = (await admin(srv.base).get('/admin/apps/shop/config/history?key=paywall_copy')).json.changes[0];
    assert.deepEqual(h.override_before, { default: 'Try it free' });
    assert.deepEqual(h.override_after, { default: 'Try it free', rules: [] });
    assert.equal((await revert('paywall_copy')).status, 200);
  });

  test('POST bodies up to 160 KB are read; the served config is held to 64 KB, also by two saves at once', async () => {
    // About 30 KB served, padded past 64 KB with whitespace JSON allows.
    const body = { base: await changeOf('big_a', 'big'), rules: bigRules('a', 15) };
    const text = `${JSON.stringify(body)}${' '.repeat(40_000)}`;
    assert.ok(Buffer.byteLength(text) > 64 * 1024 && Buffer.byteLength(text) < 160 * 1024);
    const r = await admin(srv.base).post('/admin/apps/big/config/big_a', text);
    assert.equal(r.status, 200, r.text);
    assert.equal((await revert('big_a', 'big')).status, 200);
    const huge = await admin(srv.base).post('/admin/apps/big/config/big_a', `${JSON.stringify(body)}${' '.repeat(140_000)}`);
    assert.equal(huge.status, 413);

    // About 40 KB each: either fits alone, both do not.
    const bases = [await changeOf('big_a', 'big'), await changeOf('big_b', 'big')];
    const [a, b] = await Promise.all([
      admin(srv.base).post('/admin/apps/big/config/big_a', { base: bases[0], rules: bigRules('a') }),
      admin(srv.base).post('/admin/apps/big/config/big_b', { base: bases[1], rules: bigRules('b') }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400]);
    const failed = a.status === 400 ? a : b;
    assert.match(failed.json.error, /^the app's config would be \d+ KB as JSON; the limit is 64 KB$/);
    assert.equal(failed.json.path, '');
    const won = a.status === 200 ? 'big_a' : 'big_b';
    assert.equal((await revert(won, 'big')).status, 200);
  });

  test('409: two saves from the same base; a revert and a new override do not pass for the version loaded before', async () => {
    const base = await changeOf('review_prompt_after');
    const first = await admin(srv.base).post('/admin/apps/shop/config/review_prompt_after', { base, default: 4 });
    assert.equal(first.status, 200);
    const second = await admin(srv.base).post('/admin/apps/shop/config/review_prompt_after', { base, default: 6 });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'changed since you opened it');
    assert.equal(second.json.key.override.default, 4);
    assert.equal(second.json.key.change, first.json.key.change);

    const loaded = first.json.key.change;
    assert.equal((await revert('review_prompt_after')).status, 200);
    assert.equal((await set('review_prompt_after', { default: 4 })).status, 200);
    const stale = await admin(srv.base).post('/admin/apps/shop/config/review_prompt_after', { base: loaded, default: 7 });
    assert.equal(stale.status, 409, 'the same override again, but not the same version');
    const staleRevert = await admin(srv.base).delete('/admin/apps/shop/config/review_prompt_after', { base: loaded });
    assert.equal(staleRevert.status, 409);
    assert.equal((await served()).keys.review_prompt_after.default, 4);
    assert.equal((await revert('review_prompt_after')).status, 200);
  });

  test('DELETE: reverts to the catalog with a revert row; nothing stored is a 404', async () => {
    assert.equal((await set('session_presets', { default: [1, 2], note: 'Shorter' })).status, 200);
    const base = await changeOf('session_presets');
    const r = await admin(srv.base).delete('/admin/apps/shop/config/session_presets', { base, note: 'Back' });
    assert.equal(r.status, 200);
    assert.equal(r.json.key.override, null);
    assert.ok(r.json.key.change > base);
    assert.deepEqual((await served()).keys.session_presets.default, [3, 5, 10]);
    const { rows: [row] } = await db.query("SELECT * FROM config_changes WHERE app = 'shop' AND key = 'session_presets' ORDER BY id DESC LIMIT 1");
    assert.equal(row.action, 'revert');
    assert.deepEqual(row.override_before, { default: [1, 2] });
    assert.equal(row.override_after, null);
    assert.deepEqual(row.effective_before, { default: [1, 2], rules: [] });
    assert.deepEqual(row.effective_after, { default: [3, 5, 10], rules: [] });
    assert.equal(row.note, 'Back');
    const again = await admin(srv.base).delete('/admin/apps/shop/config/session_presets', { base: r.json.key.change });
    assert.deepEqual([again.status, again.json], [404, { error: 'no override' }]);
    const noBase = await admin(srv.base).delete('/admin/apps/shop/config/session_presets', {});
    assert.equal(noBase.status, 400);
  });

  test('writes are same-origin JSON', async () => {
    const plain = await admin(srv.base).post('/admin/apps/shop/config/review_prompt_after', 'base=0', { 'Content-Type': 'text/plain' });
    assert.equal(plain.status, 403);
    const crossSite = await admin(srv.base).post('/admin/apps/shop/config/review_prompt_after', { base: 0, default: 9 }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const del = await admin(srv.base).delete('/admin/apps/shop/config/review_prompt_after', { base: 0 }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(del.status, 403);
    assert.equal((await client(srv.base).post('/admin/apps/shop/config/review_prompt_after', { base: 0, default: 9 })).status, 401);
    assert.equal((await served()).keys.review_prompt_after.default, 3);
  });
});

describe('history', () => {
  test('newest first, by key, limit 1 to 50 (20 by default), before, more', async () => {
    for (let i = 0; i < 26; i++) assert.equal((await set('review_prompt_after', { default: 10 + i, note: `n${i}` })).status, 200);
    for (let i = 0; i < 26; i++) assert.equal((await set('theme', { default: { i } })).status, 200);
    const get = async (q) => (await admin(srv.base).get(`/admin/apps/shop/config/history${q}`)).json;
    const all = await get('');
    assert.equal(all.changes.length, 20);
    assert.equal(all.more, true);
    assert.deepEqual(all.changes.map((c) => c.id), [...all.changes.map((c) => c.id)].sort((a, b) => b - a));
    assert.equal(all.changes[0].key, 'theme');
    assert.deepEqual(Object.keys(all.changes[0]), ['id', 'key', 'at', 'action', 'override_before', 'override_after', 'effective_before', 'effective_after', 'note']);
    const byKey = await get('?key=review_prompt_after&limit=5');
    assert.equal(byKey.changes.length, 5);
    assert.ok(byKey.changes.every((c) => c.key === 'review_prompt_after'));
    assert.equal(byKey.changes[0].note, 'n25');
    assert.deepEqual(byKey.changes[0].effective_after, { default: 35, rules: [] });
    assert.equal((await get('?limit=500')).changes.length, 50);
    assert.equal((await get('?limit=-3')).changes.length, 1);
    assert.equal((await get('?limit=x')).changes.length, 20);
    assert.equal((await get('?limit=0')).changes.length, 1);
    // A key no key can match is an empty page, not the whole app's history.
    assert.deepEqual(await get(`?key=${'a'.repeat(65)}&limit=50`), { changes: [], more: false });
    const older = await get(`?key=review_prompt_after&limit=50&before=${byKey.changes[4].id}`);
    assert.ok(older.changes.every((c) => c.id < byKey.changes[4].id));
    const { rows: [count] } = await db.query("SELECT count(*)::int AS n FROM config_changes WHERE app = 'shop' AND key = 'review_prompt_after' AND id < $1", [byKey.changes[4].id]);
    assert.ok(count.n >= 21);
    assert.equal(older.changes.length, count.n);
    assert.equal(older.more, false);
    const page = await get(`?key=review_prompt_after&limit=3&before=${byKey.changes[4].id}`);
    assert.equal(page.more, true);
    assert.equal((await revert('review_prompt_after')).status, 200);
    assert.equal((await revert('theme')).status, 200);
  });

  test('a page of large rows stops once it passes 1 MB, with more', async () => {
    // Each change carries about 4 x 40 KB.
    for (let i = 0; i < 9; i++) assert.equal((await set('big_a', { rules: bigRules(i % 2 ? 'x' : 'y') }, 'big')).status, 200);
    const page = (await admin(srv.base).get('/admin/apps/big/config/history?key=big_a&limit=20')).json;
    assert.ok(page.changes.length > 1 && page.changes.length < 9, `${page.changes.length} rows`);
    assert.equal(page.more, true);
    const size = (rows) => rows.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)), 0);
    assert.ok(size(page.changes) > 1024 * 1024, 'stops only once it passes');
    assert.ok(size(page.changes.slice(0, -1)) <= 1024 * 1024, 'and not later');
    const next = (await admin(srv.base).get(`/admin/apps/big/config/history?key=big_a&limit=20&before=${page.changes.at(-1).id}`)).json;
    assert.ok(next.changes.length >= 1);
    assert.equal((await revert('big_a', 'big')).status, 200);
  });
});

describe('preview as', () => {
  const INSTALL = '3f2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f';
  const FREE = '4a2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f';
  before(async () => {
    await db.query(
      `INSERT INTO installs (id, app, env, platform, version, channel, locale, pro) VALUES
         ($1, 'shop', 'prod', 'ios', '2.1.0', 'app_store', 'de-DE', true),
         ($2, 'shop', 'prod', 'android', '1.0', NULL, 'en-US', false)`,
      [INSTALL, FREE],
    );
  });
  const get = (q) => admin(srv.base).get(`/admin/apps/shop/config/preview${q}`);

  test('from parameters: every outcome with its share of the 100 buckets', async () => {
    const r = await get('?platform=ios&version=2.1.0&language=de-AT');
    assert.equal(r.status, 200);
    assert.equal(r.json.install, null);
    assert.deepEqual(r.json.context, { platform: 'ios', version: '2.1.0', channel: null, language: 'de-AT', pro: null });
    assert.deepEqual(r.json.from_install, []);
    assert.deepEqual(r.json.warnings, []);
    assert.deepEqual(r.json.keys.map((k) => k.key), ['new_home', 'paywall_copy', 'review_prompt_after', 'session_presets', 'theme']);
    const home = r.json.keys[0];
    assert.deepEqual(home, { key: 'new_home', type: 'bool', draft: false, outcomes: [{ rule: 1, value: true, share: 20 }, { rule: -1, value: false, share: 80 }] });
    assert.deepEqual(r.json.keys[1].outcomes, [{ rule: 0, value: 'Eine Woche gratis', share: 100 }]);
    for (const k of r.json.keys) assert.equal(k.outcomes.reduce((n, o) => n + o.share, 0), 100);
    const one = await get('?platform=android&key=new_home');
    assert.deepEqual(one.json.keys, [{ key: 'new_home', type: 'bool', draft: false, outcomes: [{ rule: -1, value: false, share: 100 }] }]);
  });

  test('from an install: the row fills what is not given, its bucket is the device\'s', async () => {
    const r = await get(`?install=${INSTALL.toUpperCase()}&channel=testflight`);
    assert.equal(r.status, 200);
    assert.equal(r.json.install, INSTALL);
    assert.deepEqual(r.json.context, { platform: 'ios', version: '2.1.0', channel: 'testflight', language: 'de-DE', pro: true });
    assert.deepEqual(r.json.from_install, ['platform', 'version', 'language', 'pro']);
    assert.deepEqual(r.json.warnings, [
      "pro comes from the install's last batch; a device that has never called identify() treats it as unknown",
      "language comes from the phone's locale; an app that passes its own language to remoteConfig may be evaluated with another",
    ]);
    const home = r.json.keys.find((k) => k.key === 'new_home');
    assert.equal(home.bucket, bucket(INSTALL, 'new_home'));
    assert.deepEqual([home.rule, home.value], [0, true], 'the explicit channel wins over the row');
    const paywall = r.json.keys.find((k) => k.key === 'paywall_copy');
    assert.deepEqual([paywall.rule, paywall.value, paywall.bucket], [0, 'Eine Woche gratis', bucket(INSTALL, 'paywall_copy')]);
  });

  test('an install row with pro false leaves pro unknown, and says why', async () => {
    const r = await get(`?install=${FREE}&version=v2`);
    assert.deepEqual(r.json.context, { platform: 'android', version: 'v2', channel: null, language: 'en-US', pro: null });
    assert.deepEqual(r.json.from_install, ['platform', 'language']);
    assert.deepEqual(r.json.warnings, [
      'the install row cannot tell a free install from one that never said; add pro=false to preview a free device',
      'version "v2" cannot be read, so no version condition holds',
      "language comes from the phone's locale; an app that passes its own language to remoteConfig may be evaluated with another",
    ]);
    const free = await get(`?install=${FREE}&pro=false&language=x1`);
    assert.equal(free.json.context.pro, false);
    assert.deepEqual(free.json.warnings, ['language "x1" is not a language, so no language condition holds']);
  });

  test('a draft of one key, over 64 characters, and its validation errors', async () => {
    const draft = JSON.stringify({ rules: [{ when: { platform: ['android'] }, rollout: 30, value: true, note: 'A draft longer than sixty-four characters, on purpose.' }] });
    assert.ok(draft.length > 64);
    const r = await get(`?key=new_home&platform=android&draft=${encodeURIComponent(draft)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.keys, [{ key: 'new_home', type: 'bool', draft: true, outcomes: [{ rule: 0, value: true, share: 30 }, { rule: -1, value: false, share: 70 }] }]);
    const empty = await get('?key=new_home&platform=ios&version=3.0.0&draft=%7B%7D');
    assert.deepEqual(empty.json.keys[0].outcomes, [{ rule: 1, value: true, share: 20 }, { rule: -1, value: false, share: 80 }], 'an empty draft is the catalog\'s entry');
    const bad = await get(`?key=new_home&draft=${encodeURIComponent(JSON.stringify({ rules: [{ value: 1 }] }))}`);
    assert.deepEqual([bad.status, bad.json], [400, { error: 'draft.rules[0].value: expected true or false', path: 'draft.rules[0].value', message: 'expected true or false' }]);
  });

  test('bad parameters, an unknown install and an unknown key', async () => {
    for (const [q, status, error] of [
      ['?install=nope', 400, 'install: expected an install id'],
      [`?platform=${'p'.repeat(65)}`, 400, 'platform: at most 64 characters'],
      ['?pro=maybe', 400, 'pro: true or false'],
      ['?draft=%7B%7D', 400, 'draft: needs key'],
      ['?key=new_home&draft=%7Bnope', 400, 'draft: not JSON'],
      ['?install=00000000-0000-4000-8000-000000000000', 404, 'install not found'],
      ['?key=old_key', 404, 'no such key in the catalog'],
    ]) {
      const r = await get(q);
      assert.deepEqual([r.status, r.json.error], [status, error], q);
    }
  });
});

describe('the CLI', () => {
  const cli = (...args) => spawnSync(process.execPath, ['src/cli.mjs', ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, DATABASE_URL: db.url, CATALOG_FILE: files[0] },
    encoding: 'utf8',
  });

  test('config:show prints what /v1/config answers; config:history lists changes without their values', async () => {
    assert.equal((await set('review_prompt_after', { default: 8, note: 'From the CLI test' })).status, 200);
    const show = cli('config:show', 'shop');
    assert.equal(show.status, 0, show.stderr);
    assert.deepEqual(JSON.parse(show.stdout), (await client(srv.base, shopKey).get('/v1/config')).json);
    const hist = cli('config:history', 'shop', 'review_prompt_after');
    assert.equal(hist.status, 0, hist.stderr);
    const [first] = hist.stdout.trim().split('\n');
    const [id, at, key, action, note] = first.split('\t');
    assert.equal(Number(id), await changeOf('review_prompt_after'));
    assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual([key, action, note], ['review_prompt_after', 'set', 'From the CLI test']);
    assert.ok(hist.stdout.trim().split('\n').length <= 50);
    assert.notEqual(cli('config:show', 'nope').status, 0);
    assert.equal((await revert('review_prompt_after')).status, 200);
  });
});

describe('overrides the catalog no longer fits', () => {
  // A server of its own: these restart it with other catalogs.
  let d, s, key;
  const restart = async (config) => {
    await s?.stop();
    s = await startServer(d, { CATALOG_FILE: catalogFile({ shop: { config } }) });
  };
  // The boot check runs once the server listens.
  const warnings = async (n) => {
    for (let i = 0; i < 50; i++) {
      const lines = s.logs.join('').split('\n').filter((l) => l.includes('config: override not served'));
      if (lines.length >= n) return lines.map((l) => JSON.parse(l));
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`expected ${n} boot warnings in\n${s.logs.join('')}`);
  };
  const BASE_CONFIG = {
    flag: { type: 'bool', default: false, description: 'A flag.' },
    count: { type: 'bool', default: false, description: 'Was a flag.' },
    copy: { type: 'string', default: 'a', description: 'Copy.', rules: [{ when: { language: ['de'] }, value: 'b' }] },
  };
  before(async () => {
    d = await freshDatabase('hush_rc_restart');
    await restart(BASE_CONFIG);
    key = await addApp(d, 'shop', 'Shop');
  });
  after(async () => {
    await s?.stop();
    await d?.drop();
  });

  test('the revision is the same after a restart with the same catalog and overrides', async () => {
    assert.equal((await set('copy', { default: 'c' }, 'shop', s)).status, 200);
    const before = (await served(key, s)).revision;
    await restart(BASE_CONFIG);
    assert.equal((await served(key, s)).revision, before);
  });

  test('a partial override keeps the catalog\'s other part, and a catalog change to that part shows after a restart', async () => {
    assert.deepEqual((await served(key, s)).keys.copy, { type: 'string', default: 'c', rules: [{ when: { language: ['de'] }, rollout: 100, value: 'b' }] });
    await restart({ ...BASE_CONFIG, copy: { ...BASE_CONFIG.copy, rules: [{ when: { language: ['nl'] }, value: 'n' }] } });
    assert.deepEqual((await served(key, s)).keys.copy, { type: 'string', default: 'c', rules: [{ when: { language: ['nl'] }, rollout: 100, value: 'n' }] });
  });

  test('a dropped key and a changed type: kept, not served, listed, one boot warning each', async () => {
    assert.equal((await set('flag', { default: true, note: 'On' }, 'shop', s)).status, 200);
    assert.equal((await set('count', { default: true }, 'shop', s)).status, 200);
    const { flag, ...withoutFlag } = BASE_CONFIG;
    await restart({ ...withoutFlag, count: { type: 'number', default: 0, description: 'Now a number.' } });
    const logged = await warnings(2);
    assert.deepEqual(logged.map((l) => [l.app, l.key, l.reason]).sort(), [
      ['shop', 'count', 'default: expected a number'],
      ['shop', 'flag', 'not in the catalog'],
    ]);
    const conf = await served(key, s);
    assert.equal(conf.keys.flag, undefined);
    assert.deepEqual(conf.keys.count, { type: 'number', default: 0, rules: [] });
    const v = await view('shop', s);
    assert.deepEqual(v.orphans.map((o) => [o.key, o.override.default, o.override.note]), [['flag', true, 'On']]);
    assert.ok(v.orphans[0].change > 0);
    const count = v.keys.find((k) => k.key === 'count');
    assert.equal(count.problem, 'default: expected a number');
    assert.equal(count.fits, false);
    assert.deepEqual(count.override.default, true);
    assert.deepEqual(count.source, { default: 'catalog', rules: 'catalog' });
    assert.deepEqual(count.effective, { default: 0, rules: [] });
    const { rows } = await d.query("SELECT key, orphaned_at IS NOT NULL AS marked FROM config_overrides WHERE app = 'shop' ORDER BY key");
    assert.deepEqual(rows.map((r) => [r.key, r.marked]), [['copy', false], ['count', false], ['flag', true]]);
  });

  test('a key that comes back does not bring its old override back until it is saved again', async () => {
    await restart(BASE_CONFIG);
    await warnings(1);
    assert.deepEqual((await served(key, s)).keys.flag, { type: 'bool', default: false, rules: [] });
    const flag = await keyOf('flag', 'shop', s);
    assert.equal(flag.problem, 'from before the key left the catalog: save it again or revert it');
    assert.equal(flag.fits, true);
    assert.deepEqual(flag.source, { default: 'catalog', rules: 'catalog' });
    assert.equal(flag.override.default, true);
    assert.equal((await set('flag', { default: true }, 'shop', s)).status, 200);
    assert.equal((await served(key, s)).keys.flag.default, true);
    assert.equal((await keyOf('flag', 'shop', s)).problem, null);
    const { rows: [row] } = await d.query("SELECT orphaned_at FROM config_overrides WHERE app = 'shop' AND key = 'flag'");
    assert.equal(row.orphaned_at, null);
  });

  test('an orphan can be deleted; its revert row has no effective values', async () => {
    const { flag, ...withoutFlag } = BASE_CONFIG;
    await restart(withoutFlag);
    await warnings(1);
    const base = (await view('shop', s)).orphans.find((o) => o.key === 'flag').change;
    const r = await admin(s.base).delete('/admin/apps/shop/config/flag', { base });
    assert.equal(r.status, 200);
    assert.equal(r.json.key, null);
    assert.deepEqual((await view('shop', s)).orphans, []);
    const { rows: [row] } = await d.query("SELECT action, override_before, override_after, effective_before, effective_after FROM config_changes WHERE app = 'shop' AND key = 'flag' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(row, { action: 'revert', override_before: { default: true }, override_after: null, effective_before: null, effective_after: null });
    const post = await admin(s.base).post('/admin/apps/shop/config/flag', { base: 0, default: true });
    assert.deepEqual([post.status, post.json], [404, { error: 'no such key in the catalog' }]);
  });
});

test('examples/catalog.example.json boots, and serves its four keys', async () => {
  const d = await freshDatabase('hush_rc_example');
  let s;
  try {
    s = await startServer(d, { CATALOG_FILE: join(ROOT, 'examples', 'catalog.example.json') });
    const key = await addApp(d, 'myapp', 'My app');
    const conf = await served(key, s);
    assert.deepEqual(Object.keys(conf.keys), ['new_home', 'paywall_copy', 'review_prompt_after', 'session_presets']);
  } finally {
    await s?.stop();
    await d.drop();
  }
});
