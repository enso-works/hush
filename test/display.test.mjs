// /display/*: read-only counts for a screen, on a token that opens nothing else.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { ADMIN_TOKEN, addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';

const TOKEN = 'display-token-0123456789-0123456789';
const screen = (base, options) => client(base, `Bearer ${TOKEN}`, options);

const INSTALL = uuid();
const MESSAGE = 'a sentence only the ticket holds';
const EMAIL = 'private.person@example.com';
const PROJECT = 'proj-secret-id';
const RC_ERROR = 'an error only the operator should see';

let db, srv, key;

before(async () => {
  db = await freshDatabase('hush_display');
  srv = await startServer(db, { DISPLAY_TOKEN: TOKEN });
  key = await addApp(db, 'braele', 'Braele');
  const c = client(srv.base, key);
  await c.post('/v1/events', batch([event(INSTALL, 'app_first_opened'), event(INSTALL, 'session_started')]));
  assert.ok((await c.post('/v1/tickets', { install: INSTALL, kind: 'love', message: MESSAGE })).status < 300);
  assert.ok((await c.post('/v1/tickets', { install: uuid(), kind: 'love', message: MESSAGE, email: EMAIL })).status < 300);
  await db.query('INSERT INTO rc_projects (app, project_id, name, last_error) VALUES ($1, $2, $3, $4)', ['braele', PROJECT, 'Braele', RC_ERROR]);
  await db.query('INSERT INTO rc_overview (app, currency, metrics) VALUES ($1, $2, $3)', ['braele', 'EUR', JSON.stringify({ mrr: 42 })]);
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

describe('auth', () => {
  test('no token or a wrong one is 401', async () => {
    assert.equal((await client(srv.base).get('/display/v1/overview')).status, 401);
    assert.equal((await client(srv.base, 'Bearer wrong').get('/display/v1/overview')).status, 401);
  });

  test('the admin token does not open it, and the display token does not open /admin', async () => {
    assert.equal((await client(srv.base, `Bearer ${ADMIN_TOKEN}`).get('/display/v1/overview')).status, 401);
    assert.equal((await screen(srv.base).get('/admin/apps')).status, 401);
    assert.equal((await screen(srv.base).get('/admin/tickets')).status, 401);
    assert.equal((await screen(srv.base).get('/v1/config')).status, 401);
  });

  test('five wrong tokens a minute from one address, then 429, and the right token still works', async () => {
    const ip = '203.0.113.91';
    const guesser = client(srv.base, 'Bearer guess', { ip });
    for (let i = 0; i < 5; i++) assert.equal((await guesser.get('/display/v1/overview')).status, 401);
    assert.equal((await guesser.get('/display/v1/overview')).status, 429);
    assert.equal((await screen(srv.base, { ip }).get('/display/v1/overview')).status, 200);
    assert.equal((await client(srv.base, 'Bearer guess').get('/display/v1/overview')).status, 401, 'another address is not limited');
  });

  test('30 requests a minute from one address, then 429', async () => {
    const c = screen(srv.base, { ip: '203.0.113.92' });
    for (let i = 0; i < 30; i++) assert.equal((await c.get('/display/v1/overview')).status, 200);
    assert.equal((await c.get('/display/v1/overview')).status, 429);
  });

  test('it only reads', async () => {
    assert.equal((await screen(srv.base).post('/display/v1/overview', {})).status, 404);
    assert.equal((await screen(srv.base).delete('/display/v1/apps/braele')).status, 404);
  });
});

describe('what it serves', () => {
  test('overview: every app, its counts, the revenue card', async () => {
    const r = await screen(srv.base).get('/display/v1/overview');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.json.days, 7);
    assert.equal(r.json.open_tickets, 2);
    const app = r.json.apps.find((a) => a.app === 'braele');
    assert.equal(app.name, 'Braele');
    assert.equal(app.total_installs, 1);
    assert.equal(app.dau, 1);
    assert.equal(app.open_tickets, 2);
    assert.equal(app.trend.length, 7);
    assert.deepEqual(r.json.revenue.map(({ app: a, currency, metrics }) => ({ a, currency, metrics })), [{ a: 'braele', currency: 'EUR', metrics: { mrr: 42 } }]);
  });

  test('one app: the charts, and a slug it does not have is 404', async () => {
    const r = await screen(srv.base).get('/display/v1/apps/braele?days=30');
    assert.equal(r.status, 200);
    assert.equal(r.json.days, 30);
    assert.equal(r.json.app, 'braele');
    assert.equal(r.json.tickets, 2);
    assert.ok(r.json.funnel.length > 0);
    assert.ok(r.json.retention.d1);
    assert.equal(r.json.revenue.currency, 'EUR');
    assert.equal((await screen(srv.base).get('/display/v1/apps/nope')).status, 404);
  });

  test('a period it does not offer falls back to a week', async () => {
    assert.equal((await screen(srv.base).get('/display/v1/overview?days=365')).json.days, 7);
    assert.equal((await screen(srv.base).get('/display/v1/overview?days=30')).json.days, 30);
  });

  test('neither route carries anything a person wrote, one install, or the operator\'s RevenueCat details', async () => {
    for (const path of ['/display/v1/overview', '/display/v1/apps/braele', '/display/v1/apps/braele?days=30']) {
      const { text } = await screen(srv.base).get(path);
      for (const secret of [MESSAGE, EMAIL, INSTALL, PROJECT, RC_ERROR, key]) {
        assert.ok(!text.includes(secret), `${path} leaked ${secret}`);
      }
    }
  });

  test('production only: dev events are not counted', async () => {
    const devKey = await addApp(db, 'devonly', 'Dev Only', 'dev');
    await client(srv.base, devKey).post('/v1/events', batch([event(uuid(), 'session_started')]));
    const r = await screen(srv.base).get('/display/v1/overview?days=90');
    assert.equal(r.json.apps.find((a) => a.app === 'devonly')?.total_installs ?? 0, 0);
  });

  test('answers come from a cache: new events do not change them within the minute', async () => {
    const first = await screen(srv.base).get('/display/v1/overview?days=1');
    await client(srv.base, key).post('/v1/events', batch([event(uuid(), 'app_first_opened')]));
    const second = await screen(srv.base).get('/display/v1/overview?days=1');
    assert.equal(second.json.generated_at, first.json.generated_at);
    assert.deepEqual(second.json.apps, first.json.apps);
    const live = await admin(srv.base).get('/admin/apps?days=1');
    assert.equal(live.json.apps.find((a) => a.app === 'braele').total_installs, first.json.apps.find((a) => a.app === 'braele').total_installs + 1);
  });
});

describe('off unless configured', () => {
  for (const [label, env] of [['without a token', {}], ['with a short token', { DISPLAY_TOKEN: 'too-short' }]]) {
    test(`${label} the routes do not exist`, async () => {
      const otherDb = await freshDatabase('hush_display_off');
      const other = await startServer(otherDb, env);
      try {
        assert.equal((await client(other.base).get('/display/v1/overview')).status, 404);
        assert.equal((await client(other.base, 'Bearer too-short').get('/display/v1/overview')).status, 404);
      } finally {
        await other.stop();
        await otherDb.drop();
      }
    });
  }
});
