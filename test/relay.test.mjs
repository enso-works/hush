// The push relay: a server without an APNs key notifies the App Store app
// through it. Two hush servers here, the relay (with the key) and one hosted
// by someone else (without), and Apple as a local HTTP/2 server. The relay
// must see the token and an opaque blob, never what was written.
import assert from 'node:assert/strict';
import { createDecipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, client, freshDatabase, startServer, uuid } from './helpers.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

function fakeApple() {
  const pushes = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (c) => (body += c));
    stream.on('end', () => {
      const token = headers[':path'].split('/').pop();
      pushes.push({ headers, token, raw: body, payload: JSON.parse(body) });
      if (token.startsWith('dead')) {
        stream.respond({ ':status': 410 });
        return stream.end(JSON.stringify({ reason: 'Unregistered' }));
      }
      stream.respond({ ':status': 200 });
      stream.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ pushes, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/** What the notification extension does: CryptoKit's combined form, nonce | ciphertext | tag. */
function open(sealed, key) {
  const b = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
}

let apple, relayDb, relaySrv, hostedDb, hosted, key;
before(async () => {
  apple = await fakeApple();
  relayDb = await freshDatabase('hush_relay');
  relaySrv = await startServer(relayDb, {
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'DGUZG76BA2',
    APNS_KEY_P8: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    APNS_HOST: apple.url,
    APNS_SANDBOX_HOST: apple.url,
    PUSH_RELAY_SECRET: randomBytes(32).toString('hex'),
  });
  hostedDb = await freshDatabase('hush_hosted');
  hosted = await startServer(hostedDb, { PUSH_RELAY: `${relaySrv.base}/push/` });
  key = await addApp(hostedDb, 'game', 'Game');
});
after(async () => {
  await relaySrv?.stop();
  await hosted?.stop();
  await relayDb?.drop();
  await hostedDb?.drop();
  apple?.close();
});

const token = (prefix = '') => (prefix + uuid().replaceAll('-', '') + uuid().replaceAll('-', '')).slice(0, 64);
const register = (t, sandbox = false) => client(relaySrv.base).post('/push/register', { token: t, sandbox });
async function received(n, since) {
  for (let i = 0; i < 100 && apple.pushes.length - since < n; i++) await new Promise((r) => setTimeout(r, 30));
  return apple.pushes.slice(since);
}

/** A phone: a pass from the relay, then a sign-up with the hosted server, with a key of its own. */
async function phone(t = token()) {
  const pass = (await register(t)).json.pass;
  const k = randomBytes(32);
  const r = await admin(hosted.base).post('/admin/push', { token: t, label: 'srv-b', pass, key: k.toString('base64') });
  assert.equal(r.status, 200);
  return { token: t, key: k, pass };
}

describe('the relay', () => {
  test('a server without a key says it pushes through the relay', async () => {
    const r = await admin(hosted.base).get('/admin/push');
    assert.deepEqual([r.json.configured, r.json.via], [true, 'relay']);
    assert.equal((await client(hosted.base).post('/push/register', { token: token() })).status, 404, 'a server is not a relay unless it says so');
  });

  test("a new ticket reaches the phone sealed: the relay forwards a blob only the phone opens", async () => {
    await hostedDb.query('DELETE FROM push_tokens');
    const p = await phone();
    const since = apple.pushes.length;
    const r = await client(hosted.base, key).post('/v1/tickets', {
      kind: 'issue', email: 'ana@example.com', subject: 'Timer', message: 'The timer stops when the screen locks.', diag: {},
    });
    assert.equal(r.status, 201);
    const [push] = await received(1, since);
    assert.equal(push.token, p.token);
    assert.equal(push.headers['apns-topic'], 'com.bavrk.hush');
    assert.equal(push.payload.aps['mutable-content'], 1, 'the extension opens it');
    assert.equal(push.payload.aps.category, 'TICKET', 'with Reply and Close');
    assert.equal(push.payload.server, 'srv-b');
    assert.ok(push.payload.aps['thread-id'] && !push.payload.aps['thread-id'].includes(String(r.json.id)), 'a stack per ticket, by an opaque id');
    for (const secret of ['Timer', 'timer stops', 'ana@example.com', 'Game']) {
      assert.ok(!push.raw.includes(secret), `the relay never sees "${secret}"`);
    }
    assert.deepEqual(open(push.payload.sealed, p.key), {
      title: 'New problem in Game', subtitle: 'Timer', body: 'The timer stops when the screen locks.',
      ticket: String(r.json.id), app: 'game', server: 'srv-b',
    });
  });

  test("a pass is one token's: not another's, not made up", async () => {
    const a = token();
    const pass = (await register(a)).json.pass;
    const send = (t, pass, sandbox = false) => client(relaySrv.base).post('/push/send', { token: t, sandbox, pass, sealed: Buffer.alloc(64).toString('base64') });
    assert.equal((await send(token(), pass)).status, 403, "another token's pass");
    assert.equal((await send(a, pass, true)).status, 403, 'the sandbox has passes of its own');
    assert.equal((await send(a, 'x'.repeat(43))).status, 403, 'a made-up pass');
    assert.equal((await send(a, pass)).status, 200);
    assert.equal((await client(relaySrv.base).post('/push/send', { token: a, pass, sealed: 'not base64!' })).status, 400);
  });

  test('a phone Apple says is gone is forgotten by the server that pushed', async () => {
    await hostedDb.query('DELETE FROM push_tokens');
    const p = await phone(token('dead'));
    const since = apple.pushes.length;
    await client(hosted.base, key).post('/v1/tickets', { install: uuid(), kind: 'love', message: 'Lovely.', diag: {} });
    await received(1, since);
    for (let i = 0; i < 50 && (await hostedDb.query('SELECT 1 FROM push_tokens WHERE token = $1', [p.token])).rowCount; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal((await hostedDb.query('SELECT 1 FROM push_tokens WHERE token = $1', [p.token])).rowCount, 0);
  });

  test('a test push goes through the relay too', async () => {
    const p = await phone();
    const since = apple.pushes.length;
    assert.equal((await admin(hosted.base).post('/admin/push/test', { token: p.token })).status, 200);
    const [push] = await received(1, since);
    assert.equal(open(push.payload.sealed, p.key).title, 'hush');
  });

  test('a server with a key of its own can still test the relay, and the push arrives sealed', async () => {
    const db = await freshDatabase('hush_keyed');
    const keyed = await startServer(db, {
      APNS_KEY_ID: 'ABC123DEFG',
      APNS_TEAM_ID: 'DGUZG76BA2',
      APNS_KEY_P8: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      APNS_HOST: apple.url,
      PUSH_RELAY: `${relaySrv.base}/push`,
    });
    try {
      const t = token();
      const pass = (await register(t)).json.pass;
      const k = randomBytes(32);
      await admin(keyed.base).post('/admin/push', { token: t, label: 'srv-c', pass, key: k.toString('base64') });
      let since = apple.pushes.length;
      assert.equal((await admin(keyed.base).post('/admin/push/test', { token: t })).status, 200);
      let [push] = await received(1, since);
      assert.equal(push.payload.aps.alert.title, 'hush', 'with its own key: straight to Apple, in the clear');
      assert.equal(push.payload.sealed, undefined);
      since = apple.pushes.length;
      assert.equal((await admin(keyed.base).post('/admin/push/test', { token: t, via: 'relay' })).status, 200);
      [push] = await received(1, since);
      assert.equal(open(push.payload.sealed, k).title, 'hush', 'through the relay: sealed');
    } finally {
      await keyed.stop();
      await db.drop();
    }
  });

  test('one phone is pushed at most 20 times a minute', async () => {
    const t = token();
    const pass = (await register(t)).json.pass;
    const codes = [];
    for (let i = 0; i < 22; i++) {
      codes.push((await client(relaySrv.base).post('/push/send', { token: t, pass, sealed: Buffer.alloc(64).toString('base64') })).status);
    }
    assert.deepEqual([codes.slice(0, 20).every((c) => c === 200), codes.at(-1)], [true, 429]);
  });
});
