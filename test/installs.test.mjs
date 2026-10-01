// SDK 2's server side: forgetting an install, looking one up, build channels,
// prop keys and engagement. All additive: /v1 as shipped is unchanged.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';
import { CATALOG_FILE } from './fixtures.mjs';

let db, srv, key, otherKey;
before(async () => {
  db = await freshDatabase('hush_installs');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'braele', 'Braele');
  otherKey = await addApp(db, 'other', 'Other');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

const count = async (sql, args) => (await db.query(sql, args)).rows[0].n;

describe('POST /v1/forget', () => {
  test('deletes the install, its events and its tickets, and nothing else', async () => {
    const c = client(srv.base, key);
    const gone = uuid();
    const kept = uuid();
    await c.post('/v1/events', batch([event(gone, 'session_started'), event(gone, 'paywall_viewed'), event(kept, 'session_started')]));
    const t = await c.post('/v1/tickets', { install: gone, kind: 'issue', message: 'Please delete my data', email: 'me@example.com' });
    await c.post(`/v1/tickets/${t.json.id}/reply`, { install: gone, body: 'and the replies' });

    const r = await c.post('/v1/forget', { install: gone });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, deleted: { events: 2, tickets: 1, installs: 1 } });
    assert.equal(await count('SELECT count(*)::int AS n FROM events WHERE install = $1', [gone]), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM installs WHERE id = $1', [gone]), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM ticket_replies', []), 0, 'replies go with the ticket');
    assert.equal(await count('SELECT count(*)::int AS n FROM events WHERE install = $1', [kept]), 1);

    const again = await c.post('/v1/forget', { install: gone });
    assert.deepEqual(again.json, { ok: true, deleted: { events: 0, tickets: 0, installs: 0 } }, 'idempotent');
  });

  test("another app's key cannot forget an install that is not its own", async () => {
    const mine = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(mine, 'session_started')]));
    const r = await client(srv.base, otherKey).post('/v1/forget', { install: mine });
    assert.equal(r.status, 403);
    assert.equal(await count('SELECT count(*)::int AS n FROM installs WHERE id = $1', [mine]), 1);
  });

  test('needs a key and a valid install id', async () => {
    assert.equal((await client(srv.base).post('/v1/forget', { install: uuid() })).status, 401);
    assert.equal((await client(srv.base, key).post('/v1/forget', { install: 'nope' })).status, 400);
  });

  test('{ threads } forgets the tickets sent with an email, with their replies, in a request of its own', async () => {
    const c = client(srv.base, key);
    const ticket = { kind: 'issue', message: 'Please delete my message', email: 'me@example.com' };
    const a = (await c.post('/v1/tickets', ticket)).json;
    const b = (await c.post('/v1/tickets', ticket)).json;
    const kept = (await c.post('/v1/tickets', ticket)).json;
    await c.post(`/v1/tickets/${a.id}/reply`, { thread: a.thread, body: 'and this reply' });

    const foreign = await client(srv.base, otherKey).post('/v1/forget', { threads: [a.thread] });
    assert.deepEqual(foreign.json, { ok: true, deleted: { tickets: 0 } }, "another app's key reaches nothing");

    const r = await c.post('/v1/forget', { threads: [a.thread, b.thread] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, deleted: { tickets: 2 } });
    assert.equal(await count('SELECT count(*)::int AS n FROM tickets WHERE id = ANY($1::bigint[])', [[a.id, b.id]]), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM ticket_replies WHERE ticket_id = $1', [a.id]), 0, 'replies go with the ticket');
    assert.equal(await count('SELECT count(*)::int AS n FROM tickets WHERE id = $1', [kept.id]), 1);
    assert.deepEqual((await c.post('/v1/forget', { threads: [a.thread] })).json, { ok: true, deleted: { tickets: 0 } }, 'idempotent');

    const both = await c.post('/v1/forget', { install: uuid(), threads: [kept.thread] });
    assert.equal(both.status, 400, 'the install and the keys never travel together');
    assert.equal(await count('SELECT count(*)::int AS n FROM tickets WHERE id = $1', [kept.id]), 1);
    assert.equal((await c.post('/v1/forget', { threads: ['short'] })).status, 400);
    assert.equal((await c.post('/v1/forget', { threads: 'x' })).status, 400);
  });

  test('{ install } does not reach a ticket sent with an email', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    const t = (await c.post('/v1/tickets', { kind: 'issue', message: 'Hi', email: 'me@example.com' })).json;
    const r = await c.post('/v1/forget', { install });
    assert.equal(r.json.deleted.tickets, 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM tickets WHERE id = $1', [t.id]), 1);
  });
});

