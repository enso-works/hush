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

test('007 unlinks the tickets with an email that are closed or idle, drops their customer id, and adds the thread key column', async () => {
  const old = await freshDatabase('hush_migrate_007');
  try {
    let srv = await startServer(old);
    await srv.stop();
    // The database as it was before 007.
    await old.query("DELETE FROM schema_migrations WHERE name = '007_unlinked_tickets.sql'");
    await old.query('ALTER TABLE tickets DROP COLUMN thread_hash');
    await old.query("INSERT INTO apps (slug, name) VALUES ('braele', 'Braele')");
    await old.query(
      `INSERT INTO tickets (app, install, email, message, status, rc_id, created_at, updated_at) VALUES
         ('braele', '11111111-1111-4111-8111-111111111111', 'open@example.com',   'open, recent', 'open',     'rc1', now() - interval '3 days',  now() - interval '1 day'),
         ('braele', '22222222-2222-4222-8222-222222222222', 'closed@example.com', 'closed',       'closed',   'rc2', now() - interval '3 days',  now() - interval '1 day'),
         ('braele', '33333333-3333-4333-8333-333333333333', 'idle@example.com',   'idle',         'answered', NULL,  now() - interval '90 days', now() - interval '31 days'),
         ('braele', '44444444-4444-4444-8444-444444444444', NULL,                 'no email',     'closed',   'rc4', now() - interval '90 days', now() - interval '60 days')`,
    );
    await old.query('ALTER TABLE tickets ALTER COLUMN install SET NOT NULL');
    srv = await startServer(old);
    await srv.stop();

    const { rows } = await old.query('SELECT message, install, rc_id FROM tickets ORDER BY id');
    assert.deepEqual(rows, [
      { message: 'open, recent', install: '11111111-1111-4111-8111-111111111111', rc_id: null },
      { message: 'closed', install: null, rc_id: null },
      { message: 'idle', install: null, rc_id: null },
      { message: 'no email', install: '44444444-4444-4444-8444-444444444444', rc_id: 'rc4' },
    ]);
    const column = await old.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'install'");
    assert.equal(column.rows[0].is_nullable, 'YES');
    const index = await old.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'tickets' AND indexname = 'tickets_thread_hash_idx'");
    assert.match(index.rows[0].indexdef, /UNIQUE INDEX .* \(thread_hash\)/);
  } finally {
    await old.drop();
  }
});
