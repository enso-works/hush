// Configuration: what an operator sets, and what happens when they do not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbs = [];
after(() => Promise.all(dbs.map((d) => d.drop())));
const db = async (p) => {
  const d = await freshDatabase(p);
  dbs.push(d);
  return d;
};

test('a fresh install registers no apps of its own; APPS does, once', async () => {
  const d = await db('hush_apps');
  let srv = await startServer(d);
  assert.deepEqual((await d.query('SELECT slug FROM apps')).rows, []);
  await srv.stop();

  srv = await startServer(d, { APPS: 'myapp=My App, other=Other' });
  const rows = async () => (await d.query('SELECT slug, name FROM apps ORDER BY slug')).rows;
  assert.deepEqual(await rows(), [{ slug: 'myapp', name: 'My App' }, { slug: 'other', name: 'Other' }]);
  await srv.stop();

  // A rename in APPS does not overwrite a row that exists; the CLI does that.
  srv = await startServer(d, { APPS: 'myapp=Renamed' });
  assert.deepEqual(await rows(), [{ slug: 'myapp', name: 'My App' }, { slug: 'other', name: 'Other' }]);
  await srv.stop();
});

test('a malformed APPS or catalog stops the boot, naming the problem', async () => {
  const d = await db('hush_badcfg');
  const run = (env) =>
    spawnSync(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, DATABASE_URL: d.url, PORT: '0', ...env },
      encoding: 'utf8',
      timeout: 15000,
    });
  const badApps = run({ APPS: 'Not A Slug=x' });
  assert.notEqual(badApps.status, 0);
  assert.match(badApps.stdout + badApps.stderr, /APPS/);

  const file = join(tmpdir(), 'hush-bad-catalog.json');
  writeFileSync(file, JSON.stringify({ myapp: { events: ['Bad Name'] } }));
  const badCatalog = run({ CATALOG_FILE: file });
  assert.notEqual(badCatalog.status, 0);
  assert.match(badCatalog.stdout + badCatalog.stderr, /catalog\.myapp\.events/);
});

test('no country is stored unless COUNTRY_HEADER names a trusted header', async () => {
  const d = await db('hush_country');
  let srv = await startServer(d);
  const key = await addApp(d, 'myapp');
  const install = uuid();
  await client(srv.base, key).post('/v1/events', batch([event(install, 'session_started')]), { 'CF-IPCountry': 'DE' });
  assert.equal((await d.query('SELECT country FROM installs WHERE id = $1', [install])).rows[0].country, null);
  await srv.stop();

  srv = await startServer(d, { COUNTRY_HEADER: 'X-Country' });
  const second = uuid();
  await client(srv.base, key).post('/v1/events', batch([event(second, 'session_started')]), { 'X-Country': 'FR' });
  assert.equal((await d.query('SELECT country FROM installs WHERE id = $1', [second])).rows[0].country, 'FR');
  await srv.stop();
});

test('ADMIN_TOKEN and the older TELEMETRY_ADMIN_TOKEN both guard /admin', async () => {
  const d = await db('hush_token');
  const srv = await startServer(d, { ADMIN_TOKEN: '', TELEMETRY_ADMIN_TOKEN: 'legacy-token' });
  assert.equal((await client(srv.base, 'Bearer legacy-token').get('/admin/apps')).status, 200);
  await srv.stop();
});

test('a ticket id that is not a number is 404, not a server error', async () => {
  const d = await db('hush_ids');
  const srv = await startServer(d);
  for (const path of ['/admin/tickets/abc', '/admin/tickets/1e3']) {
    assert.equal((await admin(srv.base).get(path)).status, 404);
  }
  assert.equal((await admin(srv.base).post('/admin/tickets/abc/reply', { body: 'x' })).status, 404);
  assert.equal((await admin(srv.base).post('/admin/tickets/undefined/status', { status: 'closed' })).status, 404);
  await srv.stop();
});

test('rate limits count the socket address unless CLIENT_IP_HEADER names a trusted header', async () => {
  const d = await db('hush_ip');
  // No trusted header: a client rotating X-Forwarded-For still shares one bucket.
  let srv = await startServer(d, { CLIENT_IP_HEADER: '' });
  const key = await addApp(d, 'myapp');
  const codes = [];
  for (let i = 0; i < 12; i++) {
    const r = await client(srv.base, key, { ip: `203.0.113.${i}` }).post('/v1/tickets', { install: uuid(), message: 'x' }, { 'X-Forwarded-For': `198.51.100.${i}` });
    codes.push(r.status);
  }
  assert.ok(codes.includes(429), `spoofed headers must not dodge the limit: ${codes}`);
  await srv.stop();

  // A trusted header: each address gets its own bucket.
  srv = await startServer(d, { CLIENT_IP_HEADER: 'x-forwarded-for' });
  const spread = [];
  for (let i = 0; i < 12; i++) {
    const r = await client(srv.base, key).post('/v1/tickets', { install: uuid(), message: 'x' }, { 'X-Forwarded-For': `198.51.100.${i}, 10.0.0.1` });
    spread.push(r.status);
  }
  assert.ok(!spread.includes(429), `distinct addresses must not share a bucket: ${spread}`);
  await srv.stop();
});
