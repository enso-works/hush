// Applies every migrations/*.sql not yet recorded (by file name), each in its
// own transaction. server.mjs runs it before it listens, so a first boot
// against an empty database is the normal path and there is never a moment
// when the service is up against a schema that does not exist yet.
// `node src/migrate.mjs` runs it on its own and exits.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './config.mjs';
import { pool, q, tx } from './db.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
             name text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           )`);
  const done = new Set((await q('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    log.info('migration applied', { file });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('migration failed', { err: String(err?.message ?? err) });
      process.exit(1);
    });
}
