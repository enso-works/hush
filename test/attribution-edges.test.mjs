// The edges of attribution: every sample Apple publishes, forgeries, strays,
// the catalog's rules for conversion values, campaign funnels' filters and
// windows, and an App Store Connect that pages, restates, refuses and
// stops, as the real one does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';

const CATALOG_FILE = join(tmpdir(), 'hush-test-attribution-edges.json');
writeFileSync(CATALOG_FILE, JSON.stringify({
  shop: {
    app_store_id: 525463029,
    events: ['item_added', 'checkout'],
    funnels: [{ name: 'Buy', window_days: 2, steps: ['app_first_opened', 'item_added', 'checkout'] }],
    conversion_values: [{ value: 10, coarse: 'medium', event: 'checkout', label: 'Bought' }],
  },
  other: { app_store_id: '1111111111' },
  bare: {},
}));

// Apple's samples (storekit/verifying-an-install-validation-postback).
const V4_COARSE = {
  version: '4.0', 'ad-network-id': 'com.example', 'source-identifier': '39', 'app-id': 525463029,
  'transaction-id': '6aafb7a5-0170-41b5-bbe4-fe71dedf1e31', redownload: false, 'source-domain': 'example.com', 'fidelity-type': 1,
  'did-win': true, 'coarse-conversion-value': 'high', 'postback-sequence-index': 0,
  'attribution-signature': 'MEUCIQD4rX6eh38qEhuUKHdap345UbmlzA7KEZ1bhWZuYM8MJwIgMnyiiZe6heabDkGwOaKBYrUXQhKtF3P/ERHqkR/XpuA=',
};
const V3_WIN = {
  version: '3.0', 'ad-network-id': 'example123.skadnetwork', 'campaign-id': 42, 'transaction-id': '6aafb7a5-0170-41b5-bbe4-fe71dedf1e28',
  'app-id': 525463029, 'attribution-signature': 'MEYCIQD5eq3AUlamORiGovqFiHWI4RZT/PrM3VEiXUrsC+M51wIhAPMANZA9c07raZJ64gVaXhB9+9yZj/X6DcNxONdccQij',
  redownload: true, 'source-app-id': 1234567891, 'fidelity-type': 1, 'conversion-value': 20, 'did-win': true,
};
const V3_LOSS = {
  version: '3.0', 'ad-network-id': 'example123.skadnetwork', 'campaign-id': 42, 'transaction-id': 'f9ac267a-a889-44ce-b5f7-0166d11461f0',
  'app-id': 525463029, 'attribution-signature': 'MEUCIQDDetUtkyc/MiQvVJ5I6HIO1E7l598572Wljot2Onzd4wIgVJLzVcyAV+TXksGNoa0DTMXEPgNPeHCmD4fw1ABXX0g=',
  redownload: true, 'fidelity-type': 1, 'did-win': false,
};
const AAK_JWS =
  'eyJraWQiOiJhcHBsZS1kZXZlbG9wbWVudC1pZGVudGlmaWVyXC8xIiwiYWxnIjoiRVMyNTYifQ.eyJwb3N0YmFjay1pZGVudGlmaWVyIjoiODU1NDZFQjctRkQzOS00NEJDLTg5OTAtQzk4QTRBQzM2QTQ5IiwicHVibGlzaGVyLWl0ZW0taWRlbnRpZmllciI6MCwibWFya2V0cGxhY2UtaWRlbnRpZmllciI6ImNvbS5hcHBsZS5BcHBTdG9yZSIsImltcHJlc3Npb24tdHlwZSI6ImFwcC1pbXByZXNzaW9uIiwiYWQtbmV0d29yay1pZGVudGlmaWVyIjoiZGV2ZWxvcG1lbnQuYWRhdHRyaWJ1dGlvbmtpdCIsImRpZC13aW4iOnRydWUsInBvc3RiYWNrLXNlcXVlbmNlLWluZGV4IjowLCJjb252ZXJzaW9uLXR5cGUiOiJyZS1lbmdhZ2VtZW50Iiwic291cmNlLWlkZW50aWZpZXIiOiIxMjM0IiwiYWR2ZXJ0aXNlZC1pdGVtLWlkZW50aWZpZXIiOjEwNzM4MDI3NzU2fQ.bAdNwKd6OfHK9tofvjjua4X_JPcFTxXPQSspD9gZkinw97pY7R1aI-LSjl-oxZZF3_K2H5JK5TSEBee4_1U4oQ';

