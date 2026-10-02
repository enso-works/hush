// A catalog's private_screens: the server never stores a view of one (or of a
// screen under one), nor a prop that names one, and deletes the ones stored
// before the catalog named them. The /v1 answer stays what shipped SDKs
// expect: a discarded view counts as accepted.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';

const CATALOG_FILE = join(tmpdir(), 'hush-test-private-screens.json');
writeFileSync(CATALOG_FILE, JSON.stringify({
  braele: { events: ['feature_used'], private_screens: ['support', 'settings/account'] },
  other: { events: ['feature_used'] },
}));
// The same apps before the catalog named any private screen.
const OPEN_CATALOG = join(tmpdir(), 'hush-test-private-screens-open.json');
writeFileSync(OPEN_CATALOG, JSON.stringify({ braele: { events: ['feature_used'] }, other: { events: ['feature_used'] } }));

let db, srv, key, otherKey, inProcess;
before(async () => {
  db = await freshDatabase('hush_private');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'braele', 'Braele');
  otherKey = await addApp(db, 'other', 'Other');
  // The sweep and the catalog in this process, against this file's database
  // and catalog: both are read once, at import.
  process.env.DATABASE_URL = db.url;
  process.env.CATALOG_FILE = CATALOG_FILE;
  inProcess = {
    catalog: await import('../src/catalog.mjs'),
    sweep: await import('../src/sweep.mjs'),
    db: await import('../src/db.mjs'),
  };
});
after(async () => {
  await srv?.stop();
  await inProcess?.db.pool.end();
  await db?.drop();
});

const view = (install, screen, props = {}) => event(install, 'screen_viewed', { props: { screen, ...props } });
const screensOf = async (install, d = db) =>
  (await d.query("SELECT props->>'screen' AS s FROM events WHERE install = $1 AND name = 'screen_viewed' ORDER BY 1", [install])).rows.map((r) => r.s);
const propsOf = async (install, name, d = db) =>
  (await d.query('SELECT props FROM events WHERE install = $1 AND name = $2 ORDER BY at, id', [install, name])).rows.map((r) => r.props);
// A row the way an instance without the catalog field stored it.
const storeRaw = (d, app, install, name, props) =>
  d.query("INSERT INTO events (id, app, env, install, name, known, at, props) VALUES (gen_random_uuid(), $1, 'prod', $2, $3, true, now(), $4::jsonb)", [app, install, name, JSON.stringify(props)]);

describe('at ingest', () => {
  test('a view of a private screen, or of a screen under one, is accepted and not stored', async () => {
    const install = uuid();
    const r = await client(srv.base, key).post('/v1/events', batch([
      view(install, 'support'),
      view(install, 'support/42'),
      view(install, 'support/new'),
      view(install, 'settings/account'),
      view(install, 'settings/account/delete'),
      view(install, 'home'),
    ]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { accepted: 6, duplicate: 0, rejected: 0 }, 'the answer every shipped SDK expects');
    assert.deepEqual(await screensOf(install), ['home']);
  });

  test('a name that only looks like one is stored', async () => {
    const install = uuid();
    const similar = ['supportive', 'support_faq', 'support-faq', 'Support', 'help/support', 'settings', 'settings/accounts', 'settings/account-old'];
    const r = await client(srv.base, key).post('/v1/events', batch(similar.map((s) => view(install, s))));
    assert.deepEqual(r.json, { accepted: similar.length, duplicate: 0, rejected: 0 });
    assert.deepEqual(await screensOf(install), [...similar].sort());
  });

  test("another app's catalog decides for that app only", async () => {
    const install = uuid();
    await client(srv.base, otherKey).post('/v1/events', batch([view(install, 'support/42'), view(install, 'support')]));
    assert.deepEqual(await screensOf(install), ['support', 'support/42']);
  });

  test('a view naming one in another prop is not stored; any other event loses only that prop', async () => {
    const install = uuid();
    const r = await client(srv.base, key).post('/v1/events', batch([
      view(install, 'home', { from: 'support/42' }),
      view(install, 'library', { prev: 'home' }),
      event(install, 'session_started', { props: { entry: 'launch', n: 2, ref: 'support/7' } }),
      event(install, 'feature_used', { props: { feature: 'share', current_screen: 'support/3', count: 42, ok: true } }),
    ]));
    assert.deepEqual(r.json, { accepted: 4, duplicate: 0, rejected: 0 });
    assert.deepEqual(await screensOf(install), ['library']);
    assert.deepEqual(await propsOf(install, 'session_started'), [{ entry: 'launch', n: 2 }]);
    assert.deepEqual(await propsOf(install, 'feature_used'), [{ feature: 'share', count: 42, ok: true }]);
  });

  test('a batch of nothing but private views is a 200, and the install is still seen', async () => {
    const install = uuid();
    const body = batch([view(install, 'support/1'), view(install, 'support/2')]);
    const r = await client(srv.base, key).post('/v1/events', body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { accepted: 2, duplicate: 0, rejected: 0 });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM events WHERE install = $1', [install])).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM installs WHERE id = $1', [install])).rows[0].n, 1);
    // Nothing was stored for a retry to collide with, so it is accepted again.
    assert.deepEqual((await client(srv.base, key).post('/v1/events', body)).json, { accepted: 2, duplicate: 0, rejected: 0 });
  });

  test('the install page and the breakdown never show one, even before the sweep', async () => {
    const install = uuid();
    await client(srv.base, key).post('/v1/events', batch([view(install, 'home')]));
    await storeRaw(db, 'braele', install, 'screen_viewed', { screen: 'support/9' });
    await storeRaw(db, 'braele', install, 'feature_used', { feature: 'share', current_screen: 'support/9' });
    const page = (await admin(srv.base).get(`/admin/installs/${install}`)).json;
    assert.deepEqual(page.events.filter((e) => e.name === 'screen_viewed').map((e) => e.props.screen), ['home']);
    assert.deepEqual(page.events.find((e) => e.name === 'feature_used').props, { feature: 'share' });
    assert.ok(!('app' in page.events[0]), 'the events keep their shape');
    const rows = (await admin(srv.base).get('/admin/apps/braele/breakdown?event=screen_viewed&prop=screen&days=7')).json.rows;
    assert.ok(rows.some((x) => x.value === 'home'));
    assert.ok(!rows.some((x) => x.value === 'support' || x.value.startsWith('support/')), JSON.stringify(rows));
  });
});

