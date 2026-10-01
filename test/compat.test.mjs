// The phone-facing contract, frozen. Every /v1 response an app can see, for a
// fixed script of requests, compared against a snapshot recorded from the
// server that shipped apps were built against (bavrk telemetry, 2026-09-29).
// Ids and timestamps are normalized; everything else must match exactly.
//
// A change here breaks apps already in users' hands, which cannot be
// redeployed. Regenerate the snapshot (UPDATE_SNAPSHOTS=1) only for a change
// that every shipped SDK handles, and say why in the commit.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { addApp, admin, batch, client, event, freshDatabase, startServer } from './helpers.mjs';
import { CATALOG_FILE } from './fixtures.mjs';

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), '__snapshots__', 'v1-compat.json');

let db, srv, key, otherKey;
before(async () => {
  db = await freshDatabase('hush_compat');
  srv = await startServer(db, { CATALOG_FILE, COUNTRY_HEADER: 'cf-ipcountry' });
  key = await addApp(db, 'braele', 'Braele');
  otherKey = await addApp(db, 'other', 'Other');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

// Fixed ids so the script is the same every run; normalization handles the rest.
const INSTALL = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const fixed = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ev = (n, name, props) => ({ ...event(INSTALL, name, { props }), id: fixed(n), session: fixed(900) });

function normalize(value) {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/"\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})"/g, '"<time>"')
      .replace(/"(id)":"?\d+"?/g, '"$1":"<id>"')
      .replace(/"thread":"[A-Za-z0-9_-]{43}"/g, '"thread":"<thread>"'),
  );
}

