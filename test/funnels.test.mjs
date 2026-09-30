// Ordered funnels (from the catalog, or built on the dashboard) and weekly
// retention cohorts.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { addApp, admin, batch, client, event, freshDatabase, startServer, uuid } from './helpers.mjs';

const CATALOG_FILE = join(tmpdir(), 'hush-test-funnels.json');
writeFileSync(CATALOG_FILE, JSON.stringify({
  shop: {
    events: ['onboarding_completed', 'item_added', 'checkout'],
    funnels: [
      { name: 'Buy', window_days: 7, steps: ['app_first_opened', 'item_added', { event: 'checkout', where: { ok: true }, label: 'Paid' }] },
    ],
  },
}));

let db, srv, key;
before(async () => {
  db = await freshDatabase('hush_funnels');
  srv = await startServer(db, { CATALOG_FILE });
  key = await addApp(db, 'shop', 'Shop');
});
after(async () => {
  await srv?.stop();
  await db?.drop();
});

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const at = (install, name, minutesAgo, props) => ({ ...event(install, name, { props }), at: ago(minutesAgo) });

describe('funnels', () => {
  before(async () => {
    const c = client(srv.base, key);
    const done = uuid();
    const outOfOrder = uuid();
    const tooLate = uuid();
    const failedPay = uuid();
    await c.post('/v1/events', batch([
      // All three steps in order: 1 min, then 3 min between them.
      at(done, 'app_first_opened', 60), at(done, 'item_added', 59), at(done, 'checkout', 56, { ok: true }),
      // item_added before the first step does not count for step two.
      at(outOfOrder, 'item_added', 50), at(outOfOrder, 'app_first_opened', 40),
      // Step two nine days after step one: outside the 7-day window.
      at(tooLate, 'app_first_opened', 60 * 24 * 10), at(tooLate, 'item_added', 60 * 24),
      // Reached checkout, but the payment failed: not "Paid".
      at(failedPay, 'app_first_opened', 30), at(failedPay, 'item_added', 29), at(failedPay, 'checkout', 28, { ok: false }),
    ]));
  });

  test('the catalog funnel is ordered, windowed and matches props', async () => {
    const r = await admin(srv.base).get('/admin/apps/shop/funnels?days=30');
    assert.equal(r.status, 200);
    const [buy] = r.json.funnels;
    assert.equal(buy.name, 'Buy');
    assert.deepEqual(buy.steps.map((s) => s.installs), [4, 2, 1]);
    assert.deepEqual(buy.steps.map((s) => s.label), ['App first opened', 'Item added', 'Paid']);
    assert.equal(buy.steps[0].median_s, null);
    assert.equal(buy.steps[2].median_s, 180);
  });

  test('an app without catalog funnels gets the paywall one', async () => {
    await addApp(db, 'plain', 'Plain');
    const r = await admin(srv.base).get('/admin/apps/plain/funnels');
    assert.deepEqual(r.json.funnels.map((f) => f.name), ['Paywall']);
    assert.deepEqual(r.json.funnels[0].steps.map((s) => s.label), ['Paywall viewed', 'Purchase started', 'Purchased']);
  });

  test('a funnel built on the dashboard, with a prop condition and a window', async () => {
    const r = await admin(srv.base).get('/admin/apps/shop/funnel?days=30&step=item_added&step=checkout:ok=false&window=1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.steps.map((s) => s.installs), [4, 1]);
    const bad = await admin(srv.base).get('/admin/apps/shop/funnel?step=item_added');
    assert.equal(bad.status, 400);
    assert.equal((await admin(srv.base).get('/admin/apps/shop/funnel?step=a&step=Bad%20Name')).status, 400);
  });

  test('the same event twice means a second occurrence', async () => {
    const c = client(srv.base, key);
    const once = uuid();
    const twice = uuid();
    await c.post('/v1/events', batch([at(once, 'onboarding_completed', 5), at(twice, 'onboarding_completed', 5), at(twice, 'onboarding_completed', 4)]));
    const r = await admin(srv.base).get('/admin/apps/shop/funnel?step=onboarding_completed&step=onboarding_completed');
    assert.deepEqual(r.json.steps.map((s) => s.installs), [2, 1]);
  });

  test('a catalog with a bad funnel stops the boot, naming it', async () => {
    const bad = join(tmpdir(), 'hush-test-funnels-bad.json');
    writeFileSync(bad, JSON.stringify({ shop: { funnels: [{ name: 'One step', steps: ['checkout'] }] } }));
    const d = await freshDatabase('hush_funnels_bad');
    try {
      await assert.rejects(startServer(d, { CATALOG_FILE: bad }), /catalog\.shop\.funnels\[0\]\.steps/);
    } finally {
      await d.drop();
    }
  });
});

describe('cohorts', () => {
  test('installs by first week, and the share still sending events in later weeks', async () => {
    const c = client(srv.base, key);
    const returning = uuid();
    // First seen 15 days ago, active again today.
    await c.post('/v1/events', batch([at(returning, 'app_first_opened', 60 * 24 * 15), at(returning, 'item_added', 1)]));
    const r = await admin(srv.base).get('/admin/apps/shop/cohorts?weeks=4');
    assert.equal(r.status, 200);
    assert.equal(r.json.weeks, 4);
    const monday = (d) => {
      const x = new Date(d);
      x.setUTCHours(0, 0, 0, 0);
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x;
    };
    const firstWeek = monday(Date.now() - 15 * 86400000);
    const k = Math.round((monday(Date.now()) - firstWeek) / 604800000);
    const cohort = r.json.cohorts.find((x) => x.week === firstWeek.toISOString().slice(0, 10));
    assert.ok(cohort, 'the returning install has a cohort');
    assert.ok(cohort.active[k] >= 1, `active in week ${k}`);
    assert.equal(cohort.active[0] >= 1, true);
    for (const x of r.json.cohorts) assert.equal(x.active.length, 4);
    const newest = r.json.cohorts.at(-1);
    assert.equal(newest.active[1], null, 'a week that has not happened yet');
  });
});

describe('campaigns', () => {
  test('first tagged session per install, split by a tag, then the steps in order', async () => {
    const c = client(srv.base, key);
    const link = (install, minutesAgo, tags) => at(install, 'session_started', minutesAgo, { entry: 'link', ...tags });
    const newFromAd = uuid();
    const oldUser = uuid();
    const other = uuid();
    const newsletter = uuid();
    const ad = (content) => ({ utm_source: 'meta', utm_campaign: 'autumn', utm_content: content });
    await c.post('/v1/events', batch([
      // New from an ad: first seen at the tagged session, then all the steps.
      at(newFromAd, 'app_first_opened', 30), link(newFromAd, 30, ad('video')), at(newFromAd, 'item_added', 29), at(newFromAd, 'checkout', 28, { ok: true }),
      // An old install reopened by an ad: counted, not new; a later ad does not move it (first touch).
      at(oldUser, 'app_first_opened', 60 * 24 * 3), link(oldUser, 40, ad('static')), link(oldUser, 20, ad('video')), at(oldUser, 'item_added', 19),
      // The steps before the tagged session do not count.
      at(other, 'item_added', 50), link(other, 45, ad('video')),
      // Another source, left out by where=utm_source:meta.
      link(newsletter, 10, { utm_source: 'newsletter', utm_campaign: 'autumn', utm_content: 'mail' }),
    ]));

    const r = await admin(srv.base).get('/admin/apps/shop/campaigns?days=30&by=utm_content&where=utm_source:meta');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.steps.map((s) => s.label), ['Item added', 'Paid'], 'the catalog funnel, from the tagged session on');
    const rows = Object.fromEntries(r.json.rows.map((x) => [x.value, x]));
    assert.deepEqual(rows.video, { value: 'video', installs: 2, new: 1, steps: [1, 1] });
    assert.deepEqual(rows.static, { value: 'static', installs: 1, new: 0, steps: [1, 0] });
    assert.equal(rows.mail, undefined);

    const bySource = await admin(srv.base).get('/admin/apps/shop/campaigns?days=30&by=utm_source&step=checkout:ok=true');
    const meta = bySource.json.rows.find((x) => x.value === 'meta');
    assert.deepEqual([meta.installs, meta.steps[0]], [3, 1]);
    assert.equal((await admin(srv.base).get('/admin/apps/shop/campaigns?by=fbclid')).status, 400, 'only campaign tags');
  });
});
