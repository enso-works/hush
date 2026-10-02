// Install retention: an install that has sent nothing for
// INSTALL_RETENTION_DAYS (RETENTION_DAYS unless set, 0 = off) loses its row
// in the sweep. Nothing that names the install id breaks: its tickets without
// an email stay answerable, and listed when it comes back.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';
import { CATALOG_FILE } from './fixtures.mjs';

let db, srv, key, otherKey, inProcess;
before(async () => {
  db = await freshDatabase('hush_retention');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'braele', 'Braele');
  otherKey = await addApp(db, 'other', 'Other');
  // The server's sweep in this process, against this file's database, with
  // the defaults (RETENTION_DAYS 180, INSTALL_RETENTION_DAYS unset).
  process.env.DATABASE_URL = db.url;
  delete process.env.RETENTION_DAYS;
  delete process.env.INSTALL_RETENTION_DAYS;
  inProcess = { sweep: await import('../src/sweep.mjs'), db: await import('../src/db.mjs') };
});
after(async () => {
  await srv?.stop();
  await inProcess?.db.pool.end();
  await db?.drop();
});

const count = async (sql, args) => (await db.query(sql, args)).rows[0].n;
const hasRow = async (install) => (await count('SELECT count(*)::int AS n FROM installs WHERE id = $1', [install])) === 1;
// An install whose last batch, and every event, is `days` old.
async function quietFor(install, days) {
  await db.query("UPDATE installs SET first_seen = now() - make_interval(days => $2 + 10), last_seen = now() - make_interval(days => $2) WHERE id = $1", [install, days]);
  await db.query('UPDATE events SET at = now() - make_interval(days => $2), received_at = now() - make_interval(days => $2) WHERE install = $1', [install, days]);
}

describe('the sweep', () => {
  test('deletes an install quiet for RETENTION_DAYS, with its events gone too; keeps one seen inside the window', async () => {
    const c = client(srv.base, key);
    const gone = uuid();
    const kept = uuid();
    await c.post('/v1/events', batch([event(gone, 'session_started'), event(kept, 'session_started')]));
    await quietFor(gone, 181);
    await quietFor(kept, 179);
    await inProcess.sweep.sweep();
    assert.equal(await hasRow(gone), false);
    assert.equal(await count('SELECT count(*)::int AS n FROM events WHERE install = $1', [gone]), 0);
    assert.equal(await hasRow(kept), true);
    assert.equal(await count('SELECT count(*)::int AS n FROM events WHERE install = $1', [kept]), 1);
  });

  test('an event dated inside the window keeps the row, whatever last_seen says', async () => {
    const install = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(install, 'session_started')]));
    await db.query("UPDATE installs SET last_seen = now() - interval '200 days' WHERE id = $1", [install]);
    assert.equal(await inProcess.sweep.deleteIdleInstalls(), 0);
    assert.equal(await hasRow(install), true);
  });

  test('0 turns it off', async () => {
    const install = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(install, 'session_started')]));
    await quietFor(install, 400);
    assert.equal(await inProcess.sweep.deleteIdleInstalls(0), 0);
    assert.equal(await hasRow(install), true);
    assert.equal(await inProcess.sweep.deleteIdleInstalls(), 1, 'the default still applies');
  });
});

describe('what names the install id', () => {
  test('its tickets without an email: answered by the operator, listed when it comes back, forgotten by it', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    const t = (await c.post('/v1/tickets', { install, kind: 'issue', message: 'The timer stops.' })).json;
    await quietFor(install, 181);
    await inProcess.sweep.sweep();
    assert.equal(await hasRow(install), false);

    // The operator still sees the ticket with its install, and can answer it.
    const ticket = (await admin(srv.base).get(`/admin/tickets/${t.id}`)).json;
    assert.equal(ticket.install, install);
    assert.equal((await admin(srv.base).post(`/admin/tickets/${t.id}/reply`, { body: 'Fixed in 2.1.0.' })).status, 200);
    // Its install page lists the ticket, with no row.
    const page = (await admin(srv.base).get(`/admin/installs/${install}`)).json;
    assert.equal(page.install, null);
    assert.deepEqual(page.tickets.map((x) => String(x.id)), [String(t.id)]);

    // The app lists it by the install id, row or not, and the reply is unread.
    const listed = (await c.post('/v1/tickets/list', { install })).json.tickets;
    assert.deepEqual(listed.map((x) => [String(x.id), x.unread]), [[String(t.id), true]]);
    // It comes back: a new row, counted as new from today; the ticket is still there.
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    assert.equal(await hasRow(install), true);
    assert.equal((await db.query("SELECT first_seen > now() - interval '1 hour' AS fresh FROM installs WHERE id = $1", [install])).rows[0].fresh, true);
    assert.equal((await c.post(`/v1/tickets/${t.id}/reply`, { install, body: 'Thanks, it works.' })).status, 201);
    assert.equal((await c.get(`/v1/tickets?install=${install}`)).json.tickets.length, 1);

    // forget() reaches it either way.
    await quietFor(install, 181);
    await inProcess.sweep.sweep();
    assert.deepEqual((await c.post('/v1/forget', { install })).json, { ok: true, deleted: { events: 0, tickets: 1, installs: 0 } });
  });

  test("with the row gone, another app's key still reaches nothing of it", async () => {
    const install = uuid();
    const c = client(srv.base, key);
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    const t = (await c.post('/v1/tickets', { install, kind: 'issue', message: 'Mine.' })).json;
    await quietFor(install, 181);
    await inProcess.sweep.sweep();
    const foreign = client(srv.base, otherKey);
    assert.deepEqual((await foreign.post('/v1/tickets/list', { install })).json, { tickets: [] });
    assert.equal((await foreign.post(`/v1/tickets/${t.id}/reply`, { install, body: 'hi' })).status, 404);
    assert.deepEqual((await foreign.post('/v1/forget', { install })).json.deleted, { events: 0, tickets: 0, installs: 0 });
    assert.equal(await count('SELECT count(*)::int AS n FROM tickets WHERE id = $1', [t.id]), 1);
  });

  test("an older app's ticket with an email keeps its own rule", async () => {
    const c = client(srv.base, key);
    const install = uuid();
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    const t = (await c.post('/v1/tickets', { install, kind: 'issue', email: 'old@example.com', message: 'Old app.' })).json;
    await quietFor(install, 181);
    await inProcess.sweep.sweep();
    assert.equal(await hasRow(install), false);
    // Still listed for that app's inbox until the unlink rule clears it (30 idle days from the ticket).
    assert.deepEqual((await c.get(`/v1/tickets?install=${install}`)).json.tickets.map((x) => String(x.id)), [String(t.id)]);
  });
});

