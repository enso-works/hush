// Support tickets: the app sends one, lists its own, reads replies, answers.
// The SDK maps 429 to "too many", 409 to "closed" and needs `id` back.
//
// A ticket with an email is not linked to the install: SDK 2.3.0 sends it
// without one and holds a thread key instead; older app versions still send
// the install, which the server keeps only as long as their inbox needs it.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';
import { CATALOG_FILE } from './fixtures.mjs';

let db, srv, key, otherKey;

before(async () => {
  db = await freshDatabase('hush_tickets');
  // ALERT_EMAIL set: the alert mails are logged (MAIL_DRY_RUN), and the log is checked at the end.
  srv = await startServer(db, { CATALOG_FILE, ALERT_EMAIL: 'ops@example.com' });
  key = await addApp(db, 'braele', 'Braele');
  otherKey = await addApp(db, 'other', 'Other');
});
after(async () => {
  await srv?.stop();
  await inProcess?.db.pool.end();
  await db?.drop();
});

// The server's periodic unlink sweep, run in this process against this
// file's database.
let inProcess;
async function sweep() {
  if (!inProcess) {
    process.env.DATABASE_URL = db.url;
    inProcess = { tickets: await import('../src/tickets.mjs'), db: await import('../src/db.mjs') };
  }
  return inProcess.tickets.unlinkOldClientTickets();
}

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

  test('POST /v1/tickets/list answers like the GET, with the install in the body instead of the URL', async () => {
    const install = uuid();
    const c = client(srv.base, key);
    const { json } = await c.post('/v1/tickets', ticket(install));
    await admin(srv.base).post(`/admin/tickets/${json.id}/reply`, { body: 'Thanks.' });
    const r = await c.post('/v1/tickets/list', { install });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.tickets.map((t) => [String(t.id), t.unread]), [[String(json.id), true]]);
    assert.equal((await c.get(`/v1/tickets?install=${install}`)).json.tickets[0].unread, false, 'read the same way');
    assert.deepEqual((await client(srv.base, otherKey).post('/v1/tickets/list', { install })).json, { tickets: [] });
    assert.deepEqual((await c.post('/v1/tickets/list', { install: 'nope' })).json, { error: 'invalid install' });
    assert.equal((await c.post('/v1/tickets/list', {})).status, 400);
    assert.equal((await client(srv.base).post('/v1/tickets/list', { install })).status, 401);
  });

  test('replying on someone else\'s ticket is 404', async () => {
    const { json } = await client(srv.base, key).post('/v1/tickets', ticket(uuid()));
    const r = await client(srv.base, key).post(`/v1/tickets/${json.id}/reply`, { install: uuid(), body: 'hi' });
    assert.equal(r.status, 404);
  });
});

// What SDK 2.3.0 sends for a ticket with an email: no install, no customer id.
const withEmail = (extra = {}) => ({
  kind: 'issue',
  email: 'sam@example.com',
  subject: 'Timer',
  message: 'The timer stops when the screen locks. Please write back.',
  diag: { version: '2.3.0', build: '20', os: 'ios 18.6', device: 'iPhone17,1', pro: true },
  ...extra,
});
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const row = async (id) => (await db.query('SELECT install, rc_id, email, thread_hash, status FROM tickets WHERE id = $1', [id])).rows[0];
// Every thread key handed out here, for the log check at the end.
const keys = [];
const create = async (c, body) => {
  const r = await c.post('/v1/tickets', body);
  if (r.json?.thread) keys.push(r.json.thread);
  return r;
};