describe('stored before the catalog named them', () => {
  test('deleted at boot, by every prop, for each app by its own catalog', async () => {
    const d = await freshDatabase('hush_private_boot');
    try {
      let s = await startServer(d, { CATALOG_FILE: OPEN_CATALOG });
      const k = await addApp(d, 'braele');
      const o = await addApp(d, 'other');
      const install = uuid();
      const theirs = uuid();
      await client(s.base, k).post('/v1/events', batch([
        view(install, 'support/42'),
        view(install, 'support'),
        view(install, 'supportive'),
        view(install, 'home', { from: 'support/9' }),
        { ...event(install, 'feature_used', { props: { feature: 'share', current_screen: 'support/3' } }), at: new Date(Date.now() - 2000).toISOString() },
        event(install, 'feature_used', { props: { feature: 'export' } }),
      ]));
      await client(s.base, o).post('/v1/events', batch([view(theirs, 'support/42')]));
      assert.equal((await screensOf(install, d)).length, 4, 'stored while the catalog named none');
      await s.stop();

      s = await startServer(d, { CATALOG_FILE });
      for (let i = 0; i < 50 && !s.logs.join('').includes('private screen views deleted'); i++) await new Promise((r) => setTimeout(r, 100));
      const line = s.logs.join('').split('\n').find((l) => l.includes('private screen views deleted'));
      assert.ok(line, s.logs.join(''));
      assert.deepEqual([JSON.parse(line).events, JSON.parse(line).props_removed_from], [3, 1]);
      assert.deepEqual(await screensOf(install, d), ['supportive']);
      assert.deepEqual(await propsOf(install, 'feature_used', d), [{ feature: 'share' }, { feature: 'export' }]);
      assert.deepEqual(await screensOf(theirs, d), ['support/42'], 'an app whose catalog names none keeps them');
      await s.stop();
    } finally {
      await d.drop();
    }
  });

  test('the periodic sweep deletes them by their screen, and again finds nothing', async () => {
    const install = uuid();
    const theirs = uuid();
    await storeRaw(db, 'braele', install, 'screen_viewed', { screen: 'support/77' });
    await storeRaw(db, 'braele', install, 'screen_viewed', { screen: 'settings/account/delete' });
    await storeRaw(db, 'braele', install, 'screen_viewed', { screen: 'supportive' });
    await storeRaw(db, 'other', theirs, 'screen_viewed', { screen: 'support/77' });
    await inProcess.sweep.sweep();
    assert.deepEqual(await screensOf(install), ['supportive']);
    assert.deepEqual(await screensOf(theirs), ['support/77']);
    assert.deepEqual(await inProcess.sweep.deletePrivateScreens(), { views: 0, stripped: 0 }, 'run again, it finds nothing');
    // The pass at boot reads every prop too: the feature_used stored raw for
    // the install page above loses its current_screen, once.
    assert.deepEqual(await inProcess.sweep.deletePrivateScreens({ everyProp: true }), { views: 0, stripped: 1 });
    assert.deepEqual(await inProcess.sweep.deletePrivateScreens({ everyProp: true }), { views: 0, stripped: 0 });
  });

  test('migration 008 indexes screen views by app and the first segment of the screen', async () => {
    const { rows } = await db.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'events_screen_head_idx'");
    assert.match(rows[0].indexdef, /split_part\(\(props ->> 'screen'::text\), '\/'::text, 1\)/);
    assert.match(rows[0].indexdef, /WHERE \(name = 'screen_viewed'::text\)/);
  });
});

describe('the catalog field', () => {
  const parse = (privateScreens) => inProcess.catalog.parseCatalog({ shop: { private_screens: privateScreens } }).shop.privateScreens;

  test('a list of screen names; none by default', () => {
    assert.deepEqual(parse(['support', 'settings/account', 'support']), ['support', 'settings/account']);
    assert.deepEqual(inProcess.catalog.parseCatalog({ shop: {} }).shop.privateScreens, []);
    assert.deepEqual(parse(null), []);
  });

  test('anything else is refused, naming the path', () => {
    for (const bad of ['support', {}, [''], ['  '], [1], [null], [['support']], ['support/']]) {
      assert.throws(() => parse(bad), /^Error: catalog\.shop\.private_screens: /, JSON.stringify(bad));
    }
  });

  test('a bad one stops the boot', async () => {
    const bad = join(tmpdir(), 'hush-test-private-screens-bad.json');
    writeFileSync(bad, JSON.stringify({ shop: { private_screens: 'support' } }));
    const d = await freshDatabase('hush_private_bad');
    try {
      await assert.rejects(startServer(d, { CATALOG_FILE: bad }), /catalog\.shop\.private_screens/);
    } finally {
      await d.drop();
    }
  });
});