describe('the dashboard', () => {
  test('new installs and retention count only the installs first seen inside the window, so a year does not flatter the app', async () => {
    const c = client(srv.base, await addApp(db, 'cut', 'Cut'));
    // One of a cohort from 300 days ago that came back 5 days ago: the rest
    // of it went quiet and lost its rows. From 100 days ago, one that never
    // came back and one that did 50 days later.
    const old = uuid();
    const left = uuid();
    const stayed = uuid();
    const at = async (install, days) => {
      const e = event(install, 'session_started');
      await c.post('/v1/events', batch([e]));
      await db.query('UPDATE events SET at = now() - make_interval(days => $2) WHERE id = $1', [e.id, days]);
    };
    await at(old, 5);
    await at(left, 100);
    await at(stayed, 100);
    await at(stayed, 50);
    for (const [install, days] of [[old, 300], [left, 100], [stayed, 100]]) {
      await db.query('UPDATE installs SET first_seen = now() - make_interval(days => $2) WHERE id = $1', [install, days]);
    }

    const year = (await admin(srv.base).get('/admin/apps/cut?days=365')).json;
    assert.deepEqual(year.retention.d30, { cohort: 2, retained: 1 });
    assert.equal(year.current.new_installs, 2);
    assert.equal(year.prior.new_installs, 0);
    assert.equal(year.daily.reduce((n, d) => n + d.new_installs, 0), 2);
    const overview = (await admin(srv.base).get('/admin/apps?days=365')).json.apps.find((a) => a.app === 'cut');
    assert.deepEqual([overview.new_installs, overview.total_installs], [2, 3]);
    // A period inside the window is its own bound, as before.
    assert.deepEqual((await admin(srv.base).get('/admin/apps/cut?days=90')).json.retention.d30, { cohort: 0, retained: 0 });
    assert.deepEqual((await admin(srv.base).get('/admin/apps/cut?days=150')).json.retention.d30, { cohort: 2, retained: 1 });
  });
});

describe('configuration', () => {
  const retention = async (env) => {
    const d = await freshDatabase('hush_retention_cfg');
    const s = await startServer(d, env);
    try {
      const days = (await admin(s.base).get('/admin/apps')).json.install_retention_days;
      const listening = () => s.logs.join('').split('\n').find((l) => l.includes('hush listening'));
      for (let i = 0; i < 20 && !listening(); i++) await new Promise((r) => setTimeout(r, 50));
      const line = listening();
      const logs = s.logs.join('');
      return {
        days,
        logged: JSON.parse(line).installRetentionDays,
        warned: logs.includes('install retention is off'),
        ...(logs.includes('INSTALL_RETENTION_DAYS is shorter than RETENTION_DAYS') && { shorter: true }),
      };
    } finally {
      await s.stop();
      await d.drop();
    }
  };

  test('RETENTION_DAYS by default, INSTALL_RETENTION_DAYS over it, 0 off; the dashboard is told', async () => {
    assert.deepEqual(await retention({}), { days: 180, logged: 180, warned: false });
    assert.deepEqual(await retention({ RETENTION_DAYS: '90' }), { days: 90, logged: 90, warned: false });
    assert.deepEqual(await retention({ RETENTION_DAYS: '90', INSTALL_RETENTION_DAYS: '365' }), { days: 365, logged: 365, warned: false });
    assert.deepEqual(await retention({ INSTALL_RETENTION_DAYS: '0' }), { days: null, logged: 'off', warned: false });
    // Empty, as docker compose passes an unset variable: the default.
    assert.deepEqual(await retention({ INSTALL_RETENTION_DAYS: '' }), { days: 180, logged: 180, warned: false });
    assert.deepEqual(await retention({ INSTALL_RETENTION_DAYS: '180d' }), { days: null, logged: 'off', warned: true });
  });

  test('a window shorter than RETENTION_DAYS is kept, with a warning: rows go before their events', async () => {
    assert.deepEqual(await retention({ INSTALL_RETENTION_DAYS: '30' }), { days: 30, logged: 30, warned: false, shorter: true });
    assert.deepEqual(await retention({ RETENTION_DAYS: '30', INSTALL_RETENTION_DAYS: '30' }), { days: 30, logged: 30, warned: false });
  });
});