describe('a ticket with an email (SDK 2.3.0)', () => {
  test('is stored with no install and no customer id, and answered with a thread key', async () => {
    const r = await create(client(srv.base, key), withEmail({ rc_id: '$RCAnonymousID:abc' }));
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json), ['id', 'created_at', 'status', 'thread'], 'the old fields, and thread');
    assert.equal(r.json.status, 'open');
    assert.match(r.json.thread, /^[A-Za-z0-9_-]{43}$/);
    const stored = await row(r.json.id);
    assert.equal(stored.install, null);
    assert.equal(stored.rc_id, null, 'dropped even when a client sends one');
    assert.equal(stored.email, 'sam@example.com');
    assert.equal(stored.thread_hash, sha256(r.json.thread), 'only the hash of the key is kept');
  });

  test('without an install there must be an email', async () => {
    const c = client(srv.base, key);
    assert.deepEqual((await c.post('/v1/tickets', { kind: 'issue', message: 'x' })).json, { error: 'invalid install' });
    assert.deepEqual((await c.post('/v1/tickets', withEmail({ email: '' }))).json, { error: 'invalid install' });
    assert.deepEqual((await c.post('/v1/tickets', withEmail({ email: '   ' }))).json, { error: 'invalid install' });
    assert.deepEqual((await c.post('/v1/tickets', withEmail({ email: 'not an email' }))).json, { error: 'invalid email' });
    assert.deepEqual((await c.post('/v1/tickets', withEmail({ install: 'nope' }))).json, { error: 'invalid install' });
  });

  test('listed, read and answered by its thread key, under its own app only', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    const { json: t } = await create(c, withEmail());
    await admin(srv.base).post(`/admin/tickets/${t.id}/reply`, { body: 'On it.' });

    const list = await c.post('/v1/tickets/threads', { threads: [t.thread] });
    assert.equal(list.status, 200);
    assert.equal(list.json.tickets.length, 1);
    // The same shape as an install's list.
    await c.post('/v1/tickets', ticket(install));
    const byInstall = (await c.get(`/v1/tickets?install=${install}`)).json.tickets[0];
    assert.deepEqual(Object.keys(list.json.tickets[0]), Object.keys(byInstall));
    assert.equal(list.json.tickets[0].unread, true);
    assert.deepEqual(list.json.tickets[0].replies.map((x) => x.body), ['On it.']);
    assert.equal((await c.post('/v1/tickets/threads', { threads: [t.thread] })).json.tickets[0].unread, false, 'read once fetched');

    const reply = await c.post(`/v1/tickets/${t.id}/reply`, { thread: t.thread, body: 'Thanks, it works now.' });
    assert.equal(reply.status, 201);
    assert.equal(reply.json.status, 'open');
    assert.equal((await row(t.id)).install, null, 'a reply links nothing');

    assert.deepEqual((await client(srv.base, otherKey).post('/v1/tickets/threads', { threads: [t.thread] })).json, { tickets: [] });
    assert.equal((await client(srv.base).post('/v1/tickets/threads', { threads: [t.thread] })).status, 401);
    assert.deepEqual((await c.post('/v1/tickets/threads', { threads: [] })).json, { tickets: [] });
  });

  test('read by its key, it records the time of the reply shown, never the time of the request', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    const own = (await c.post('/v1/tickets', ticket(install))).json;
    const { json: t } = await create(c, withEmail());
    const readAt = async (id) => (await db.query('SELECT read_at FROM tickets WHERE id = $1', [id])).rows[0].read_at;

    // Nothing to read yet: nothing recorded.
    await c.post('/v1/tickets/threads', { threads: [t.thread] });
    assert.equal(await readAt(t.id), null);

    await admin(srv.base).post(`/admin/tickets/${own.id}/reply`, { body: 'Thanks.' });
    await admin(srv.base).post(`/admin/tickets/${t.id}/reply`, { body: 'On it.' });
    const replied = (await db.query("SELECT created_at FROM ticket_replies WHERE ticket_id = $1 AND author = 'support'", [t.id])).rows[0].created_at;
    // As SDK 2.3.0 lists them: both requests at once, from one device.
    for (let poll = 0; poll < 3; poll++) {
      await Promise.all([c.post('/v1/tickets/list', { install }), c.post('/v1/tickets/threads', { threads: [t.thread] })]);
      assert.equal((await readAt(t.id)).getTime(), replied.getTime(), 'the support reply\'s own time');
      assert.notEqual((await readAt(own.id)).getTime(), (await readAt(t.id)).getTime());
    }
    const listed = (await c.post('/v1/tickets/threads', { threads: [t.thread] })).json.tickets[0];
    assert.equal(listed.unread, false, 'unread works as before');
  });

  test('a wrong key is a 404 like a wrong install; a malformed key or list is a 400', async () => {
    const c = client(srv.base, key);
    const { json: t } = await create(c, withEmail());
    const wrong = randomBytes(32).toString('base64url');
    assert.equal((await c.post(`/v1/tickets/${t.id}/reply`, { thread: wrong, body: 'hi' })).status, 404);
    assert.equal((await c.post(`/v1/tickets/${t.id}/reply`, { install: uuid(), body: 'hi' })).status, 404, 'no install reaches it');
    assert.equal((await client(srv.base, otherKey).post(`/v1/tickets/${t.id}/reply`, { thread: t.thread, body: 'hi' })).status, 404, "another app's key");
    assert.deepEqual((await c.post(`/v1/tickets/${t.id}/reply`, { thread: 'short', body: 'hi' })).json, { error: 'invalid thread' });
    assert.deepEqual((await c.post('/v1/tickets/threads', { threads: [wrong] })).json, { tickets: [] });
    for (const threads of [undefined, 'x', [42], ['short'], Array.from({ length: 51 }, () => wrong)]) {
      assert.equal((await c.post('/v1/tickets/threads', { threads })).status, 400, JSON.stringify(threads)?.slice(0, 40));
    }
  });

  test('a closed thread refuses a reply with 409, as by install', async () => {
    const c = client(srv.base, key);
    const { json: t } = await create(c, withEmail());
    await admin(srv.base).post(`/admin/tickets/${t.id}/status`, { status: 'closed' });
    assert.equal((await c.post(`/v1/tickets/${t.id}/reply`, { thread: t.thread, body: 'late' })).status, 409);
  });

  test('five a day per caller address and app, since there is no install to count by', async () => {
    const ip = `203.0.113.${randomBytes(2).toString('hex')}`;
    const c = client(srv.base, key, { ip });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await create(c, withEmail())).status);
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
    assert.equal((await create(client(srv.base, key), withEmail())).status, 201, 'another address');
    assert.equal((await create(client(srv.base, otherKey, { ip }), withEmail())).status, 201, 'another app');
  });

  test('on the dashboard: no install or customer id, never on an install page', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    const { json: t } = await create(c, withEmail());
    const one = await admin(srv.base).get(`/admin/tickets/${t.id}`);
    assert.equal(one.json.install, null);
    assert.equal(one.json.rc_id, null);
    assert.equal(one.json.email, 'sam@example.com');
    assert.ok(!('thread_hash' in one.json), 'the key hash stays in the database');
    assert.ok(!('read_at' in one.json), 'nor when an app last read a ticket');
    const listed = (await admin(srv.base).get('/admin/tickets?status=all')).json.tickets.find((x) => String(x.id) === String(t.id));
    assert.equal(listed.install, null);
    assert.deepEqual((await admin(srv.base).get(`/admin/installs/${install}`)).json.tickets, []);
  });
});

