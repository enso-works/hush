// The dashboard is served by the container itself: the prebuilt files in
// src/dashboard/, by exact name only, under a strict CSP.
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

test('the page and its built assets, with a strict CSP', async () => {
  const page = await fetch(`${srv.base}/dashboard/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'(;|$)/, 'no inline styles');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  const html = await page.text();
  // Relative asset URLs, so the page also works behind a proxy prefix.
  const script = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)">/)?.[1];
  const style = html.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/)?.[1];
  assert.ok(script && style, 'a hashed script and stylesheet');
  assert.doesNotMatch(html.replace(/<script type="module"[^>]*><\/script>/, ''), /<script|<style|style=/, 'nothing inline');
  const js = await fetch(`${srv.base}/dashboard/${script}`);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${srv.base}/dashboard/${style}`)).status, 200);
  assert.equal((await fetch(`${srv.base}/dashboard/favicon.svg`)).headers.get('content-type'), 'image/svg+xml');
});

test('/dashboard redirects to the page, relatively; anything else under it is 404', async () => {
  const r = await fetch(`${srv.base}/dashboard`, { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'dashboard/');
  for (const path of ['/dashboard/server.mjs', '/dashboard/..%2Fserver.mjs', '/dashboard/%2e%2e/config.mjs', '/dashboard/nope.js', '/dashboard/assets/']) {
    assert.equal((await fetch(`${srv.base}${path}`)).status, 404, path);
  }
});

test('the page itself holds no data: without the token, /admin is still 401', async () => {
  assert.equal((await fetch(`${srv.base}/admin/apps`)).status, 401);
});
