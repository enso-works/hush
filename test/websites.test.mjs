// Websites (docs/web.md): a catalog entry marked "kind": "website" is shown
// as a website and names the apps it sells.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, freshDatabase, startServer } from './helpers.mjs';

const CATALOG_FILE = join(tmpdir(), 'hush-test-websites.json');
writeFileSync(CATALOG_FILE, JSON.stringify({
  'rallo-site': { kind: 'website', promotes: ['tennis'] },
  'braele-site': { kind: 'website', promotes: ['braele', 'tennis'] },
  tennis: { events: ['match_started'] },
}));

let db, srv, inProcess;
before(async () => {
  db = await freshDatabase('hush_websites');
  srv = await startServer(db, { CATALOG_FILE });
  await addApp(db, 'rallo-site', 'Rallo site');
  await addApp(db, 'tennis', 'Rallo');
  process.env.DATABASE_URL = db.url;
  process.env.CATALOG_FILE = CATALOG_FILE;
  inProcess = {
    catalog: await import('../src/catalog.mjs'),
    db: await import('../src/db.mjs'),
  };
});
after(async () => {
  await srv?.stop();
  await inProcess?.db.pool.end();
  await db?.drop();
});

describe('the catalog', () => {
  test('an entry without a kind is an app that promotes nothing', () => {
    const c = inProcess.catalog.parseCatalog({ myapp: { events: ['done_it'] } });
    assert.equal(c.myapp.kind, 'app');
    assert.deepEqual(c.myapp.promotes, []);
  });

  test('a website names the apps it sells, once each', () => {
    const c = inProcess.catalog.parseCatalog({ site: { kind: 'website', promotes: ['myapp', 'other', 'myapp'] } });
    assert.equal(c.site.kind, 'website');
    assert.deepEqual(c.site.promotes, ['myapp', 'other']);
  });

  test('a wrong kind, an app that promotes, a website promoting itself and a bad slug stop the boot', () => {
    const { parseCatalog } = inProcess.catalog;
    assert.throws(() => parseCatalog({ site: { kind: 'site' } }), /catalog\.site\.kind/);
    assert.throws(() => parseCatalog({ myapp: { promotes: ['other'] } }), /only a website promotes/);
    assert.throws(() => parseCatalog({ site: { kind: 'website', promotes: ['site'] } }), /cannot promote itself/);
    assert.throws(() => parseCatalog({ site: { kind: 'website', promotes: ['My App'] } }), /app slugs/);
    assert.throws(() => parseCatalog({ site: { kind: 'website', promotes: 'myapp' } }), /app slugs/);
  });

  test('the server reads the file it was given', () => {
    const { kindOf, promotesOf, promotedBy } = inProcess.catalog;
    assert.equal(kindOf('rallo-site'), 'website');
    assert.equal(kindOf('tennis'), 'app');
    assert.equal(kindOf('not-in-the-catalog'), 'app');
    assert.deepEqual(promotesOf('braele-site'), ['braele', 'tennis']);
    assert.deepEqual(promotedBy('tennis'), ['braele-site', 'rallo-site']);
    assert.deepEqual(promotedBy('rallo-site'), []);
  });
});

describe('the dashboard API', () => {
  test('/admin/apps says which apps are websites and what they sell', async () => {
    const r = await admin(srv.base).get('/admin/apps');
    assert.equal(r.status, 200);
    const bySlug = Object.fromEntries(r.json.apps.map((a) => [a.app, a]));
    assert.deepEqual(
      { kind: bySlug['rallo-site'].kind, promotes: bySlug['rallo-site'].promotes, promoted_by: bySlug['rallo-site'].promoted_by },
      { kind: 'website', promotes: ['tennis'], promoted_by: [] },
    );
    assert.deepEqual(
      { kind: bySlug.tennis.kind, promotes: bySlug.tennis.promotes, promoted_by: bySlug.tennis.promoted_by },
      { kind: 'app', promotes: [], promoted_by: ['braele-site', 'rallo-site'] },
    );
  });

  test('/admin/apps/:app says it too', async () => {
    const r = await admin(srv.base).get('/admin/apps/rallo-site');
    assert.equal(r.status, 200);
    assert.equal(r.json.kind, 'website');
    assert.deepEqual(r.json.promotes, ['tennis']);
  });
});