describe('a ticket with an email from an app version before SDK 2.3.0', () => {
  test('keeps the install so its inbox lists it, and loses the customer id at once', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    await c.post('/v1/events', batch([event(install, 'session_started')]));
    const r = await c.post('/v1/tickets', ticket(install, { email: 'old@example.com', rc_id: '$RCAnonymousID:old' }));
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json), ['id', 'created_at', 'status'], 'the answer it was built against');
    const stored = await row(r.json.id);
    assert.equal(stored.install, install);
    assert.equal(stored.rc_id, null);
    assert.equal(stored.thread_hash, null);
    assert.equal((await c.get(`/v1/tickets?install=${install}`)).json.tickets.length, 1, 'its inbox still lists it');
    assert.equal((await c.post(`/v1/tickets/${r.json.id}/reply`, { install, body: 'Any news?' })).status, 201, 'and it can still answer');

    // The operator sees neither id on it, and the install page does not list it.
    const one = (await admin(srv.base).get(`/admin/tickets/${r.json.id}`)).json;
    assert.equal(one.install, null);
    assert.equal(one.rc_id, null);
    assert.deepEqual((await admin(srv.base).get(`/admin/installs/${install}`)).json.tickets, []);
  });

  test('without an email nothing changes: the install and customer id stay, for the operator too', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    const r = await c.post('/v1/tickets', ticket(install, { rc_id: '$RCAnonymousID:paid' }));
    const stored = await row(r.json.id);
    assert.equal(stored.install, install);
    assert.equal(stored.rc_id, '$RCAnonymousID:paid');
    const one = (await admin(srv.base).get(`/admin/tickets/${r.json.id}`)).json;
    assert.equal(one.install, install);
    assert.equal(one.rc_id, '$RCAnonymousID:paid');
    await admin(srv.base).post(`/admin/tickets/${r.json.id}/status`, { status: 'closed' });
    assert.equal((await row(r.json.id)).install, install, 'closing it keeps the install: it is the only way back');
    assert.deepEqual((await admin(srv.base).get(`/admin/installs/${install}`)).json.tickets.map((x) => String(x.id)), [String(r.json.id)]);
  });

  test('closing it keeps the install until that app has fetched the close; the sweep clears it then', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    const a = await c.post('/v1/tickets', ticket(install, { email: 'old@example.com' }));
    const b = await c.post('/v1/tickets', ticket(install, { email: 'old@example.com' }));
    await admin(srv.base).post(`/admin/tickets/${a.json.id}/status`, { status: 'closed' });
    await admin(srv.base).post(`/admin/tickets/${b.json.id}/reply`, { body: 'Fixed in 2.0.2.', close: true });
    await sweep();
    assert.equal((await row(a.json.id)).install, install, 'not before the app has seen it closed');
    assert.equal((await row(b.json.id)).install, install);

    // The app as it was built: the closing reply shows, and a late reply is `closed`, not a 404.
    const listed = (await c.get(`/v1/tickets?install=${install}`)).json.tickets;
    assert.deepEqual(listed.map((t) => [String(t.id), t.status]), [[String(b.json.id), 'closed'], [String(a.json.id), 'closed']]);
    assert.deepEqual(listed[0].replies.map((x) => x.body), ['Fixed in 2.0.2.']);
    assert.equal(listed[0].unread, true);
    assert.equal((await c.post(`/v1/tickets/${b.json.id}/reply`, { install, body: 'Thanks!' })).status, 409);

    await sweep();
    assert.equal((await row(a.json.id)).install, null);
    assert.equal((await row(b.json.id)).install, null);
    assert.deepEqual((await c.get(`/v1/tickets?install=${install}`)).json, { tickets: [] });
    await admin(srv.base).post(`/admin/tickets/${a.json.id}/status`, { status: 'open' });
    assert.equal((await row(a.json.id)).install, null, 'reopening does not link it again');
  });

  test('closed and never fetched again, it keeps the install for 7 days', async () => {
    const c = client(srv.base, key);
    const install = uuid();
    const t = await c.post('/v1/tickets', ticket(install, { email: 'old@example.com' }));
    await admin(srv.base).post(`/admin/tickets/${t.json.id}/reply`, { body: 'Done.', close: true });
    await db.query("UPDATE tickets SET updated_at = now() - interval '6 days' WHERE id = $1", [t.json.id]);
    await sweep();
    assert.equal((await row(t.json.id)).install, install);
    await db.query("UPDATE tickets SET updated_at = now() - interval '8 days' WHERE id = $1", [t.json.id]);
    await sweep();
    assert.equal((await row(t.json.id)).install, null);
  });

  test('the sweep clears it 30 days after the last activity, with the install\'s ticket events since it was opened', async () => {
    const c = client(srv.base, key);
    const [idle, active, plain] = [uuid(), uuid(), uuid()];
    // What an older app sends around a ticket: ticket_opened as it is sent, ticket_replied for a reply.
    const earlier = event(idle, 'ticket_opened', { props: { kind: 'feature' } });
    await c.post('/v1/events', batch([earlier, event(idle, 'session_started')]));
    const old = await c.post('/v1/tickets', ticket(idle, { email: 'old@example.com' }));
    const sibling = await c.post('/v1/tickets', ticket(idle));
    await c.post('/v1/events', batch([event(idle, 'ticket_opened', { props: { kind: 'issue' } }), event(idle, 'ticket_opened', { props: { kind: 'issue' } })]));
    await admin(srv.base).post(`/admin/tickets/${old.json.id}/reply`, { body: 'Which build?' });
    await c.post(`/v1/tickets/${old.json.id}/reply`, { install: idle, body: 'Any news?' });
    await c.post('/v1/events', batch([event(idle, 'ticket_replied'), event(idle, 'screen_viewed', { props: { screen: 'inbox' } })]));
    await c.post('/v1/events', batch([event(active, 'ticket_opened', { props: { kind: 'issue' } })]));
    // The app's inbox read both tickets in one request: the same read_at on each.
    await c.get(`/v1/tickets?install=${idle}`);
    const recent = await c.post('/v1/tickets', ticket(active, { email: 'old@example.com' }));
    const noEmail = await c.post('/v1/tickets', ticket(plain));
    await db.query("UPDATE tickets SET updated_at = now() - interval '31 days' WHERE id = ANY($1::bigint[])", [[old.json.id, noEmail.json.id]]);
    await db.query("UPDATE tickets SET updated_at = now() - interval '29 days' WHERE id = $1", [recent.json.id]);
    // The ticket_opened from before this ticket was opened stays.
    await db.query("UPDATE events SET received_at = now() - interval '2 days' WHERE id = $1", [earlier.id]);
    await db.query("UPDATE tickets SET created_at = now() - interval '1 day' WHERE id = $1", [old.json.id]);

    assert.ok((await sweep()) >= 1);
    assert.equal((await row(old.json.id)).install, null);
    assert.equal((await row(recent.json.id)).install, active, 'activity within 30 days keeps it');
    assert.equal((await row(noEmail.json.id)).install, plain, 'a ticket without an email keeps its install');

    const names = async (install) => (await db.query('SELECT name FROM events WHERE install = $1 ORDER BY name', [install])).rows.map((x) => x.name);
    assert.deepEqual(await names(idle), ['screen_viewed', 'session_started', 'ticket_opened'], 'its ticket events go; the rest stay');
    assert.deepEqual(await names(active), ['ticket_opened'], 'another install\'s stay');

    const readAts = (await db.query('SELECT id, read_at FROM tickets WHERE id = ANY($1::bigint[])', [[old.json.id, sibling.json.id]])).rows;
    const at = (id) => readAts.find((x) => String(x.id) === String(id)).read_at?.getTime();
    const support = (await db.query("SELECT created_at FROM ticket_replies WHERE ticket_id = $1 AND author = 'support'", [old.json.id])).rows[0].created_at;
    assert.equal(at(old.json.id), support.getTime(), 'read_at is the reply it had seen, no longer the request time');
    assert.notEqual(at(old.json.id), at(sibling.json.id));
  });
});

