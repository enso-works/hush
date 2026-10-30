// Websites (docs/web.md): a catalog entry marked "kind": "website" is shown
// as a website and names the apps it sells, and a crawler's batch is answered
// as stored without making a visitor of it.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';

const CATALOG_FILE = join(tmpdir(), 'hush-test-websites.json');
writeFileSync(CATALOG_FILE, JSON.stringify({
  'rallo-site': { kind: 'website', promotes: ['tennis'] },
  'braele-site': { kind: 'website', promotes: ['braele', 'tennis'] },
  tennis: { events: ['match_started'] },
}));

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const CRAWLERS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Chrome-Lighthouse',
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Lighthouse',
  'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
];
const PEOPLE = [
  SAFARI,
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  // Native apps: never judged, whatever they are called.
  'Chatbot/3 CFNetwork/1568.200.51 Darwin/24.1.0',
  'okhttp/4.12.0',
  undefined,
];

let db, srv, siteKey, tennisKey, inProcess;
before(async () => {
  db = await freshDatabase('hush_websites');
  srv = await startServer(db, { CATALOG_FILE });
  siteKey = await addApp(db, 'rallo-site', 'Rallo site');
  tennisKey = await addApp(db, 'tennis', 'Rallo');
  process.env.DATABASE_URL = db.url;
  process.env.CATALOG_FILE = CATALOG_FILE;
  inProcess = {
    catalog: await import('../src/catalog.mjs'),
    ingest: await import('../src/ingest.mjs'),
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

describe('crawlers', () => {
  test('isCrawler judges only agents that present as a browser', () => {
    for (const ua of CRAWLERS) assert.equal(inProcess.ingest.isCrawler(ua), true, ua);
    for (const ua of PEOPLE) assert.equal(inProcess.ingest.isCrawler(ua), false, String(ua));
  });

  test("a crawler's batch is answered as stored and leaves no visitor", async () => {
    for (const ua of CRAWLERS) {
      const install = uuid();
      const r = await client(srv.base, siteKey).post('/v1/events', batch([event(install, 'session_started'), event(install, 'page_viewed')], { platform: 'web' }), { 'User-Agent': ua });
      assert.equal(r.status, 200, ua);
      assert.deepEqual(r.json, { accepted: 2, duplicate: 0, rejected: 0 }, ua);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM installs WHERE id = $1', [install])).rows[0].n, 0, ua);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM events WHERE install = $1', [install])).rows[0].n, 0, ua);
    }
  });

  test("a crawler's malformed batch is still refused", async () => {
    const r = await client(srv.base, siteKey).post('/v1/events', { events: [] }, { 'User-Agent': CRAWLERS[0] });
    assert.equal(r.status, 400);
  });

  test('a beacon, with the key in the query and a text/plain body, is stored once however often it comes', async () => {
    const install = uuid();
    const body = JSON.stringify(batch([event(install, 'session_started'), event(install, 'store_clicked', { props: { store: 'app_store' } })], { platform: 'web' }));
    const post = () => fetch(`${srv.base}/v1/events?key=${encodeURIComponent(siteKey)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': '198.51.100.7' }, body });
    let r = await post();
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { accepted: 2, duplicate: 0, rejected: 0 });
    r = await post();
    assert.deepEqual(await r.json(), { accepted: 0, duplicate: 2, rejected: 0 });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM events WHERE install = $1', [install])).rows[0].n, 2);
  });

  test('a key in the query opens nothing but events', async () => {
    const r = await fetch(`${srv.base}/v1/config?key=${encodeURIComponent(siteKey)}`);
    assert.equal(r.status, 401);
    const bad = await fetch(`${srv.base}/v1/events?key=hush_nobody_prod_x`, { method: 'POST', body: '{}' });
    assert.equal(bad.status, 401);
  });

  test('people and native apps are stored', async () => {
    for (const ua of PEOPLE) {
      const install = uuid();
      const r = await client(srv.base, tennisKey).post('/v1/events', batch([event(install, 'session_started')]), ua ? { 'User-Agent': ua } : {});
      assert.equal(r.status, 200, String(ua));
      assert.deepEqual(r.json, { accepted: 1, duplicate: 0, rejected: 0 }, String(ua));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM installs WHERE id = $1', [install])).rows[0].n, 1, String(ua));
    }
  });
});

describe('/hush.js', () => {
  test('the script tag build, from any site, with the SDK version it was built from', async () => {
    const res = await fetch(`${srv.base}/hush.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.text();
    const core = readFileSync(new URL('../sdk/src/core.ts', import.meta.url), 'utf8');
    const version = /export const SDK_VERSION = '([^']+)'/.exec(core)[1];
    assert.ok(body.includes(`"${version}"`), `built from SDK ${version}: run npm run build:script in sdk/`);
  });
});

