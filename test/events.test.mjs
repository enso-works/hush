// POST /v1/events: what a shipped app depends on. The Expo SDK drops a batch
// on any 2xx and on any 4xx except 429, and retries on 429, 5xx and network
// errors, so these status codes are a contract, not a detail.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { addApp, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';
import { CATALOG_FILE } from './fixtures.mjs';

let db, srv, key, otherKey;

before(async () => {
  db = await freshDatabase('hush_events');
  srv = await startServer(db, { CATALOG_FILE, COUNTRY_HEADER: 'cf-ipcountry' });
  key = await addApp(db, 'braele', 'Braele');
  otherKey = await addApp(db, 'other', 'Other');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

describe('authentication', () => {
  test('no key is 401', async () => {
    const r = await client(srv.base).post('/v1/events', batch([event(uuid(), 'session_started')]));
    assert.equal(r.status, 401);
  });
  test('an unknown key is 401', async () => {
    const r = await client(srv.base, 'bvk_demo_prod_nope').post('/v1/events', batch([event(uuid(), 'session_started')]));
    assert.equal(r.status, 401);
  });
  test('a revoked key is refused', async () => {
    const k = await addApp(db, 'braele');
    await db.query("UPDATE write_keys SET revoked_at = now() WHERE label = 'test' AND app = 'braele' AND id = (SELECT max(id) FROM write_keys)");
    // The cache would hide a revocation for up to a minute; a fresh key was
    // never looked up, so its first request sees the revoked row.
    const r = await client(srv.base, k).post('/v1/events', batch([event(uuid(), 'session_started')]));
    assert.equal(r.status, 401);
  });
});

describe('ingest', () => {
  test('a valid batch is stored and counted', async () => {
    const install = uuid();
    const r = await client(srv.base, key).post('/v1/events', batch([event(install, 'app_first_opened'), event(install, 'session_started')]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { accepted: 2, duplicate: 0, rejected: 0 });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM events WHERE install = $1', [install]);
    assert.equal(rows[0].n, 2);
  });

  test('a retried batch is counted as duplicate, not stored twice', async () => {
    const install = uuid();
    const body = batch([event(install, 'session_started'), event(install, 'screen_viewed')]);
    await client(srv.base, key).post('/v1/events', body);
    const r = await client(srv.base, key).post('/v1/events', body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { accepted: 0, duplicate: 2, rejected: 0 });
  });

  test('malformed events are dropped, the rest of the batch lands', async () => {
    const install = uuid();
    const good = event(install, 'session_started');
    const badId = { ...event(install, 'session_started'), id: 'not-a-uuid' };
    const badName = event(install, 'Bad-Name');
    const tooOld = { ...event(install, 'session_started'), at: new Date(Date.now() - 40 * 86400000).toISOString() };
    const nested = event(install, 'feature_used', { props: { deep: { x: 1 } } });
    const r = await client(srv.base, key).post('/v1/events', batch([good, badId, badName, tooOld, nested]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { accepted: 1, duplicate: 0, rejected: 4 });
  });

  test('a batch with nothing valid is 400 (the SDK drops it)', async () => {
    const r = await client(srv.base, key).post('/v1/events', batch([{ id: 'x' }]));
    assert.equal(r.status, 400);
  });

  test('empty, oversized and non-JSON bodies are 4xx', async () => {
    const c = client(srv.base, key);
    assert.equal((await c.post('/v1/events', batch([]))).status, 400);
    const many = Array.from({ length: 101 }, () => event(uuid(), 'session_started'));
    assert.equal((await c.post('/v1/events', batch(many))).status, 400);
    assert.equal((await c.post('/v1/events', '{not json')).status, 400);
    const huge = batch([event(uuid(), 'feature_used', { props: { s: 'x'.repeat(200) } })]);
    huge.pad = 'y'.repeat(70 * 1024);
    assert.equal((await c.post('/v1/events', huge)).status, 413);
  });

  test('catalog events are known, anything else is stored but flagged', async () => {
    const install = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(install, 'breathing_session_started'), event(install, 'something_new')]));
    const { rows } = await db.query('SELECT name, known FROM events WHERE install = $1 ORDER BY name', [install]);
    assert.deepEqual(rows, [
      { name: 'breathing_session_started', known: true },
      { name: 'something_new', known: false },
    ]);
  });

  test('the common lifecycle names are known for every app, catalog or not', async () => {
    const install = uuid();
    await client(srv.base, otherKey).post('/v1/events', batch([event(install, 'paywall_viewed')]));
    const { rows } = await db.query('SELECT known FROM events WHERE install = $1', [install]);
    assert.equal(rows[0].known, true);
  });
});

describe('the install row', () => {
  test('context and country land on the install', async () => {
    const install = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(install, 'session_started')], { locale: 'de-DE' }), { 'CF-IPCountry': 'DE' });
    const { rows } = await db.query('SELECT app, env, platform, version, build, locale, country FROM installs WHERE id = $1', [install]);
    assert.deepEqual(rows[0], { app: 'braele', env: 'prod', platform: 'ios', version: '2.0.1', build: '15', locale: 'de-DE', country: 'DE' });
  });

  test('pro is tri-state: missing never downgrades, only an explicit false does', async () => {
    const install = uuid();
    const c = client(srv.base, key);
    const pro = async () => (await db.query('SELECT pro FROM installs WHERE id = $1', [install])).rows[0].pro;
    await c.post('/v1/events', batch([event(install, 'session_started')], { pro: true }));
    assert.equal(await pro(), true);
    await c.post('/v1/events', batch([event(install, 'session_started')], {}));
    assert.equal(await pro(), true, 'a batch without pro must not downgrade');
    await c.post('/v1/events', batch([event(install, 'session_started')], { pro: false }));
    assert.equal(await pro(), false);
  });

  test('first_seen moves back for events queued offline', async () => {
    const install = uuid();
    const c = client(srv.base, key);
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    const earlier = { ...event(install, 'session_started'), at: new Date(Date.now() - 3 * 86400000).toISOString() };
    await c.post('/v1/events', batch([earlier]));
    const { rows } = await db.query("SELECT first_seen < now() - interval '2 days' AS moved FROM installs WHERE id = $1", [install]);
    assert.equal(rows[0].moved, true);
  });
});
