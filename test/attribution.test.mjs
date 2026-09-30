// Where installs came from, as Apple reports it: SKAdNetwork and
// AdAttributionKit postback copies (Apple's own samples, which verify with
// Apple's published keys), the conversion values an app sets, and App Store
// Connect's campaign reports, imported from a stand-in for Apple's API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { addApp, admin, client, freshDatabase, startServer } from './helpers.mjs';

const CATALOG_FILE = join(tmpdir(), 'hush-test-attribution.json');
writeFileSync(CATALOG_FILE, JSON.stringify({
  shop: {
    app_store_id: '525463029',
    conversion_values: [
      { value: 1, coarse: 'low', event: 'onboarding_completed', label: 'Onboarded' },
      { value: 20, coarse: 'medium', event: 'checkout' },
      { value: 63, coarse: 'high', event: 'purchase_result', where: { result: 'purchased' }, label: 'Purchased', lock: true },
    ],
  },
  game: { app_store_id: '10738027756' },
}));

// Apple's samples (storekit/verifying-an-install-validation-postback, adattributionkit/verifying-a-postback).
const SKAN = {
  version: '4.0', 'ad-network-id': 'com.example', 'source-identifier': '5239', 'app-id': 525463029,
  'transaction-id': '6aafb7a5-0170-41b5-bbe4-fe71dedf1e30', redownload: false, 'source-domain': 'example.com', 'fidelity-type': 1,
  'did-win': true, 'conversion-value': 63, 'postback-sequence-index': 0,
  'attribution-signature': 'MEUCIGRmSMrqedNu6uaHyhVcifs118R5z/AB6cvRaKrRRHWRAiEAv96ne3dKQ5kJpbsfk4eYiePmrZUU6sQmo+7zfP/1Bxo=',
};
const AAK_JWS =
  'eyJraWQiOiJhcHBsZS1kZXZlbG9wbWVudC1pZGVudGlmaWVyXC8xIiwiYWxnIjoiRVMyNTYifQ.eyJwb3N0YmFjay1pZGVudGlmaWVyIjoiODU1NDZFQjctRkQzOS00NEJDLTg5OTAtQzk4QTRBQzM2QTQ5IiwicHVibGlzaGVyLWl0ZW0taWRlbnRpZmllciI6MCwibWFya2V0cGxhY2UtaWRlbnRpZmllciI6ImNvbS5hcHBsZS5BcHBTdG9yZSIsImltcHJlc3Npb24tdHlwZSI6ImFwcC1pbXByZXNzaW9uIiwiYWQtbmV0d29yay1pZGVudGlmaWVyIjoiZGV2ZWxvcG1lbnQuYWRhdHRyaWJ1dGlvbmtpdCIsImRpZC13aW4iOnRydWUsInBvc3RiYWNrLXNlcXVlbmNlLWluZGV4IjowLCJjb252ZXJzaW9uLXR5cGUiOiJyZS1lbmdhZ2VtZW50Iiwic291cmNlLWlkZW50aWZpZXIiOiIxMjM0IiwiYWR2ZXJ0aXNlZC1pdGVtLWlkZW50aWZpZXIiOjEwNzM4MDI3NzU2fQ.bAdNwKd6OfHK9tofvjjua4X_JPcFTxXPQSspD9gZkinw97pY7R1aI-LSjl-oxZZF3_K2H5JK5TSEBee4_1U4oQ';