let db, srv, shopKey;
before(async () => {
  db = await freshDatabase('hush_attr_edges');
  srv = await startServer(db, { CATALOG_FILE });
  shopKey = await addApp(db, 'shop', 'Shop');
  await addApp(db, 'other', 'Other');
  await addApp(db, 'bare', 'Bare');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

const post = (path, body, headers = {}) =>
  fetch(`${srv.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const SKAN = '/.well-known/skadnetwork/report-attribution/';
const AAK = '/.well-known/appattribution/report-attribution/';
const row = async (dedupe) => (await db.query('SELECT * FROM postbacks WHERE dedupe = $1', [dedupe])).rows[0];

describe("every sample Apple publishes, and what isn't one", () => {
  test('SKAdNetwork 4 with only a coarse value (a small campaign)', async () => {
    assert.equal((await post(SKAN, V4_COARSE)).status, 200);
    const r = await row(`skan:${V4_COARSE['transaction-id']}`);
    assert.equal(r.verified, true);
    assert.equal(r.conversion_value, null);
    assert.equal(r.coarse_value, 'high');
    assert.equal(r.source_identifier, '39');
    assert.equal(r.app, 'shop');
  });

  test('SKAdNetwork 3: campaign-id stands in for the source, a redownload, from an app', async () => {
    assert.equal((await post(SKAN, V3_WIN)).status, 200);
    const r = await row(`skan:${V3_WIN['transaction-id']}`);
    assert.deepEqual([r.verified, r.source_identifier, r.redownload, r.conversion_type, r.source_app, r.conversion_value], [true, '42', true, 'redownload', '1234567891', 20]);
  });

  test("a non-winning postback verifies but is not an install of this app's", async () => {
    await post(SKAN, V3_LOSS);
    const r = await row(`skan:${V3_LOSS['transaction-id']}`);
    assert.equal(r.verified, true);
    assert.equal(r.did_win, false);
  });

  test('changing any signed field breaks the signature; an unsigned one does not', async () => {
    await post(SKAN, { ...V4_COARSE, 'transaction-id': '11111111-1111-4111-8111-111111111111' });
    assert.equal((await row('skan:11111111-1111-4111-8111-111111111111')).verified, false, 'transaction id is signed');
    // The coarse value sits outside the signature, as Apple designed it.
    await post(SKAN, { ...V4_COARSE, 'coarse-conversion-value': 'low' });
    assert.equal((await row(`skan:${V4_COARSE['transaction-id']}`)).coarse_value, 'high', 'a retry never overwrites');
  });

  test('AdAttributionKit: a tampered payload and an unknown key are kept unverified', async () => {
    const [h, p, s] = AAK_JWS.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    const forged = [h, Buffer.from(JSON.stringify({ ...payload, 'postback-identifier': 'FORGED-1', 'source-identifier': '9999' })).toString('base64url'), s].join('.');
    await post(AAK, { 'jws-string': forged });
    assert.equal((await row('aak:FORGED-1')).verified, false);
    const otherKid = Buffer.from(JSON.stringify({ kid: 'someone-else/1', alg: 'ES256' })).toString('base64url');
    await post(AAK, { 'jws-string': [otherKid, Buffer.from(JSON.stringify({ ...payload, 'postback-identifier': 'FORGED-2' })).toString('base64url'), s].join('.') });
    assert.equal((await row('aak:FORGED-2')).verified, false);
    await post(AAK, { 'jws-string': 'not.a.jws' });
    await post(AAK, { 'conversion-value': 5 });
    assert.equal((await db.query("SELECT count(*)::int AS n FROM postbacks WHERE dedupe LIKE 'aak:%'")).rows[0].n, 2, 'nothing without an id is stored');
  });

  test('an app id no catalog names is stored without an app, and shown nowhere', async () => {
    const { verified } = await (async () => {
      await post(AAK, { 'jws-string': AAK_JWS });
      return row('aak:85546EB7-FD39-44BC-8990-C98A4AC36A49');
    })();
    assert.equal(verified, true);
    assert.equal((await row('aak:85546EB7-FD39-44BC-8990-C98A4AC36A49')).app, null);
    for (const app of ['shop', 'other', 'bare']) {
      const d = (await admin(srv.base).get(`/admin/apps/${app}/attribution?days=30&env=dev`)).json;
      assert.equal(d.postbacks.campaigns.length, 0, `${app} shows no stray development postback`);
    }
  });

  test('bodies that are not JSON objects are refused, and only POST exists', async () => {
    assert.equal((await post(SKAN, '[1,2]')).status, 400);
    assert.equal((await post(SKAN, '{"a":')).status, 400);
    assert.equal((await fetch(`${srv.base}${SKAN}`)).status, 404);
    assert.equal((await post('/.well-known/other/', {})).status, 404);
  });

  test("the summary counts verified winners by campaign, the values by window, and says how many didn't verify", async () => {
    const d = (await admin(srv.base).get('/admin/apps/shop/attribution?days=30')).json;
    const byCampaign = Object.fromEntries(d.postbacks.campaigns.map((c) => [c.source_identifier, c]));
    assert.equal(byCampaign['39'].installs, 1);
    assert.equal(byCampaign['42'].installs, 2, 'the winning and the non-winning v3 sample');
    assert.equal(byCampaign['42'].redownloads, 2);
    assert.equal(d.postbacks.unverified, 1);
    assert.deepEqual(
      d.postbacks.values.map((v) => [v.conversion_value, v.coarse_value]),
      [[20, null], [null, 'high'], [null, null]],
      'fine values first, then coarse, then the ones Apple reported neither for',
    );
    assert.equal((await admin(srv.base).get('/admin/apps/shop/attribution?days=30')).status, 200);
    assert.equal((await client(srv.base).get('/admin/apps/shop/attribution')).status, 401);
  });
});

describe('conversion values in the catalog', () => {
  test('/v1/config: the app\'s own values, an empty list without any, and CORS for web apps', async () => {
    assert.deepEqual((await client(srv.base, shopKey).get('/v1/config')).json.conversion_values.map((m) => m.value), [10]);
    const bareKey = await addApp(db, 'bare', 'Bare');
    assert.deepEqual((await client(srv.base, bareKey).get('/v1/config')).json, { conversion_values: [] });
    const pre = await fetch(`${srv.base}/v1/config`, { method: 'OPTIONS', headers: { Origin: 'https://game.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(pre.status, 204);
  });

  for (const [name, bad, pattern] of [
    ['a value over 63', [{ value: 64, event: 'checkout' }], /conversion_values\[0\]\.value/],
    ['a coarse value going down', [{ value: 1, coarse: 'high', event: 'a_b' }, { value: 2, coarse: 'low', event: 'c_d' }], /conversion_values\[1\]\.coarse/],
    ['a coarse value that is not one', [{ value: 1, coarse: 'huge', event: 'a_b' }], /conversion_values\[0\]\.coarse/],
    ['a bad event name', [{ value: 1, event: 'Bad Name' }], /conversion_values\[0\]/],
    ['more than twenty', Array.from({ length: 21 }, (_, i) => ({ value: i + 1, event: 'a_b' })), /up to 20/],
  ]) {
    test(`${name} stops the boot`, async () => {
      const file = join(tmpdir(), `hush-test-cv-${uuid()}.json`);
      writeFileSync(file, JSON.stringify({ shop: { conversion_values: bad } }));
      const d = await freshDatabase(`hush_cv_${Math.random().toString(36).slice(2, 8)}`);
      try {
        await assert.rejects(startServer(d, { CATALOG_FILE: file }), pattern);
      } finally {
        await d.drop();
      }
    });
  }

  test('an App Store id that is not digits stops the boot', async () => {
    const file = join(tmpdir(), 'hush-test-bad-store-id.json');
    writeFileSync(file, JSON.stringify({ shop: { app_store_id: 'id123' } }));
    const d = await freshDatabase('hush_bad_store_id');
    try {
      await assert.rejects(startServer(d, { CATALOG_FILE: file }), /app_store_id/);
    } finally {
      await d.drop();
    }
  });
});

describe('campaign funnels', () => {
  before(async () => {
    const c = client(srv.base, shopKey);
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const at = (install, name, m, props) => ({ ...event(install, name, { props }), at: ago(m) });
    const link = (install, m, tags) => at(install, 'session_started', m, { entry: 'link', ...tags });
    const a = uuid();
    const b = uuid();
    const slow = uuid();
    const old = uuid();
    const dev = uuid();
    await c.post('/v1/events', batch([
      at(a, 'app_first_opened', 60), link(a, 60, { utm_source: 'meta', utm_campaign: 'autumn', utm_term: 'broad' }), at(a, 'item_added', 59), at(a, 'checkout', 58),
      link(b, 30, { utm_source: 'meta', utm_campaign: 'autumn', utm_term: 'lookalike' }), at(b, 'item_added', 29),
      // Three days to the first step: outside the catalog funnel's two-day window.
      link(slow, 60 * 24 * 4, { utm_source: 'meta', utm_campaign: 'spring', utm_term: 'broad' }), at(slow, 'item_added', 60 * 24),
      // Twenty days ago: outside a fourteen-day period, inside thirty.
      link(old, 60 * 24 * 20, { utm_source: 'meta', utm_campaign: 'summer' }),
      link(uuid(), 5, { utm_source: 'meta', utm_campaign: '' }),
    ], { channel: 'app_store' }));
    await c.post('/v1/events', batch([link(dev, 10, { utm_source: 'meta', utm_campaign: 'autumn' })], { channel: 'testflight' }));
  });
  const get = (qs) => admin(srv.base).get(`/admin/apps/shop/campaigns?days=30&${qs}`);

  test('by ad set, narrowed to one campaign, through the catalog funnel', async () => {
    const r = (await get('by=utm_term&where=utm_campaign:autumn')).json;
    assert.deepEqual(r.steps.map((s) => s.event), ['item_added', 'checkout']);
    const rows = Object.fromEntries(r.rows.map((x) => [x.value, x]));
    assert.deepEqual([rows.broad.installs, rows.broad.new, rows.broad.steps], [1, 1, [1, 1]]);
    assert.deepEqual([rows.lookalike.installs, rows.lookalike.new, rows.lookalike.steps], [1, 0, [1, 0]]);
  });

  test('the window is the funnel\'s, or the one asked for', async () => {
    const spring = (await get('by=utm_campaign')).json.rows.find((x) => x.value === 'spring');
    assert.deepEqual(spring.steps, [0, 0], 'two days, and the first step came after three');
    const wide = (await get('by=utm_campaign&step=item_added&window=7')).json.rows.find((x) => x.value === 'spring');
    assert.deepEqual(wide.steps, [1]);
  });

  test('the period, the build channel and empty tags', async () => {
    const campaigns = (await get('by=utm_campaign')).json.rows.map((x) => x.value);
    assert.ok(campaigns.includes('summer'));
    assert.ok(!campaigns.includes(''), 'an empty tag is no campaign');
    const fortnight = (await admin(srv.base).get('/admin/apps/shop/campaigns?days=14&by=utm_campaign')).json.rows.map((x) => x.value);
    assert.ok(!fortnight.includes('summer'), 'twenty days ago is out of fourteen');
    const store = (await get('by=utm_campaign&channel=app_store')).json.rows.find((x) => x.value === 'autumn');
    const all = (await get('by=utm_campaign')).json.rows.find((x) => x.value === 'autumn');
    assert.equal(all.installs - store.installs, 1, 'the TestFlight install only without the filter');
    assert.equal((await admin(srv.base).get('/admin/apps/shop/campaigns?days=30&by=utm_campaign&env=dev')).json.rows.length, 0);
  });

  test('what it refuses', async () => {
    assert.equal((await get('where=fbclid:x')).status, 400);
    assert.equal((await get('where=nocolon')).status, 400);
    assert.equal((await get('step=Bad%20Name')).status, 400);
    assert.equal((await get(`${Array.from({ length: 9 }, () => 'step=item_added').join('&')}`)).status, 400);
    assert.equal((await client(srv.base).get('/admin/apps/shop/campaigns')).status, 401);
  });
});

// --- App Store Connect, as a stand-in that behaves like the real one.
const DAY = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
const csv = (rows) => Buffer.from(rows.map((r) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n'));
const tsv = (rows) => gzipSync(Buffer.from(rows.map((r) => r.join('\t')).join('\n')));
const state = { created: 0, refuseCreate: false, stopped: false };
let apple;
const serveApple = () =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const base = `http://127.0.0.1:${s.address().port}`;
      const send = (body, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const files = {
        // Engagement, as a plain CSV with quoted fields and columns in another order.
        '/f/eng.csv': csv([
          ['Campaign', 'Event', 'Date', 'Source Type', 'Counts', 'Unique Counts', 'Page Title'],
          ['meta_autumn', 'Impression', DAY, 'Web referrer', '120', '100', 'Default, "main"'],
          ['meta_autumn', 'Page view', DAY, 'Web referrer', '30', '28', 'Default'],
          ['meta_autumn', 'Tap', DAY, 'Web referrer', '9', '9', 'Default'],
        ]),
        '/f/buy.gz': tsv([['Date', 'Campaign', 'Source Type', 'Purchases', 'Proceeds in USD', 'Paying Users'], [DAY, 'meta_autumn', 'Web referrer', '2', '42.50', '2'], [DAY, 'meta_autumn', 'Web referrer', '1', '1,000.25', '1']]),
        '/f/ses.gz': tsv([['Date', 'Campaign', 'Source Type', 'Sessions', 'Unique Devices'], [DAY, 'meta_autumn', 'Web referrer', '14', '6']]),
        '/f/new.gz': tsv([['Date', 'Campaign', 'Source Type', 'Download Type', 'Counts'], [DAY, 'meta_autumn', 'Web referrer', 'First-time Download', '8']]),
        '/f/old.gz': tsv([['Date', 'Campaign', 'Source Type', 'Download Type', 'Counts'], [DAY, 'meta_autumn', 'Web referrer', 'First-time Download', '5']]),
      };
      if (files[url.pathname]) return res.end(files[url.pathname]);
      if (url.pathname === '/v1/apps/525463029/analyticsReportRequests')
        return send({ data: state.stopped ? [{ id: 'req-old', attributes: { stoppedDueToInactivity: true } }] : [] });
      if (url.pathname === '/v1/analyticsReportRequests' && req.method === 'POST') {
        if (state.refuseCreate) return send({ errors: [{ status: '403', detail: 'The API key in use does not allow this request' }] }, 403);
        state.created++;
        return send({ data: { id: `req-${state.created}` } }, 201);
      }
      if (/^\/v1\/analyticsReportRequests\/req-\d+$/.test(url.pathname)) return send({ data: { attributes: { stoppedDueToInactivity: state.stopped } } });
      if (/^\/v1\/analyticsReportRequests\/req-\d+\/reports$/.test(url.pathname)) {
        // Paged, like Apple: the second page behind links.next.
        if (url.searchParams.get('cursor') !== '2')
          return send({ data: [{ id: 'eng', attributes: { name: 'App Store Discovery and Engagement Detailed' } }, { id: 'pre', attributes: { name: 'App Store Pre-Orders Detailed' } }], links: { next: `${base}${url.pathname}?cursor=2` } });
        return send({ data: [{ id: 'buy', attributes: { name: 'App Store Purchases Detailed' } }, { id: 'ses', attributes: { name: 'App Sessions Detailed' } }, { id: 'dl', attributes: { name: 'App Downloads Detailed' } }, { id: 'dls', attributes: { name: 'App Downloads Standard' } }] });
      }
      const inst = {
        eng: [['i-eng', '2026-09-28', 'eng.csv']],
        buy: [['i-buy', '2026-09-28', 'buy.gz']],
        ses: [['i-ses', '2026-09-28', 'ses.gz']],
        // The newer processing listed first: the older one must not overwrite it.
        dl: [['i-new', '2026-09-29', 'new.gz'], ['i-old', '2026-09-27', 'old.gz']],
      };
      const m = url.pathname.match(/^\/v1\/analyticsReports\/(\w+)\/instances$/);
      if (m) return send({ data: (inst[m[1]] ?? []).map(([id, date]) => ({ id, attributes: { processingDate: date } })) });
      const sg = url.pathname.match(/^\/v1\/analyticsReportInstances\/([\w-]+)\/segments$/);
      if (sg) {
        const file = Object.values(inst).flat().find(([id]) => id === sg[1])?.[2];
        return send({ data: file ? [{ id: `s-${sg[1]}`, attributes: { url: `${base}/f/${file}` } }] : [] });
      }
      send({ errors: [{ detail: `no ${url.pathname}` }] }, 404);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

const ASC_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const cli = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.mjs', ...args], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH, DATABASE_URL: db.url, CATALOG_FILE,
        ASC_KEY_ID: 'TESTKEY123', ASC_ISSUER_ID: 'issuer', ASC_PRIVATE_KEY: ASC_KEY.replace(/\n/g, '\\n'),
        ASC_API_BASE: `http://127.0.0.1:${apple.address().port}`,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

describe('App Store Connect', () => {
  before(async () => {
    apple = await serveApple();
  });
  after(() => apple?.close());

  test('a key without the Admin role: the reason is kept and shown, nothing is imported', async () => {
    state.refuseCreate = true;
    const { out } = await cli('asc:sync', 'shop');
    assert.match(out, /Admin role/);
    const a = (await admin(srv.base).get('/admin/apps/shop/attribution?days=30')).json.appstore;
    assert.equal(a.campaigns.length, 0);
    state.refuseCreate = false;
  });

  test('every Detailed report across pages, CSV or gzipped TSV, and a restatement never replaced by an older one', async () => {
    const { code, out } = await cli('asc:sync', 'shop');
    assert.equal(code, 0, out);
    assert.match(out, /shop\t4 reports, 5 new instances/, 'engagement, purchases, sessions, downloads; not pre-orders or Standard');
    const c = (await admin(srv.base).get('/admin/apps/shop/attribution?days=30')).json.appstore.campaigns.find((x) => x.campaign === 'meta_autumn');
    assert.deepEqual(
      { impressions: c.impressions, page_views: c.page_views, taps: c.taps, purchases: c.purchases, proceeds_usd: c.proceeds_usd, paying_users: c.paying_users, sessions: c.sessions, first_downloads: c.first_downloads },
      { impressions: 120, page_views: 30, taps: 9, purchases: 3, proceeds_usd: 1042.75, paying_users: 3, sessions: 14, first_downloads: 8 },
    );
  });

  test('an app without an App Store id is skipped, and asc:request says so', async () => {
    const { out } = await cli('asc:request', 'bare');
    assert.match(out, /no app_store_id/);
    const all = await cli('asc:sync');
    assert.doesNotMatch(all.out, /bare/);
  });

  test('a request Apple stopped for inactivity is replaced by a new one', async () => {
    state.stopped = true;
    const before = state.created;
    await cli('asc:sync', 'shop');
    state.stopped = false;
    assert.equal(state.created, before + 1);
  });

  test('without ASC_* the CLI says what is missing, and the dashboard says it is not set up', async () => {
    const child = spawn(process.execPath, ['src/cli.mjs', 'asc:sync'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH, DATABASE_URL: db.url, CATALOG_FILE } });
    let out = '';
    child.stderr.on('data', (d) => (out += d));
    child.stdout.on('data', (d) => (out += d));
    await new Promise((r) => child.on('exit', r));
    assert.match(out, /ASC_KEY_ID/);
    assert.equal((await admin(srv.base).get('/admin/apps/other/attribution')).json.appstore.configured, false);
  });
});
