// /admin/*: the read side a dashboard is built on, behind the admin token.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { ADMIN_TOKEN, addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';
import { CATALOG_FILE } from './fixtures.mjs';

let db, srv, key;

before(async () => {
  db = await freshDatabase('hush_admin');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'braele', 'Braele');
  const c = client(srv.base, key);
  const a = uuid();
  const b = uuid();
  await c.post('/v1/events', batch([
    event(a, 'app_first_opened'),
    event(a, 'session_started'),
    event(a, 'breathing_session_completed', { props: { completed: true, pattern: 'box' } }),
    event(a, 'breathing_session_completed', { props: { completed: false, pattern: '478' } }),
    event(a, 'paywall_viewed'),
    event(a, 'purchase_started'),
    event(a, 'purchase_result', { props: { result: 'purchased' } }),
  ]));
  await c.post('/v1/events', batch([event(b, 'session_started'), event(b, 'mystery_event')], { version: '2.0.0' }));
  await c.post('/v1/tickets', { install: a, kind: 'love', message: 'Lovely app' });
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

describe('auth', () => {
  test('no token or a wrong one is 401', async () => {
    assert.equal((await client(srv.base).get('/admin/apps')).status, 401);
    assert.equal((await client(srv.base, 'Bearer wrong').get('/admin/apps')).status, 401);
  });

  test('20 wrong tokens a minute from one address, then 429, and the right token still works', async () => {
    const ip = '203.0.113.77';
    const guesser = client(srv.base, 'Bearer guess', { ip });
    for (let i = 0; i < 20; i++) assert.equal((await guesser.get('/admin/apps')).status, 401);
    assert.equal((await guesser.get('/admin/apps')).status, 429);
    assert.equal((await client(srv.base, 'Bearer hush_dev_madeup', { ip }).get('/admin/apps')).status, 429);
    assert.equal((await client(srv.base, `Bearer ${ADMIN_TOKEN}`, { ip }).get('/admin/apps')).status, 200);
    assert.equal((await client(srv.base, 'Bearer guess').get('/admin/apps')).status, 401, 'another address is not limited');
  });

  test("the dashboard's first question, asked without a token, does not count", async () => {
    const page = client(srv.base, undefined, { ip: '203.0.113.78' });
    for (let i = 0; i < 25; i++) assert.equal((await page.get('/admin/session')).status, 401);
  });
});

describe('reads', () => {
  test('the portfolio lists every app with its counters', async () => {
    const r = await admin(srv.base).get('/admin/apps');
    assert.equal(r.status, 200);
    const b = r.json.apps.find((x) => x.app === 'braele');
    assert.equal(b.total_installs, 2);
    assert.equal(b.events, 9);
    assert.equal(b.open_tickets, 1);
    assert.equal(b.dau, 2);
    // Active installs per day for the overview's sparkline, today last.
    const week = (await admin(srv.base).get('/admin/apps?days=7')).json.apps.find((x) => x.app === 'braele');
    assert.equal(week.trend.length, 7);
    assert.equal(week.trend.at(-1), 2);
  });

  test('one app: funnel, versions, unknown events, highlight counts', async () => {
    const r = await admin(srv.base).get('/admin/apps/braele?days=7');
    assert.equal(r.status, 200);
    const d = r.json;
    assert.deepEqual(d.funnel, [
      { name: 'paywall_viewed', installs: 1 },
      { name: 'purchase_started', installs: 1 },
      { name: 'purchase_result', installs: 1 },
      { name: 'purchased', installs: 1 },
    ]);
    assert.deepEqual(d.unknown, [{ name: 'mystery_event', n: 1 }]);
    assert.deepEqual(d.versions.map((v) => v.version).sort(), ['2.0.0', '2.0.1']);
    // The app's highlight event (Braele: breathing sessions, and how many
    // ran to the end), however the server names the pair.
    const count = d.current.highlight ?? d.current.breaths;
    const done = d.current.highlight_done ?? d.current.breaths_done;
    assert.equal(count, 2);
    assert.equal(done, 1);
    assert.equal(d.daily.length, 7);
  });

  test('a breakdown slices one event by one prop', async () => {
    const r = await admin(srv.base).get('/admin/apps/braele/breakdown?event=breathing_session_completed&prop=pattern&days=7');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.rows.map((x) => x.value).sort(), ['478', 'box']);
  });

  test('the ticket inbox, one ticket, and its status', async () => {
    const list = await admin(srv.base).get('/admin/tickets');
    assert.equal(list.status, 200);
    assert.equal(list.json.tickets.length, 1);
    const one = await admin(srv.base).get(`/admin/tickets/${list.json.tickets[0].id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.kind, 'love');
    const st = await admin(srv.base).post(`/admin/tickets/${list.json.tickets[0].id}/status`, { status: 'closed' });
    assert.equal(st.status, 200);
    assert.equal((await admin(srv.base).get('/admin/tickets?status=open')).json.tickets.length, 0);
  });

  test('unknown ticket is 404', async () => {
    assert.equal((await admin(srv.base).get('/admin/tickets/999999')).status, 404);
  });
});