describe('a website\'s reports', () => {
  let shopKey;
  before(async () => {
    shopKey = await addApp(db, 'braele-site', 'Braele site');
    const send = (install, device, platform, events) =>
      client(srv.base, shopKey).post('/v1/events', batch(events, { platform, os: '', device, version: '', build: '' }));
    const visit = (install, props, rest) => {
      const session = uuid();
      return [event(install, 'session_started', { session, props }), ...rest.map(([name, p]) => event(install, name, { session, props: p ?? {} }))];
    };
    const [a, b, c] = [uuid(), uuid(), uuid()];
    const meta = { entry: 'link', n: 1, utm_source: 'meta', utm_campaign: 'autumn' };
    // An ad, two pages, a store click: engaged, and the goal.
    await send(a, 'iPhone', 'ios', visit(a, meta, [['screen_viewed', { screen: '/' }], ['screen_viewed', { screen: '/features' }], ['store_clicked', { store: 'app_store', campaign: 'autumn' }]]));
    // From a search, one page, gone: a bounce. Back later, straight, ten seconds in view.
    await send(b, 'Mac', 'web', [
      ...visit(b, { entry: 'referral', n: 1, referrer: 'google.com' }, [['screen_viewed', { screen: '/blog' }]]),
      ...visit(b, { entry: 'launch', n: 2 }, [['screen_viewed', { screen: '/' }], ['visit_engaged']]),
    ]);
    // The same ad on Android: a link out, no store click.
    await send(c, 'Android phone', 'android', visit(c, meta, [['screen_viewed', { screen: '/' }], ['link_clicked', { host: 'x.com' }]]));
    // What App Store Connect counted for the campaign the site passed on as ct.
    await db.query(
      `INSERT INTO asc_campaigns (app, kind, day, campaign, source_type, metric, value, processing_date)
       VALUES ('tennis', 'downloads', current_date, 'autumn', 'Web referrer', 'first_downloads', 4, current_date),
              ('tennis', 'engagement', current_date, 'autumn', 'Web referrer', 'page_views', 30, current_date)`,
    );
  });

  test('visitors, visits, engaged visits and the goal, which is a store click when the catalog names none', async () => {
    const r = await admin(srv.base).get('/admin/apps/braele-site/web?days=7');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.goal, { event: 'store_clicked' });
    assert.deepEqual(r.json.current, { visitors: 3, visits: 4, engaged: 3, pageviews: 5, goal_visits: 1, goal_visitors: 1, new_visitors: 3 });
    assert.equal(r.json.prior.visits, 0);
    assert.equal(r.json.daily.length, 7);
    assert.equal(r.json.daily.at(-1).visits, 4);
  });

  test('sources by tag, then referrer, then direct; campaigns; the page each visit landed on', async () => {
    const { json } = await admin(srv.base).get('/admin/apps/braele-site/web?days=7');
    const by = (rows, key) => Object.fromEntries(rows.map((row) => [row[key], row]));
    const sources = by(json.sources, 'source');
    assert.deepEqual(sources.meta, { source: 'meta', kind: 'tag', visits: 2, visitors: 2, engaged: 2, goal_visits: 1 });
    assert.deepEqual(sources['google.com'], { source: 'google.com', kind: 'referrer', visits: 1, visitors: 1, engaged: 0, goal_visits: 0 });
    assert.deepEqual(sources.direct, { source: 'direct', kind: 'direct', visits: 1, visitors: 1, engaged: 1, goal_visits: 0 });
    assert.deepEqual(json.campaigns, [{ campaign: 'autumn', source: 'meta', visits: 2, visitors: 2, engaged: 2, goal_visits: 1 }]);
    assert.deepEqual(by(json.landing, 'page')['/'], { page: '/', visits: 3, engaged: 3, goal_visits: 1 });
    assert.deepEqual(by(json.landing, 'page')['/blog'], { page: '/blog', visits: 1, engaged: 0, goal_visits: 0 });
    assert.deepEqual(by(json.pages, 'page')['/'], { page: '/', views: 3, visitors: 3 });
  });

  test('phones apart from desktops, since only a phone installs from a store link; stores and links clicked', async () => {
    const { json } = await admin(srv.base).get('/admin/apps/braele-site/web?days=7');
    const devices = Object.fromEntries(json.devices.map((d) => [d.device, d]));
    assert.deepEqual(devices.phone, { device: 'phone', visits: 2, visitors: 2, engaged: 2, goal_visits: 1 });
    assert.deepEqual(devices.desktop, { device: 'desktop', visits: 2, visitors: 1, engaged: 1, goal_visits: 0 });
    assert.deepEqual(json.stores, [{ value: 'app_store', clicks: 1, visitors: 1 }]);
    assert.deepEqual(json.links, [{ value: 'x.com', clicks: 1, visitors: 1 }]);
    assert.deepEqual(json.countries, [{ country: 'other', visitors: 3 }], 'under ten visitors a country is folded away');
  });

  test("the overview counts a website's goal; an app has none", async () => {
    const { json } = await admin(srv.base).get('/admin/apps?days=7');
    const bySlug = Object.fromEntries(json.apps.map((a) => [a.app, a]));
    assert.deepEqual(bySlug['braele-site'].goal, { event: 'store_clicked', visits: 1 });
    assert.equal(bySlug.tennis.goal, null);
  });

  test("an app's websites: their visits, and store clicks per campaign beside App Store Connect's count for it", async () => {
    const { json } = await admin(srv.base).get('/admin/apps/tennis/websites?days=7');
    assert.deepEqual(json.websites.map((w) => w.app), ['braele-site', 'rallo-site']);
    assert.deepEqual(json.websites[0], { app: 'braele-site', name: 'Braele site', visitors: 3, visits: 4, store_clicks: 1, store_visits: 1 });
    const autumn = json.campaigns.find((c) => c.campaign === 'autumn');
    assert.deepEqual(autumn, { campaign: 'autumn', store_clicks: 1, visits: 1, app_store: { page_views: 30, first_downloads: 4 } });
    const none = await admin(srv.base).get('/admin/apps/braele/websites?days=7');
    assert.deepEqual(none.json.websites.map((w) => w.app), ['braele-site']);
  });
});
