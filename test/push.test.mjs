// Push to the hush iOS app: phones sign up with their APNs token, and a new
// ticket or a user's reply reaches the phones that asked for it. Apple is a
// local HTTP/2 server here, which checks what a real one would: the signed
// provider token, the topic and push type, and the path.
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, client, freshDatabase, startServer, uuid } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_ID = 'ABC123DEFG';
const TEAM_ID = 'DGUZG76BA2';

/** A stand-in for APNs: records every push, answers 410 for tokens starting with dead. */
function fakeApple() {
  const pushes = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (c) => (body += c));
    stream.on('end', () => {
      const token = headers[':path'].split('/').pop();
      pushes.push({ headers, token, payload: JSON.parse(body) });
      if (token.startsWith('dead')) {
        stream.respond({ ':status': 410, 'content-type': 'application/json' });
        return stream.end(JSON.stringify({ reason: 'Unregistered' }));
      }
      stream.respond({ ':status': 200 });
      stream.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ pushes, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

let db, srv, key, apple, sandbox;
before(async () => {
  apple = await fakeApple();
  sandbox = await fakeApple();
  db = await freshDatabase('hush_push');
  srv = await startServer(db, {
    APNS_KEY_ID: KEY_ID,
    APNS_TEAM_ID: TEAM_ID,
    APNS_KEY_P8: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    APNS_HOST: apple.url,
    APNS_SANDBOX_HOST: sandbox.url,
  });
  key = await addApp(db, 'game', 'Game');
  await addApp(db, 'other', 'Other');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
  apple?.close();
  sandbox?.close();
});

const token = (prefix = '') => (prefix + uuid().replaceAll('-', '') + uuid().replaceAll('-', '')).slice(0, 64);
const signUp = (body, as = admin(srv.base)) => as.post('/admin/push', body);

/** Waits for the fire-and-forget pushes to arrive. */
async function received(server, n, since = 0) {
  for (let i = 0; i < 100 && server.pushes.length - since < n; i++) await new Promise((r) => setTimeout(r, 30));
  return server.pushes.slice(since);
}

describe('signing up', () => {
  test('the server says whether it can send, and keeps what each phone wants', async () => {
    const t = token();
    const r = await signUp({ token: t.toUpperCase(), label: 'server-1', replies: false, apps: ['game'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true);
    assert.deepEqual(r.json.signup, { token: t, sandbox: false, label: 'server-1', tickets: true, replies: false, apps: ['game'] });
    const read = await admin(srv.base).get(`/admin/push?token=${t}`);
    assert.equal(read.json.signup.replies, false, 'read back by the phone, lowercased');
    // Signing up again changes it.
    assert.equal((await signUp({ token: t, replies: true })).json.signup.replies, true);
    assert.equal((await admin(srv.base).delete(`/admin/push/${t}`, {})).status, 200);
    assert.equal((await admin(srv.base).get(`/admin/push?token=${t}`)).json.signup, null);
  });

  test('a sign-up is checked', async () => {
    for (const body of [{}, { token: 'not hex' }, { token: token(), label: 'x'.repeat(65) }, { token: token(), sandbox: 'yes' }, { token: token(), apps: ['Not A Slug'] }]) {
      assert.equal((await signUp(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await client(srv.base).post('/admin/push', { token: token() })).status, 401, 'only someone signed in');
  });

  test("a paired phone's sign-up goes when the phone is revoked", async () => {
    const code = (await admin(srv.base).post('/admin/pairing', {})).json.code;
    const paired = (await client(srv.base).post('/admin/pair', { code, name: 'Test iPhone' })).json;
    const t = token();
    assert.equal((await signUp({ token: t }, client(srv.base, `Bearer ${paired.token}`))).status, 200);
    const { rows } = await db.query('SELECT device_id::text FROM push_tokens WHERE token = $1', [t]);
    assert.equal(rows[0].device_id, paired.device.id);
    await admin(srv.base).delete(`/admin/devices/${paired.device.id}`, {});
    assert.equal((await db.query('SELECT 1 FROM push_tokens WHERE token = $1', [t])).rowCount, 0);
  });
});

describe('sending', () => {
  test('a new ticket reaches the phones that want it, signed as Apple expects, without an email or an install', async () => {
    await db.query('DELETE FROM push_tokens');
    const all = token();
    const gameOnly = token();
    await signUp({ token: all, label: 'srv-a' });
    await signUp({ token: gameOnly, apps: ['game'] });
    await signUp({ token: token(), apps: ['other'] });
    await signUp({ token: token(), tickets: false });
    const since = apple.pushes.length;

    const r = await client(srv.base, key).post('/v1/tickets', {
      kind: 'issue',
      email: 'ana@example.com',
      subject: 'Timer',
      message: 'The timer stops when the screen locks.',
      diag: { version: '2.0.1' },
    });
    assert.equal(r.status, 201);
    const got = await received(apple, 2, since);
    await new Promise((res) => setTimeout(res, 150));
    assert.deepEqual(apple.pushes.slice(since).map((p) => p.token).sort(), [all, gameOnly].sort(), 'only those two');

    const p = got.find((x) => x.token === all);
    assert.equal(p.headers['apns-topic'], 'com.bavrk.hush');
    assert.equal(p.headers['apns-push-type'], 'alert');
    assert.equal(p.headers[':path'], `/3/device/${all}`);
    const [h, c, s] = p.headers.authorization.replace(/^bearer /, '').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: KEY_ID });
    assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, TEAM_ID);
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'signed with the key');

    assert.deepEqual(p.payload, {
      aps: {
        alert: { title: 'New problem in Game', subtitle: 'Timer', body: 'The timer stops when the screen locks.' },
        sound: 'default',
        'thread-id': `ticket-${r.json.id}`,
        category: 'TICKET',
      },
      ticket: String(r.json.id),
      app: 'game',
      server: 'srv-a',
    });
    assert.ok(!JSON.stringify(got).includes('ana@example.com'), 'never the email');
  });

  test("a user's reply reaches phones that want replies; a development build's goes to the sandbox", async () => {
    await db.query('DELETE FROM push_tokens');
    const dev = token();
    await signUp({ token: dev, sandbox: true });
    await signUp({ token: token(), replies: false });
    const install = uuid();
    const c = client(srv.base, key);
    const t = (await c.post('/v1/tickets', { install, kind: 'feature', message: 'Dark mode, please.', diag: {} })).json;
    await received(sandbox, 1, sandbox.pushes.length);
    const since = sandbox.pushes.length;
    const appleSince = apple.pushes.length;
    assert.equal((await c.post(`/v1/tickets/${t.id}/reply`, { install, body: 'Any news?' })).status, 201);
    const [p] = await received(sandbox, 1, since);
    assert.equal(p.token, dev);
    assert.equal(p.payload.aps.alert.title, 'Reply in Game');
    assert.equal(p.payload.aps.alert.body, 'Any news?');
    assert.ok(!JSON.stringify(p.payload).includes(install), 'never the install');
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(apple.pushes.length, appleSince, 'the phone without replies got nothing');
  });

  test("a token Apple says is gone is forgotten", async () => {
    await db.query('DELETE FROM push_tokens');
    const gone = token('dead');
    await signUp({ token: gone });
    const since = apple.pushes.length;
    await client(srv.base, key).post('/v1/tickets', { install: uuid(), kind: 'love', message: 'Lovely.', diag: {} });
    await received(apple, 1, since);
    for (let i = 0; i < 50 && (await db.query('SELECT 1 FROM push_tokens WHERE token = $1', [gone])).rowCount; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal((await db.query('SELECT 1 FROM push_tokens WHERE token = $1', [gone])).rowCount, 0);
  });

  test('a test push, from the app', async () => {
    const t = token();
    await signUp({ token: t });
    const since = apple.pushes.length;
    assert.equal((await admin(srv.base).post('/admin/push/test', { token: t })).status, 200);
    const [p] = await received(apple, 1, since);
    assert.equal(p.payload.aps.alert.title, 'hush');
    assert.equal((await admin(srv.base).post('/admin/push/test', { token: token() })).status, 404);
  });
});
