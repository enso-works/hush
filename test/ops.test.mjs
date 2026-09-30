// Running the dashboard for real behind a proxy: how it learns it is signed
// in, why admin writes must be same-origin JSON, and the charts a catalog
// pins to an app's page.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';

const CATALOG_FILE = join(tmpdir(), 'hush-test-ops.json');
writeFileSync(CATALOG_FILE, JSON.stringify({
  game: {
    events: ['match_finished', 'tutorial_finished'],
    breakdowns: [
      { event: 'match_finished', prop: 'difficulty', title: 'Matches by difficulty' },
      { event: 'tutorial_finished', prop: 'how', count: 'installs' },
    ],
  },
}));

let db, srv, key;
before(async () => {
  db = await freshDatabase('hush_ops');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'game', 'Game');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

describe('signing the dashboard in', () => {
  test('/admin/session: 401 without the token, and not a demo with it', async () => {
    assert.equal((await client(srv.base).get('/admin/session')).status, 401);
    assert.deepEqual((await admin(srv.base).get('/admin/session')).json, { demo: false });
  });

  test('an admin write must be JSON and not from another site, even with the token', async () => {
    const id = uuid();
    await client(srv.base, key).post('/v1/events', batch([event(id, 'session_started')]));
    const path = `/admin/installs/${id}/forget`;
    const form = await admin(srv.base).post(path, 'install=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 403, 'a form post, which any page can make');
    const crossSite = await admin(srv.base).post(path, {}, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const ok = await admin(srv.base).post(path, {}, { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.deleted.installs, 1);
  });
});

describe('catalog breakdowns', () => {
  test('pinned to the app page in catalog order, with a title made up when there is none', async () => {
    const d = (await admin(srv.base).get('/admin/apps/game?days=7')).json;
    assert.deepEqual(d.breakdowns, [
      { event: 'match_finished', prop: 'difficulty', title: 'Matches by difficulty', count: 'events' },
      { event: 'tutorial_finished', prop: 'how', title: 'Tutorial finished by how', count: 'installs' },
    ]);
    const plain = await addApp(db, 'plain', 'Plain');
    assert.ok(plain);
    assert.deepEqual((await admin(srv.base).get('/admin/apps/plain')).json.breakdowns, []);
  });

  test('a bad breakdown stops the boot, naming it', async () => {
    const bad = join(tmpdir(), 'hush-test-ops-bad.json');
    writeFileSync(bad, JSON.stringify({ game: { breakdowns: [{ event: 'match_finished', prop: 'Difficulty' }] } }));
    const d = await freshDatabase('hush_ops_bad');
    try {
      await assert.rejects(startServer(d, { CATALOG_FILE: bad }), /catalog\.game\.breakdowns\[0\]\.prop/);
    } finally {
      await d.drop();
    }
  });
});