describe('the operator\'s list', () => {
  // An app of its own, so the other tests' tickets stay out of these numbers.
  let inbox;
  before(async () => {
    const k = await addApp(db, 'inbox', 'Inbox');
    const c = client(srv.base, k);
    const made = [];
    for (const extra of [
      { subject: 'Widgets please', kind: 'feature' },
      { message: 'The timer stops 100% of the time.' },
      { message: 'Crashes on launch' },
      { message: 'Loving it', kind: 'love' },
    ]) made.push((await create(c, ticket(uuid(), extra))).json);
    await admin(srv.base).post(`/admin/tickets/${made[2].id}/reply`, { body: 'Fixed in the dark mode build.' });
    await admin(srv.base).post(`/admin/tickets/${made[3].id}/status`, { status: 'closed' });
    inbox = made;
  });
  const list = async (query) => (await admin(srv.base).get(`/admin/tickets?app=inbox&${query}`)).json;

  test('by app, with every status counted under the same filters', async () => {
    const all = await list('status=all');
    assert.deepEqual(all.tickets.map((t) => String(t.id)), [1, 0, 3, 2].map((i) => String(inbox[i].id)), 'open first, then newest');
    assert.deepEqual(all.counts, { open: 2, answered: 1, closed: 1 });
    assert.equal(all.more, false);
    const open = await list('status=open');
    assert.equal(open.tickets.length, 2);
    assert.deepEqual(open.counts, all.counts, 'the counts ignore the status filter, for the tabs');
    assert.deepEqual((await list('status=all&kind=love')).counts, { open: 0, answered: 0, closed: 1 });
  });

  test('a search finds the subject, the message, a reply or the id, and % is only a character', async () => {
    const ids = async (q) => (await list(`status=all&q=${encodeURIComponent(q)}`)).tickets.map((t) => String(t.id));
    assert.deepEqual(await ids('widgets'), [String(inbox[0].id)]);
    assert.deepEqual(await ids('dark mode'), [String(inbox[2].id)], 'found by the reply');
    assert.deepEqual(await ids(`#${inbox[3].id}`), [String(inbox[3].id)]);
    assert.deepEqual(await ids('100%'), [String(inbox[1].id)]);
    assert.deepEqual(await ids('%'), [String(inbox[1].id)], 'not a wildcard');
    assert.deepEqual((await list('status=all&q=nothing-like-this')).counts, { open: 0, answered: 0, closed: 0 });
  });

  test('pages: limit and offset, with more while there is a next page', async () => {
    const first = await list('status=all&limit=3');
    assert.equal(first.tickets.length, 3);
    assert.equal(first.more, true);
    const second = await list('status=all&limit=3&offset=3');
    assert.deepEqual(second.tickets.map((t) => String(t.id)), [String(inbox[2].id)]);
    assert.equal(second.more, false);
  });
});

