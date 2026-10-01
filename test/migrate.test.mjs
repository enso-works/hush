// A first boot against an empty database is the normal path, not a special
// case: the server migrates before it listens.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { freshDatabase, startServer } from './helpers.mjs';

let db;
after(() => db?.drop());

test('boots on an empty database, migrates once, and boots again', async () => {
  db = await freshDatabase('hush_migrate');
  let srv = await startServer(db);
  const tables = async () =>
    (await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename);
  for (const t of ['apps', 'events', 'installs', 'schema_migrations', 'ticket_replies', 'tickets', 'write_keys']) {
    assert.ok((await tables()).includes(t), `missing table ${t}`);
  }
  const applied = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.ok(applied.length >= 3);
  await srv.stop();

  srv = await startServer(db);
  const again = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.deepEqual(again, applied, 'a second boot applies nothing');
  const health = await fetch(`${srv.base}/healthz`);
  assert.deepEqual(await health.json(), { ok: true, db: 'up' });
  await srv.stop();
});

test('006 marks the ticket_replied rows a server before it stored as unknown', async () => {
  const old = await freshDatabase('hush_migrate_006');
  try {
    let srv = await startServer(old);
    await srv.stop();
    // The database as it was before 006, with a reply stored when the name was not common.
    await old.query("DELETE FROM schema_migrations WHERE name = '006_ticket_replied_known.sql'");
    await old.query(
      `INSERT INTO events (id, app, env, install, name, known, at)
       VALUES (gen_random_uuid(), 'braele', 'prod', gen_random_uuid(), 'ticket_replied', false, now()),
              (gen_random_uuid(), 'braele', 'prod', gen_random_uuid(), 'something_new', false, now())`,
    );
    srv = await startServer(old);
    await srv.stop();
    const { rows } = await old.query('SELECT name, known FROM events ORDER BY name');
    assert.deepEqual(rows, [
      { name: 'something_new', known: false },
      { name: 'ticket_replied', known: true },
    ]);
  } finally {
    await old.drop();
  }
});

test('007 unlinks the tickets with an email that are closed and seen or idle, with their ticket events; drops their customer id; adds the thread key column', async () => {
  const old = await freshDatabase('hush_migrate_007');
  try {
    let srv = await startServer(old);
    await srv.stop();
    // The database as it was before 007.
    await old.query("DELETE FROM schema_migrations WHERE name = '007_unlinked_tickets.sql'");
    await old.query('ALTER TABLE tickets DROP COLUMN thread_hash');
    await old.query("INSERT INTO apps (slug, name) VALUES ('braele', 'Braele')");
    const [open, seen, unseen, closedLongAgo, idle, plain] = [1, 2, 3, 4, 5, 6].map((n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n.toString().repeat(12)}`);
    await old.query(
      `INSERT INTO tickets (app, install, email, message, status, rc_id, created_at, updated_at, read_at) VALUES
         ('braele', $1, 'open@example.com',   'open, recent',              'open',     'rc1', now() - interval '3 days',  now() - interval '1 day',   NULL),
         ('braele', $2, 'seen@example.com',   'closed, fetched since',     'closed',   'rc2', now() - interval '3 days',  now() - interval '1 day',   now() - interval '1 hour'),
         ('braele', $3, 'unseen@example.com', 'closed, not fetched since', 'closed',   NULL,  now() - interval '3 days',  now() - interval '1 day',   now() - interval '2 days'),
         ('braele', $4, 'long@example.com',   'closed 8 days ago',         'closed',   NULL,  now() - interval '20 days', now() - interval '8 days',  NULL),
         ('braele', $5, 'idle@example.com',   'idle',                      'answered', NULL,  now() - interval '90 days', now() - interval '31 days', now() - interval '31 days'),
         ('braele', $6, NULL,                 'no email',                  'closed',   'rc6', now() - interval '90 days', now() - interval '60 days', now() - interval '1 hour')`,
      [open, seen, unseen, closedLongAgo, idle, plain],
    );
    // The ticket events those app versions tracked, with the install, and one from before the ticket.
    await old.query(
      `INSERT INTO events (id, app, env, install, name, at, received_at, props) VALUES
         (gen_random_uuid(), 'braele', 'prod', $1, 'ticket_opened',   now() - interval '3 days', now() - interval '3 days', '{"kind":"issue"}'),
         (gen_random_uuid(), 'braele', 'prod', $2, 'ticket_opened',   now() - interval '3 days', now() - interval '3 days', '{"kind":"issue"}'),
         (gen_random_uuid(), 'braele', 'prod', $2, 'ticket_replied',  now() - interval '2 days', now() - interval '2 days', '{}'),
         (gen_random_uuid(), 'braele', 'prod', $2, 'session_started', now() - interval '2 days', now() - interval '2 days', '{}'),
         (gen_random_uuid(), 'braele', 'prod', $2, 'ticket_opened',   now() - interval '9 days', now() - interval '9 days', '{"kind":"love"}'),
         (gen_random_uuid(), 'braele', 'prod', $3, 'ticket_opened',   now() - interval '3 days', now() - interval '3 days', '{"kind":"issue"}')`,
      [open, seen, unseen],
    );
    await old.query("INSERT INTO ticket_replies (ticket_id, author, body, created_at) SELECT id, 'support', 'Fixed.', now() - interval '1 day' FROM tickets WHERE install = $1", [seen]);
    await old.query('ALTER TABLE tickets ALTER COLUMN install SET NOT NULL');
    srv = await startServer(old);
    await srv.stop();

    const { rows } = await old.query('SELECT message, install, rc_id FROM tickets ORDER BY id');
    assert.deepEqual(rows, [
      { message: 'open, recent', install: open, rc_id: null },
      { message: 'closed, fetched since', install: null, rc_id: null },
      { message: 'closed, not fetched since', install: unseen, rc_id: null },
      { message: 'closed 8 days ago', install: null, rc_id: null },
      { message: 'idle', install: null, rc_id: null },
      { message: 'no email', install: plain, rc_id: 'rc6' },
    ]);
    const events = await old.query('SELECT install, name, props FROM events ORDER BY install, name');
    assert.deepEqual(events.rows, [
      { install: open, name: 'ticket_opened', props: { kind: 'issue' } },
      { install: seen, name: 'session_started', props: {} },
      { install: seen, name: 'ticket_opened', props: { kind: 'love' } },
      { install: unseen, name: 'ticket_opened', props: { kind: 'issue' } },
    ]);
    const readAt = await old.query(
      "SELECT t.message, t.read_at = (SELECT created_at FROM ticket_replies r WHERE r.ticket_id = t.id) AS is_reply_time, t.read_at IS NULL AS is_null FROM tickets t WHERE t.install IS NULL ORDER BY t.id",
    );
    assert.deepEqual(readAt.rows.map((x) => [x.message, x.is_reply_time ?? null, x.is_null]), [
      ['closed, fetched since', true, false],
      ['closed 8 days ago', null, true],
      ['idle', null, true],
    ], 'read_at as a request time goes: the reply it had seen, or nothing');
    const column = await old.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'install'");
    assert.equal(column.rows[0].is_nullable, 'YES');
    const index = await old.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'tickets' AND indexname = 'tickets_thread_hash_idx'");
    assert.match(index.rows[0].indexdef, /UNIQUE INDEX .* \(thread_hash\)/);
  } finally {
    await old.drop();
  }
});
