// Support tickets: the app sends one, lists its own, reads replies, answers.
// The SDK maps 429 to "too many", 409 to "closed" and needs `id` back.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';
import { CATALOG_FILE } from './fixtures.mjs';

let db, srv, key, otherKey;

before(async () => {
  db = await freshDatabase('hush_tickets');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'braele', 'Braele');
  otherKey = await addApp(db, 'other', 'Other');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

const ticket = (install, extra = {}) => ({
  install,
  kind: 'issue',
  rc_id: null,
  message: 'The timer stops when the screen locks.',
  diag: { version: '2.0.1', build: '15', os: 'ios 18.6', device: 'iPhone17,1', pro: false },
  ...extra,
});

describe('creating', () => {
  test('201 with the id the app opens next', async () => {
    const r = await client(srv.base, key).post('/v1/tickets', ticket(uuid(), { email: 'a@example.com', subject: 'Timer' }));
    assert.equal(r.status, 201);
    // A bigint, so it arrives as a numeric string; the SDK stringifies it anyway.
    assert.match(String(r.json.id), /^[0-9]+$/);
    assert.equal(r.json.status, 'open');
    assert.ok(r.json.created_at);
  });

  test('an old app version without kind files an issue', async () => {
    const install = uuid();
    const body = ticket(install);
    delete body.kind;
    const r = await client(srv.base, key).post('/v1/tickets', body);
    assert.equal(r.status, 201);
    const { rows } = await db.query('SELECT kind FROM tickets WHERE id = $1', [r.json.id]);
    assert.equal(rows[0].kind, 'issue');
  });

  test('bad input is 400', async () => {
    const c = client(srv.base, key);
    assert.equal((await c.post('/v1/tickets', ticket('nope'))).status, 400);
    assert.equal((await c.post('/v1/tickets', ticket(uuid(), { message: '' }))).status, 400);
    assert.equal((await c.post('/v1/tickets', ticket(uuid(), { email: 'not an email' }))).status, 400);
    assert.equal((await c.post('/v1/tickets', ticket(uuid(), { kind: 'rant' }))).status, 400);
    assert.equal((await c.post('/v1/tickets', ticket(uuid(), { diag: { nested: { x: 1 } } }))).status, 400);
  });

  test('five a day per install, even when they arrive at once', async () => {
    const install = uuid();
    const c = client(srv.base, key);
    const codes = await Promise.all(Array.from({ length: 8 }, () => c.post('/v1/tickets', ticket(install)).then((r) => r.status)));
    assert.equal(codes.filter((s) => s === 201).length, 5);
    assert.equal(codes.filter((s) => s === 429).length, 3);
  });

  test('an install id that belongs to another app is refused', async () => {
    const install = uuid();
    await client(srv.base, otherKey).post('/v1/events', batch([event(install, 'session_started')]));
    const r = await client(srv.base, key).post('/v1/tickets', ticket(install));
    assert.equal(r.status, 403);
  });
});

describe('the thread', () => {
  test('an app lists only its own install tickets, never another app\'s', async () => {
    const install = uuid();
    await client(srv.base, key).post('/v1/tickets', ticket(install));
    const own = await client(srv.base, key).get(`/v1/tickets?install=${install}`);
    assert.equal(own.status, 200);
    assert.equal(own.json.tickets.length, 1);
    const foreign = await client(srv.base, otherKey).get(`/v1/tickets?install=${install}`);
    assert.deepEqual(foreign.json, { tickets: [] });
  });

  test('a support reply is unread once, then read', async () => {
    const install = uuid();
    const { json } = await client(srv.base, key).post('/v1/tickets', ticket(install));
    const r = await admin(srv.base).post(`/admin/tickets/${json.id}/reply`, { body: 'Fixed in 2.0.2.' });
    assert.equal(r.status, 200);
    const first = await client(srv.base, key).get(`/v1/tickets?install=${install}`);
    assert.equal(first.json.tickets[0].unread, true);
    assert.equal(first.json.tickets[0].status, 'answered');
    assert.deepEqual(first.json.tickets[0].replies.map((x) => [x.author, x.body]), [['support', 'Fixed in 2.0.2.']]);
    const second = await client(srv.base, key).get(`/v1/tickets?install=${install}`);
    assert.equal(second.json.tickets[0].unread, false);
  });

  test('the user can answer, which reopens it; a closed thread refuses with 409', async () => {
    const install = uuid();
    const c = client(srv.base, key);
    const { json } = await c.post('/v1/tickets', ticket(install));
    await admin(srv.base).post(`/admin/tickets/${json.id}/reply`, { body: 'Can you send a screenshot?' });
    const reply = await c.post(`/v1/tickets/${json.id}/reply`, { install, body: 'Sent by email.' });
    assert.equal(reply.status, 201);
    assert.equal(reply.json.status, 'open');
    await admin(srv.base).post(`/admin/tickets/${json.id}/status`, { status: 'closed' });
    const late = await c.post(`/v1/tickets/${json.id}/reply`, { install, body: 'One more thing' });
    assert.equal(late.status, 409);
  });

  test('replying on someone else\'s ticket is 404', async () => {
    const { json } = await client(srv.base, key).post('/v1/tickets', ticket(uuid()));
    const r = await client(srv.base, key).post(`/v1/tickets/${json.id}/reply`, { install: uuid(), body: 'hi' });
    assert.equal(r.status, 404);
  });
});
