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