test('the /v1 surface answers exactly as shipped apps expect', async () => {
  const c = client(srv.base, key);
  const steps = [];
  const step = async (label, promise) => {
    const r = await promise;
    steps.push({ label, status: r.status, body: normalize(r.json ?? r.text) });
    return r;
  };

  await step('events: no key', client(srv.base).post('/v1/events', batch([ev(1, 'session_started')])));
  await step('events: valid batch', c.post('/v1/events', batch([ev(1, 'app_first_opened'), ev(2, 'session_started'), ev(3, 'breathing_session_completed', { completed: true })], { pro: true }), { 'CF-IPCountry': 'DE' }));
  await step('events: retried batch', c.post('/v1/events', batch([ev(1, 'app_first_opened'), ev(2, 'session_started')])));
  await step('events: partly malformed', c.post('/v1/events', batch([ev(4, 'session_started'), { ...ev(5, 'x'), id: 'bad' }])));
  await step('events: nothing valid', c.post('/v1/events', batch([{ id: 'bad' }])));
  await step('events: empty', c.post('/v1/events', batch([])));
  await step('events: not json', c.post('/v1/events', '{nope'));
  await step('events: not an object', c.post('/v1/events', '[]'));

  const t = await step('tickets: create', c.post('/v1/tickets', { install: INSTALL, kind: 'issue', rc_id: null, message: 'Timer stops', diag: { version: '2.0.1', pro: true } }));
  await step('tickets: invalid email', c.post('/v1/tickets', { install: INSTALL, message: 'x', email: 'nope' }));
  await step('tickets: invalid install', c.post('/v1/tickets', { install: 'nope', message: 'x' }));
  await step('tickets: list', c.get(`/v1/tickets?install=${INSTALL}`));
  await step('tickets: list, bad install', c.get('/v1/tickets?install=nope'));
  await step('tickets: list, other app', client(srv.base, otherKey).get(`/v1/tickets?install=${INSTALL}`));
  await admin(srv.base).post(`/admin/tickets/${t.json.id}/reply`, { body: 'Fixed in 2.0.2.' });
  await step('tickets: list after support reply (unread)', c.get(`/v1/tickets?install=${INSTALL}`));
  await step('tickets: list again (read)', c.get(`/v1/tickets?install=${INSTALL}`));
  await step('tickets: user reply', c.post(`/v1/tickets/${t.json.id}/reply`, { install: INSTALL, body: 'Thanks' }));
  await step('tickets: reply, empty body', c.post(`/v1/tickets/${t.json.id}/reply`, { install: INSTALL, body: '' }));
  await step('tickets: reply, wrong install', c.post(`/v1/tickets/${t.json.id}/reply`, { install: FOREIGN, body: 'hi' }));
  await admin(srv.base).post(`/admin/tickets/${t.json.id}/status`, { status: 'closed' });
  await step('tickets: reply on closed', c.post(`/v1/tickets/${t.json.id}/reply`, { install: INSTALL, body: 'late' }));
  await step('unknown route', c.get('/v1/nothing'));
  await step('healthz', client(srv.base).get('/healthz'));

  // Added with SDK 2.3.0 (2026-10-01): a ticket with an email is not linked
  // to the install. Every step above is unchanged; these are new paths and
  // new fields, from a second caller so the per-address ticket limit of the
  // first is not in play.
  const n = client(srv.base, key);
  const OLD = '33333333-3333-4333-8333-333333333333';
  const u = await step('tickets: create with an email, no install', n.post('/v1/tickets', { kind: 'issue', email: 'sam@example.com', message: 'Write back', diag: { version: '2.3.0', pro: false } }));
  await step('tickets: no install and no email', n.post('/v1/tickets', { kind: 'issue', message: 'x' }));
  const o = await step('tickets: an older app with an email and its install', n.post('/v1/tickets', { install: OLD, kind: 'issue', rc_id: '$RCAnonymousID:x', email: 'old@example.com', message: 'Old app' }));
  await step('tickets: an older app lists it by install', n.get(`/v1/tickets?install=${OLD}`));
  // Closing it must not take it out of that app's inbox before it has shown
  // the closing reply, and a late reply there is a 409, as on any ticket.
  await admin(srv.base).post(`/admin/tickets/${o.json.id}/reply`, { body: 'Fixed.', close: true });
  await step('tickets: an older app lists it after a closing reply', n.get(`/v1/tickets?install=${OLD}`));
  await step('tickets: an older app replies on it once closed', n.post(`/v1/tickets/${o.json.id}/reply`, { install: OLD, body: 'Thanks' }));
  // SDK 2.3.0 lists an install's own tickets with the install in the body.
  const LISTED = '44444444-4444-4444-8444-444444444444';
  await n.post('/v1/tickets', { install: LISTED, kind: 'feature', message: 'Listed by POST' });
  await step('tickets: list by install in the body', n.post('/v1/tickets/list', { install: LISTED }));
  await step('tickets: list by install in the body, invalid', n.post('/v1/tickets/list', { install: 'nope' }));
  await admin(srv.base).post(`/admin/tickets/${u.json.id}/reply`, { body: 'Thanks, looking.' });
  await step('tickets: threads list (unread)', n.post('/v1/tickets/threads', { threads: [u.json.thread] }));
  await step('tickets: threads list, other app', client(srv.base, otherKey).post('/v1/tickets/threads', { threads: [u.json.thread] }));
  await step('tickets: threads list, invalid', n.post('/v1/tickets/threads', { threads: 'nope' }));
  await step('tickets: reply by thread', n.post(`/v1/tickets/${u.json.id}/reply`, { thread: u.json.thread, body: 'Still broken' }));
  await step('tickets: reply, wrong thread', n.post(`/v1/tickets/${u.json.id}/reply`, { thread: 'A'.repeat(43), body: 'hi' }));
  await step('tickets: reply, invalid thread', n.post(`/v1/tickets/${u.json.id}/reply`, { thread: 'nope', body: 'hi' }));
  await step('forget: install and threads together', n.post('/v1/forget', { install: OLD, threads: [u.json.thread] }));
  await step('forget: threads', n.post('/v1/forget', { threads: [u.json.thread] }));
  await step('forget: install', n.post('/v1/forget', { install: OLD }));

  if (!existsSync(SNAPSHOT) || process.env.UPDATE_SNAPSHOTS === '1') {
    writeFileSync(SNAPSHOT, `${JSON.stringify(steps, null, 2)}\n`);
    console.log(`snapshot written: ${SNAPSHOT}`);
    return;
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  assert.deepEqual(steps, expected);
});
