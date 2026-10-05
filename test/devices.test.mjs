// Phones signed in with a token of their own: a pairing code from someone
// signed in, traded once for a device token that works like the admin token
// until it is revoked.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, client, freshDatabase, startServer } from './helpers.mjs';

let db, srv;
before(async () => {
  db = await freshDatabase('hush_devices');
  srv = await startServer(db);
  await addApp(db, 'game', 'Game');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

const newCode = async () => {
  const r = await admin(srv.base).post('/admin/pairing', {});
  assert.equal(r.status, 201);
  return r.json.code;
};
const pairWith = (code, name = 'Test iPhone') => client(srv.base).post('/admin/pair', { code, name });
const as = (token) => client(srv.base, `Bearer ${token}`);

describe('pairing', () => {
  test('a code needs someone signed in, and lasts ten minutes', async () => {
    assert.equal((await client(srv.base).post('/admin/pairing', {})).status, 401);
    const r = await admin(srv.base).post('/admin/pairing', {});
    assert.equal(r.status, 201);
    assert.match(r.json.code, /^[A-Za-z0-9_-]{22}$/);
    const minutes = (Date.parse(r.json.expires_at) - Date.now()) / 60_000;
    // The database's clock, not this process's: a few milliseconds apart.
    assert.ok(minutes > 9.9 && minutes < 10.1, `expires in ${minutes} minutes`);
  });

  test('the code is traded once, without the admin token, for a device token that reads /admin', async () => {
    const code = await newCode();
    const r = await pairWith(code, 'Ana’s iPhone');
    assert.equal(r.status, 201);
    assert.match(r.json.token, /^hush_device_/);
    assert.equal(r.json.device.name, 'Ana’s iPhone');
    assert.equal((await as(r.json.token).get('/admin/apps')).status, 200);
    assert.equal((await pairWith(code)).status, 404, 'a used code is gone');
  });

  test('only hashes are stored', async () => {
    const code = await newCode();
    const { token } = (await pairWith(code)).json;
    const { rows } = await db.query('SELECT token_hash FROM admin_devices');
    assert.ok(rows.every((r) => !r.token_hash.includes(token) && r.token_hash.length === 64));
    const pairings = await db.query('SELECT code_hash FROM admin_pairings');
    assert.ok(pairings.rows.every((r) => r.code_hash !== code));
  });

  test('an unknown or expired code is refused', async () => {
    assert.equal((await pairWith('not-a-code-at-all-000')).status, 404);
    const code = await newCode();
    await db.query("UPDATE admin_pairings SET expires_at = now() - interval '1 second'");
    assert.equal((await pairWith(code)).status, 404);
    assert.equal((await client(srv.base).post('/admin/pair', {})).status, 400);
  });

  test('pairing takes JSON only', async () => {
    const r = await client(srv.base).post('/admin/pair', 'code=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });

  test('a long name is cut, and no name is iPhone', async () => {
    const long = (await pairWith(await newCode(), 'x'.repeat(200))).json.device;
    assert.equal(long.name.length, 80);
    const none = (await client(srv.base).post('/admin/pair', { code: await newCode() })).json.device;
    assert.equal(none.name, 'iPhone');
  });

  test('only the five newest codes stay live', async () => {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push(await newCode());
    assert.equal((await pairWith(codes[0])).status, 404);
    assert.equal((await pairWith(codes[6])).status, 201);
  });
});

describe('devices', () => {
  test('are listed with when they were last seen, and revoked at once', async () => {
    const { token, device } = (await pairWith(await newCode(), 'Revoke me')).json;
    await as(token).get('/admin/apps');
    const listed = (await admin(srv.base).get('/admin/devices')).json.devices.find((d) => d.id === device.id);
    assert.equal(listed.name, 'Revoke me');
    assert.ok(listed.last_seen_at);
    assert.equal(Object.hasOwn(listed, 'token_hash'), false);

    assert.equal((await admin(srv.base).delete(`/admin/devices/${device.id}`, {})).status, 200);
    // Cached a moment ago, refused now: revoking clears the cache.
    assert.equal((await as(token).get('/admin/apps')).status, 401);
    assert.equal((await admin(srv.base).delete(`/admin/devices/${device.id}`, {})).status, 404);
  });

  test('a device can revoke itself, as the app does when a server is removed', async () => {
    const { token, device } = (await pairWith(await newCode())).json;
    assert.equal((await as(token).delete(`/admin/devices/${device.id}`, {})).status, 200);
    assert.equal((await as(token).get('/admin/apps')).status, 401);
  });

  test('a made-up device token is refused', async () => {
    assert.equal((await as('hush_device_madeup').get('/admin/apps')).status, 401);
  });

  test('pairing is rate limited per address', async () => {
    const c = client(srv.base, undefined, { ip: '203.0.113.77' });
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post('/admin/pair', { code: `guess-${i}` })).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
    assert.equal(statuses[10], 429);
  });
});
