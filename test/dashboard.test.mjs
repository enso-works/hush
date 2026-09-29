// The dashboard is served by the container itself: three files, by name only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { freshDatabase, startServer } from './helpers.mjs';

let db, srv;
before(async () => {
  db = await freshDatabase('hush_dash');
  srv = await startServer(db);
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

test('the page, its script and its styles, with a strict CSP', async () => {
  const page = await fetch(`${srv.base}/dashboard/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /<script type="module" src="\.\/app\.js">/);
  assert.equal((await fetch(`${srv.base}/dashboard/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${srv.base}/dashboard/style.css`)).status, 200);
});

test('/dashboard redirects to the page; anything else under it is 404', async () => {
  const r = await fetch(`${srv.base}/dashboard`, { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/dashboard/');
  for (const path of ['/dashboard/server.mjs', '/dashboard/..%2Fserver.mjs', '/dashboard/%2e%2e/config.mjs', '/dashboard/nope.js']) {
    assert.equal((await fetch(`${srv.base}${path}`)).status, 404, path);
  }
});

test('the page itself holds no data: without the token, /admin is still 401', async () => {
  assert.equal((await fetch(`${srv.base}/admin/apps`)).status, 401);
});