describe('deleting one ticket', () => {
  test('the operator deletes a ticket and its replies; 404 for one that is not there', async () => {
    const c = client(srv.base, key);
    const { json: t } = await create(c, withEmail());
    await c.post(`/v1/tickets/${t.id}/reply`, { thread: t.thread, body: 'Please delete my message.' });
    const r = await admin(srv.base).delete(`/admin/tickets/${t.id}`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ticket_replies WHERE ticket_id = $1', [t.id])).rows[0].n, 0);
    assert.equal((await admin(srv.base).get(`/admin/tickets/${t.id}`)).status, 404);
    assert.deepEqual((await c.post('/v1/tickets/threads', { threads: [t.thread] })).json, { tickets: [] });
    assert.equal((await admin(srv.base).delete(`/admin/tickets/${t.id}`, {})).status, 404);
    assert.equal((await admin(srv.base).delete('/admin/tickets/nope', {})).status, 404);
  });

  test('like every admin write: the token, and JSON', async () => {
    const { json: t } = await create(client(srv.base, key), withEmail());
    assert.equal((await client(srv.base).delete(`/admin/tickets/${t.id}`, {})).status, 401);
    assert.equal((await admin(srv.base).delete(`/admin/tickets/${t.id}`)).status, 403, 'no JSON content type');
    assert.equal((await admin(srv.base).get(`/admin/tickets/${t.id}`)).status, 200);
  });
});

test('a path parameter that is not UTF-8 is a 404, and the server stays up', async () => {
  // %E0%A4 is valid percent-encoding of bytes that are not UTF-8. Decoding it
  // used to throw outside the handler, and one such request, no key needed,
  // ended the process.
  for (const [method, path] of [['POST', '/v1/tickets/%E0%A4/reply'], ['GET', '/admin/tickets/%E0%A4'], ['DELETE', '/admin/tickets/%FF']]) {
    const res = await fetch(`${srv.base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await fetch(`${srv.base}/healthz`)).status, 200);
});

test('the log never holds a thread key, nor an install id next to an email', async () => {
  // Give the dry-run mails a moment to be logged.
  await new Promise((r) => setTimeout(r, 200));
  const lines = srv.logs.join('').split('\n').filter(Boolean);
  assert.ok(lines.some((l) => l.includes('ops@example.com')), 'the alert mails were logged');
  assert.ok(keys.length > 5);
  for (const line of lines) {
    for (const k of keys) assert.ok(!line.includes(k), `a thread key in the log: ${line}`);
    if (line.includes('@')) assert.doesNotMatch(line, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `an install id next to an email: ${line}`);
  }
});