describe('one install, from the dashboard', () => {
  test('its row, latest events newest first, tickets; 404 for an unknown id', async () => {
    const c = client(srv.base, key);
    const id = uuid();
    await c.post('/v1/events', batch([event(id, 'app_first_opened'), event(id, 'screen_viewed', { props: { screen: 'Home' } })], { channel: 'testflight' }));
    const r = await admin(srv.base).get(`/admin/installs/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.install.channel, 'testflight');
    assert.equal(r.json.install.sdk, '1');
    assert.equal(r.json.events.length, 2);
    assert.equal(r.json.events[0].channel, 'testflight');
    assert.equal((await admin(srv.base).get(`/admin/installs/${uuid()}`)).status, 404);
    assert.equal((await admin(srv.base).get('/admin/installs/not-a-uuid')).status, 404);
    assert.equal((await client(srv.base).get(`/admin/installs/${id}`)).status, 401);
  });

  test('the operator can forget an install', async () => {
    const id = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(id, 'session_started')]));
    const r = await admin(srv.base).post(`/admin/installs/${id}/forget`, {});
    assert.equal(r.json.deleted.installs, 1);
    assert.equal((await admin(srv.base).get(`/admin/installs/${id}`)).status, 404);
  });
});

describe('channels, prop keys and engagement', () => {
  test('a channel that is not a plain label is not stored', async () => {
    const id = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(id, 'session_started')], { channel: 'Test Flight <3' }));
    assert.equal((await admin(srv.base).get(`/admin/installs/${id}`)).json.install.channel, null);
  });

  test('the app page filters by channel and lists the channels seen', async () => {
    const c = client(srv.base, key);
    const store = uuid();
    const tf = uuid();
    await c.post('/v1/events', batch([event(store, 'paywall_viewed')], { channel: 'app_store' }));
    await c.post('/v1/events', batch([event(tf, 'paywall_viewed'), event(tf, 'paywall_viewed')], { channel: 'testflight' }));
    const all = (await admin(srv.base).get('/admin/apps/braele?days=7')).json;
    const only = (await admin(srv.base).get('/admin/apps/braele?days=7&channel=app_store')).json;
    assert.ok(all.channels.some((x) => x.channel === 'testflight') && all.channels.some((x) => x.channel === 'app_store'));
    assert.equal(only.channel, 'app_store');
    assert.equal(only.current.active, 1);
    assert.equal(only.funnel[0].installs, 1);
    assert.ok(all.current.active > only.current.active);
    const unknown = (await admin(srv.base).get('/admin/apps/braele?days=7&channel=unknown')).json;
    assert.ok(unknown.current.active >= 1, 'installs from SDKs that send no channel');
  });

  test('prop keys of one event, most common first', async () => {
    const c = client(srv.base, key);
    const id = uuid();
    await c.post('/v1/events', batch([
      event(id, 'paywall_viewed', { props: { variant: 'b', source: 'settings' } }),
      event(id, 'paywall_viewed', { props: { variant: 'a' } }),
    ]));
    const r = await admin(srv.base).get('/admin/apps/braele/props?event=paywall_viewed&days=7');
    assert.deepEqual(r.json.keys.slice(0, 2), [{ key: 'variant', n: 2 }, { key: 'source', n: 1 }]);
    const b = await admin(srv.base).get('/admin/apps/braele/breakdown?event=paywall_viewed&prop=variant&days=7');
    assert.deepEqual(b.json.rows.find((x) => x.value === 'b'), { value: 'b', n: 1, installs: 1 });
  });

  test('session length from prev_fg_s and sessions per install', async () => {
    const c = client(srv.base, key);
    const id = uuid();
    const s = () => uuid();
    await c.post('/v1/events', batch([
      event(id, 'session_started', { session: s(), props: { entry: 'launch', n: 1 } }),
      event(id, 'session_started', { session: s(), props: { entry: 'launch', n: 2, prev_fg_s: 60 } }),
      event(id, 'session_started', { session: s(), props: { entry: 'widget', n: 3, prev_fg_s: 120 } }),
      event(id, 'session_started', { session: s(), props: { entry: 'launch', n: 4, prev_fg_s: 'not a number' } }),
    ]));
    const e = (await admin(srv.base).get('/admin/apps/braele?days=7')).json.engagement;
    assert.equal(e.measured, 2);
    assert.equal(e.median_s, 90);
    assert.ok(e.sessions_per_install >= 1);
    assert.equal(e.sessions_histogram.length, 5);
    assert.ok(e.sessions_histogram[2] >= 1, 'this install had four sessions');
  });
});
