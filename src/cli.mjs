// Admin CLI, run inside the container:
//   docker compose exec telemetry node src/cli.mjs keys:create braele prod "1.4.0"
//
// The key is printed once and only its hash is stored; it goes into the app's
// EXPO_PUBLIC_TELEMETRY_KEY and nowhere else.
import { log } from './config.mjs';
import { pool, q } from './db.mjs';
import { hashKey, mintKey } from './keys.mjs';
import { migrate } from './migrate.mjs';

const [, , cmd, ...args] = process.argv;

const commands = {
  async 'apps:list'() {
    const { rows } = await q('SELECT slug, name, created_at FROM apps ORDER BY slug');
    for (const a of rows) console.log(`${a.slug}\t${a.name}`);
  },

  async 'apps:add'(slug, name) {
    if (!slug || !name) throw new Error('usage: apps:add <slug> <name>');
    await q('INSERT INTO apps (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name', [slug, name]);
    console.log(`app ${slug} ready`);
  },

  async 'keys:create'(app, env, label) {
    if (!app || !['prod', 'dev'].includes(env)) throw new Error('usage: keys:create <app> <prod|dev> [label]');
    const { rowCount } = await q('SELECT 1 FROM apps WHERE slug = $1', [app]);
    if (!rowCount) throw new Error(`unknown app ${app} — add it first with apps:add`);
    const key = mintKey(app, env);
    await q('INSERT INTO write_keys (app, env, hash, label) VALUES ($1, $2, $3, $4)', [app, env, hashKey(key), label ?? null]);
    console.log(key);
  },

  async 'keys:list'() {
    const { rows } = await q('SELECT id, app, env, label, created_at, revoked_at FROM write_keys ORDER BY app, env, id');
    for (const k of rows) console.log(`${k.id}\t${k.app}\t${k.env}\t${k.label ?? ''}\t${k.revoked_at ? 'REVOKED' : 'active'}`);
  },

  async 'keys:revoke'(id) {
    if (!id) throw new Error('usage: keys:revoke <id>');
    const { rowCount } = await q('UPDATE write_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [Number(id)]);
    console.log(rowCount ? `key ${id} revoked` : `key ${id} not found or already revoked`);
  },

  async migrate() {
    await migrate();
    console.log('migrations up to date');
  },
};

const run = commands[cmd];
if (!run) {
  console.error(`usage: node src/cli.mjs <${Object.keys(commands).join(' | ')}>`);
  process.exit(1);
}
run(...args)
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    log.error('cli failed', { cmd, err: String(err?.message ?? err) });
    process.exit(1);
  });
