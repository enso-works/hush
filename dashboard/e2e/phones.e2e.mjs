// The Phones page in a real browser. On the demo: a QR code with the address
// alone, no code minted. On a server of its own, signed in by a proxy header:
// a QR code with a pairing code, a phone pairing with it, the list showing the
// phone, and revoking it. Every test fails on a console error or a failed
// /admin request.
//   (Postgres at TEST_DATABASE_URL) npm run e2e     # from dashboard/
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { client, freshDatabase, startServer } from '../../test/helpers.mjs';

const PROXY = { 'X-Ops-Proxy': 'proxy-secret-0123456789' };

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function open(base, path, headers) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: headers });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/admin/') && r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  await page.goto(`${base}/dashboard/${path}`, { waitUntil: 'load' });
  return { page, problems, close: () => context.close() };
}
const qr = (page) => page.getByRole('img', { name: 'QR code that signs the hush app in to this server' });

describe('the demo', () => {
  let db, srv;
  before(async () => {
    db = await freshDatabase('hush_e2e_phones_demo');
    srv = await startServer(db, { DEMO: '1', ADMIN_TOKEN: '', TELEMETRY_ADMIN_TOKEN: '' });
  });
  after(async () => {
    await srv?.stop();
    await db?.drop();
  });

  test('the QR code holds the address alone, and nothing is minted', async () => {
    const { page, problems, close } = await open(srv.base, '#/')
    const pairings = []
    page.on('request', (r) => r.url().endsWith('/admin/pairing') && pairings.push(r))
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Phones' }).click()
    await qr(page).waitFor()
    await page.getByText('The demo needs no code').waitFor()
    await page.getByText('No phone yet.').waitFor()
    assert.equal(await page.title(), 'Phones · hush')
    assert.equal(pairings.length, 0)
    assert.deepEqual(problems, [])
    await close()
  })
})

describe('a server of its own', () => {
  let db, srv;
  before(async () => {
    db = await freshDatabase('hush_e2e_phones');
    srv = await startServer(db, { ADMIN_PROXY_HEADER: 'X-Ops-Proxy', ADMIN_PROXY_SECRET: PROXY['X-Ops-Proxy'] });
  });
  after(async () => {
    await srv?.stop();
    await db?.drop();
  });

  test('a code on demand, a phone pairing with it, and revoking that phone', async () => {
    const { page, problems, close } = await open(srv.base, '#/phones', PROXY)
    await page.getByText('No phone yet.').waitFor()
    assert.equal(await qr(page).count(), 0, 'no code before it is asked for')

    const minted = page.waitForResponse((r) => r.url().endsWith('/admin/pairing'))
    await page.getByRole('button', { name: 'Show QR code' }).click()
    const { code } = await (await minted).json()
    await qr(page).waitFor()
    await page.getByText(/Expires in \d:\d\d/).waitFor()

    // The phone's side: what the app does with the code it scanned.
    const paired = await client(srv.base).post('/admin/pair', { code, name: 'Test iPhone' })
    assert.equal(paired.status, 201)
    await page.getByText('Test iPhone').waitFor({ timeout: 10_000 })

    page.once('dialog', (d) => d.accept())
    await page.getByRole('button', { name: 'Revoke' }).click()
    await page.getByText('No phone yet.').waitFor()
    const after = await client(srv.base, `Bearer ${paired.json.token}`).get('/admin/apps')
    assert.equal(after.status, 401)
    assert.deepEqual(problems, [])
    await close()
  })

  test('the address in the code is where the dashboard is served from', async () => {
    const { page, close } = await open(srv.base, '#/phones', PROXY)
    await page.getByText(`Server address in the code: ${srv.base}`, { exact: false }).waitFor()
    await close()
  })
})
