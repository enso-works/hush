// DEMO=1: a public showcase. Readable without a token, writes nothing,
// accepts no app data, and never touches a database that holds real keys.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { addApp, client, freshDatabase, startServer } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let db, srv;
before(async () => {
  db = await freshDatabase('hush_demo');
  srv = await startServer(db, { DEMO: '1', ADMIN_TOKEN: '', TELEMETRY_ADMIN_TOKEN: '' });
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

test('the showcase is seeded: three apps with installs, events and feedback', async () => {
  const apps = await client(srv.base).get('/admin/apps?days=30');
  assert.equal(apps.status, 200, 'readable without a token');
  assert.deepEqual(apps.json.apps.map((a) => a.app).sort(), ['pace', 'stillwater', 'tally']);
  for (const a of apps.json.apps) assert.ok(a.total_installs > 100 && a.events > 0, `${a.app} has data`);
  const detail = await client(srv.base).get('/admin/apps/stillwater?days=30');
  assert.equal(detail.json.highlight.event, 'meditation_completed');
  assert.ok(detail.json.current.highlight > 0 && detail.json.current.highlight_done > 0);
  assert.ok(detail.json.countries.some((c) => c.country !== 'other'), 'enough installs per country to show some');
  const tally = await client(srv.base).get('/admin/apps/tally?days=60');
  assert.ok(tally.json.unknown.some((u) => u.name === 'widget_added'), 'one unknown event, so the flag shows');
  // SDK 2's data: channels to filter by, session lengths, a paywall variant.
  assert.ok(detail.json.channels.some((c) => c.channel === 'testflight'));
  assert.ok(detail.json.engagement.median_s > 0 && detail.json.engagement.measured > 50);
  const variants = await client(srv.base).get('/admin/apps/stillwater/breakdown?event=paywall_viewed&prop=variant&days=30');
  assert.deepEqual(variants.json.rows.map((x) => x.value).sort(), ['a', 'b']);
  const tickets = await client(srv.base).get('/admin/tickets?status=all');
  assert.ok(tickets.json.tickets.length >= 8);
});

test('it writes nothing and accepts no app data', async () => {
  const tickets = (await client(srv.base).get('/admin/tickets')).json.tickets;
  const reply = await client(srv.base).post(`/admin/tickets/${tickets[0].id}/reply`, { body: 'hi' });
  assert.equal(reply.status, 403);
  assert.equal((await client(srv.base).post(`/admin/tickets/${tickets[0].id}/status`, { status: 'closed' })).status, 403);
  assert.equal((await client(srv.base, 'hush_stillwater_prod_x').post('/v1/events', { events: [] })).status, 403);
  assert.equal((await client(srv.base, 'hush_stillwater_prod_x').post('/v1/tickets', { install: 'x', message: 'x' })).status, 403);
});

test('reseeding is stable: the same numbers every time', async () => {
  const before = (await client(srv.base).get('/admin/apps?days=30')).json.apps.map((a) => [a.app, a.total_installs]);
  await srv.stop();
  srv = await startServer(db, { DEMO: '1' });
  const after = (await client(srv.base).get('/admin/apps?days=30')).json.apps.map((a) => [a.app, a.total_installs]);
  assert.deepEqual(after, before);
});

test('DEMO=1 refuses a database with write keys: it would wipe a real instance', async () => {
  const real = await freshDatabase('hush_real');
  try {
    const s = await startServer(real);
    await addApp(real, 'myapp');
    await s.stop();
    const run = spawnSync(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, DATABASE_URL: real.url, PORT: '0', DEMO: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /refuses to run/);
    const { rows } = await real.query('SELECT count(*)::int AS n FROM apps');
    assert.equal(rows[0].n, 1, 'the real data is untouched');
  } finally {
    await real.drop();
  }
});

test('a normal instance still requires the token', async () => {
  const d = await freshDatabase('hush_nodemo');
  try {
    const s = await startServer(d);
    assert.equal((await client(s.base).get('/admin/apps')).status, 401);
    await s.stop();
  } finally {
    await d.drop();
  }
});

test('the showcase has campaigns and attribution, and takes no postbacks', async () => {
  const c = client(srv.base);
  const meta = (await c.get('/admin/apps/stillwater/campaigns?days=30&by=utm_content&where=utm_source:meta')).json;
  assert.ok(meta.rows.length >= 2, 'ads split out');
  assert.ok(meta.rows.every((r) => r.installs >= r.new && r.steps.every((n) => n <= r.installs)), 'no step above its installs');
  const a = (await c.get('/admin/apps/stillwater/attribution?days=30')).json;
  assert.equal(a.app_store_id, '6700000101');
  assert.equal(a.conversion_values.at(-1).lock, true);
  assert.ok(a.postbacks.campaigns.length >= 2, 'Meta campaigns from postbacks');
  assert.ok(a.postbacks.campaigns.every((x) => x.installs > 0), 'later postbacks are not campaigns of their own');
  assert.ok(a.appstore.campaigns.some((x) => x.campaign === 'meta_autumn' && x.first_downloads > 0));
  const r = await fetch(`${srv.base}/.well-known/skadnetwork/report-attribution/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});
