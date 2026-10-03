// Admin CLI, run inside the container:
//   docker compose exec hush node src/cli.mjs keys:create myapp prod "1.0.0"
//
// The key is printed once and only its hash is stored; it goes into the app's
// write-key setting (the SDK's `key`) and nowhere else.
import { log } from './config.mjs';
import { pool, q } from './db.mjs';
import { hashKey, mintKey } from './keys.mjs';
import { migrate } from './migrate.mjs';
import { link, listProjects, poll, rcConfigured, syncProjects } from './revenuecat.mjs';
import { ascConfigured, ensureRequest, syncAll, syncApp } from './appstore.mjs';
import { appExists, configAnswer } from './remote-config.mjs';

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

  // What the RevenueCat key can see, and which app each project is linked to.
  async 'rc:projects'() {
    if (!rcConfigured()) throw new Error('RC_API_KEY is not set');
    const [projects, links] = [await listProjects(), (await q('SELECT app, project_id FROM rc_projects')).rows];
    for (const p of projects) {
      const app = links.find((l) => l.project_id === p.id)?.app;
      console.log(`${p.id}\t${p.name}\t${app ? `→ ${app}` : '(not linked)'}`);
    }
  },

  // Only needed when the project's name is neither the app's slug nor its
  // display name; otherwise the poller links it by itself.
  async 'rc:link'(app, projectId) {
    if (!app || !projectId) throw new Error('usage: rc:link <app> <project_id>');
    const { rowCount } = await q('SELECT 1 FROM apps WHERE slug = $1', [app]);
    if (!rowCount) throw new Error(`unknown app ${app} — add it first with apps:add`);
    await link(app, projectId, null);
    console.log(`${app} → ${projectId}`);
  },

  async 'rc:sync'() {
    if (!rcConfigured()) throw new Error('RC_API_KEY is not set');
    const { linked } = await syncProjects();
    console.log(linked.length ? linked.map((l) => `${l.app} → ${l.project} (${l.id})`).join('\n') : 'no project name matched an app; use rc:projects then rc:link');
  },

  // Which charts this project answered for, and which it does not have.
  async 'rc:charts'() {
    const { rows } = await q('SELECT app, chart, supported, display_name, note FROM rc_charts ORDER BY app, supported DESC, chart');
    for (const r of rows) console.log(`${r.app}\t${r.chart}\t${r.supported ? (r.display_name ?? 'ok') : `ABSENT ${r.note ?? ''}`}`);
  },

  async 'rc:poll'() {
    if (!rcConfigured()) throw new Error('RC_API_KEY is not set');
    await poll();
    const { rows } = await q('SELECT app, last_polled_at, last_error FROM rc_projects ORDER BY app');
    for (const r of rows) console.log(`${r.app}\t${r.last_polled_at?.toISOString() ?? 'never'}\t${r.last_error ?? 'ok'}`);
  },

  // App Store campaign reports: create (or find) the app's report request.
  // Needs an Admin key once; Apple has the first data a day or two later.
  async 'asc:request'(app) {
    if (!ascConfigured()) throw new Error('ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY(_FILE) are not set');
    if (!app) throw new Error('usage: asc:request <app>');
    console.log(`${app}: report request ${await ensureRequest(app)}`);
  },

  async 'asc:sync'(app) {
    if (!ascConfigured()) throw new Error('ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY(_FILE) are not set');
    const apps = app ? [app] : (await q('SELECT slug FROM apps ORDER BY slug')).rows.map((r) => r.slug);
    for (const r of app ? [await syncApp(app)] : await syncAll(apps)) {
      console.log(r.error ? `${r.app}\terror: ${r.error}` : `${r.app}\t${r.reports} reports, ${r.imported} new instances`);
    }
  },

  // What /v1/config answers the app's installs. Read-only: overrides are
  // written on the dashboard, which records each change.
  async 'config:show'(app) {
    if (!app) throw new Error('usage: config:show <app>');
    if (!(await appExists(app))) throw new Error(`unknown app ${app}`);
    console.log(JSON.stringify((await configAnswer(app)).body, null, 2));
  },

  // The latest 50 config changes, without their values: one row may hold
  // four of up to 64 KB each.
  async 'config:history'(app, key) {
    if (!app) throw new Error('usage: config:history <app> [key]');
    const { rows } = await q(
      `SELECT id, at, key, action, note FROM config_changes
        WHERE app = $1 AND ($2::text IS NULL OR key = $2) ORDER BY id DESC LIMIT 50`,
      [app, key ?? null],
    );
    for (const c of rows) console.log(`${c.id}\t${c.at.toISOString()}\t${c.key}\t${c.action}\t${c.note ?? ''}`);
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