// A stand-in for App Store Connect's Analytics Reports API.
const DAY = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
const tsv = (rows) => gzipSync(Buffer.from(rows.map((r) => r.join('\t')).join('\n')));
const HEAD = ['Date', 'App Name', 'App Apple Identifier', 'Download Type', 'Source Type', 'Campaign', 'Territory', 'Counts'];
const FILES = {
  // The first processing of the day...
  '/files/a.gz': tsv([HEAD, [DAY, 'Shop', '525463029', 'First-time Download', 'Web referrer', 'meta_autumn', 'US', '7'], [DAY, 'Shop', '525463029', 'First-time Download', 'Web referrer', 'meta_autumn', 'DE', '5'], [DAY, 'Shop', '525463029', 'Redownload', 'App Store search', '', 'US', '3']]),
  // ...restated later: it replaces the day, it does not add to it.
  '/files/b.gz': tsv([HEAD, [DAY, 'Shop', '525463029', 'First-time Download', 'Web referrer', 'meta_autumn', 'US', '9'], [DAY, 'Shop', '525463029', 'First-time Download', 'App Store search', '', 'US', '11']]),
};
let apple;
let requestsCreated = 0;
const appleServer = () =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const send = (body, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url, 'http://x');
      if (FILES[url.pathname]) return res.end(FILES[url.pathname]);
      if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? '')) return send({ errors: [{ detail: 'no token' }] }, 401);
      const base = `http://127.0.0.1:${s.address().port}`;
      if (url.pathname === '/v1/apps/525463029/analyticsReportRequests') return send({ data: [] });
      if (url.pathname === '/v1/analyticsReportRequests' && req.method === 'POST') return requestsCreated++, send({ data: { id: 'req-1', type: 'analyticsReportRequests' } }, 201);
      if (url.pathname === '/v1/analyticsReportRequests/req-1') return send({ data: { id: 'req-1', attributes: { stoppedDueToInactivity: false } } });
      if (url.pathname === '/v1/analyticsReportRequests/req-1/reports')
        return send({ data: [{ id: 'r-dl', attributes: { name: 'App Store Downloads Detailed' } }, { id: 'r-std', attributes: { name: 'App Store Downloads Standard' } }] });
      if (url.pathname === '/v1/analyticsReports/r-dl/instances')
        return send({ data: [{ id: 'i-2', attributes: { processingDate: '2026-09-29' } }, { id: 'i-1', attributes: { processingDate: '2026-09-28' } }] });
      if (url.pathname === '/v1/analyticsReportInstances/i-1/segments') return send({ data: [{ id: 's1', attributes: { url: `${base}/files/a.gz` } }] });
      if (url.pathname === '/v1/analyticsReportInstances/i-2/segments') return send({ data: [{ id: 's2', attributes: { url: `${base}/files/b.gz` } }] });
      send({ errors: [{ detail: `no ${url.pathname}` }] }, 404);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

const ASC_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

let db, srv, key;
before(async () => {
  apple = await appleServer();
  db = await freshDatabase('hush_attribution');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'shop', 'Shop');
  await addApp(db, 'game', 'Game');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
  apple?.close();
});

const post = (path, body) => fetch(`${srv.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('postback copies', () => {
  test("Apple's signed SKAdNetwork postback is stored once, verified, under its app", async () => {
    const r = await post('/.well-known/skadnetwork/report-attribution/', SKAN);
    assert.equal(r.status, 200);
    assert.equal((await post('/.well-known/skadnetwork/report-attribution/', SKAN)).status, 200, 'a retry is fine');
    const rows = (await db.query("SELECT app, verified, development, source_identifier, conversion_value, interaction FROM postbacks WHERE kind = 'skan'")).rows;
    assert.deepEqual(rows, [{ app: 'shop', verified: true, development: false, source_identifier: '5239', conversion_value: 63, interaction: 'click' }]);
  });

  test('a forged one is kept but never counted', async () => {
    const forged = { ...SKAN, 'transaction-id': '00000000-0000-4000-8000-000000000000', 'source-identifier': '6666' };
    assert.equal((await post('/.well-known/skadnetwork/report-attribution', forged)).status, 200);
    const a = (await admin(srv.base).get('/admin/apps/shop/attribution?days=7')).json;
    assert.deepEqual(a.postbacks.campaigns.map((c) => [c.ad_network, c.source_identifier, c.installs]), [['com.example', '5239', 1]]);
    assert.equal(a.postbacks.unverified, 1);
    assert.deepEqual(a.postbacks.values, [{ sequence: 0, conversion_value: 63, coarse_value: null, n: 1 }]);
  });

  test("AdAttributionKit's development postback verifies with Apple's development key and counts only under env=dev", async () => {
    const r = await post('/.well-known/appattribution/report-attribution/', { 'jws-string': AAK_JWS, 'conversion-value': 20, 'ad-interaction-type': 'click' });
    assert.equal(r.status, 200);
    const row = (await db.query("SELECT app, verified, development, conversion_type, conversion_value FROM postbacks WHERE kind = 'aak'")).rows[0];
    assert.deepEqual(row, { app: 'game', verified: true, development: true, conversion_type: 're-engagement', conversion_value: 20 });
    assert.equal((await admin(srv.base).get('/admin/apps/game/attribution?days=7')).json.postbacks.campaigns.length, 0);
    const dev = (await admin(srv.base).get('/admin/apps/game/attribution?days=7&env=dev')).json.postbacks.campaigns;
    assert.deepEqual(dev.map((c) => [c.kind, c.source_identifier]), [['aak', '1234']]);
    assert.equal((await post('/.well-known/appattribution/report-attribution/', 'nope')).status, 400);
  });
});

describe('the overview', () => {
  test("each app's card counts the installs Apple attributed to an ad: verified, winning, production in prod and test ones in dev", async () => {
    const prod = (await admin(srv.base).get('/admin/apps?days=7')).json.apps;
    assert.equal(prod.find((a) => a.app === 'shop').ad_installs, 1, "Apple's signed sample; the forged one does not count");
    assert.equal(prod.find((a) => a.app === 'game').ad_installs, 0, 'a development postback is not a real ad');
    const dev = (await admin(srv.base).get('/admin/apps?days=7&env=dev')).json.apps;
    assert.equal(dev.find((a) => a.app === 'game').ad_installs, 1);
  });
});

describe('conversion values', () => {
  test('the SDK reads them with its write key', async () => {
    const r = await client(srv.base, key).get('/v1/config');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.conversion_values.map((m) => [m.value, m.coarse, m.lock]), [[1, 'low', false], [20, 'medium', false], [63, 'high', true]]);
    assert.deepEqual(r.json.conversion_values[2].where, { result: 'purchased' });
    assert.equal((await client(srv.base).get('/v1/config')).status, 401);
  });

  test('a value that does not climb stops the boot, naming it', async () => {
    const bad = join(tmpdir(), 'hush-test-attribution-bad.json');
    writeFileSync(bad, JSON.stringify({ shop: { conversion_values: [{ value: 5, event: 'checkout' }, { value: 5, event: 'purchase_result' }] } }));
    const d = await freshDatabase('hush_attribution_bad');
    try {
      await assert.rejects(startServer(d, { CATALOG_FILE: bad }), /catalog\.shop\.conversion_values\[1\]\.value/);
    } finally {
      await d.drop();
    }
  });
});

describe('App Store campaigns', () => {
  const sync = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/cli.mjs', 'asc:sync', 'shop'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          PATH: process.env.PATH, DATABASE_URL: db.url, CATALOG_FILE,
          ASC_KEY_ID: 'TESTKEY123', ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000', ASC_PRIVATE_KEY: ASC_KEY,
          ASC_API_BASE: `http://127.0.0.1:${apple.address().port}`,
        },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
    });

  test('the report request is made once, each instance imported once, and a restated day replaces the first', async () => {
    assert.match(await sync(), /shop\t1 reports, 2 new instances/);
    assert.match(await sync(), /shop\t1 reports, 0 new instances/);
    assert.equal(requestsCreated, 1);
    const a = (await admin(srv.base).get('/admin/apps/shop/attribution?days=30')).json.appstore;
    const byCampaign = Object.fromEntries(a.campaigns.map((c) => [c.campaign, c]));
    assert.equal(byCampaign.meta_autumn.first_downloads, 9, 'the later processing date, not 7 + 5 + 9');
    assert.equal(byCampaign[''].first_downloads, 11);
    assert.equal(byCampaign[''].redownloads, undefined, 'gone with the restatement');
    assert.equal(a.latest_day, DAY);
    assert.equal(a.request.last_error, null);
  });
});
