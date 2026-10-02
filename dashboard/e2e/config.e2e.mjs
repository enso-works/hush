// Remote config in a real browser. Against a DEMO server: the key list, an
// orphan, a key's history, Preview as and a phone's width, read only.
// Against a server of its own, signed in by a proxy header, with a catalog
// written here: overriding, rules, reverting, a conflict between two pages,
// previewing an install, and an override the catalog's new type no longer
// fits. Every test fails on a console error or a failed /admin request.
//   (Postgres at TEST_DATABASE_URL) npm run e2e     # from dashboard/
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { addApp, client, freshDatabase, startServer } from '../../test/helpers.mjs';

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

/** A page that records what went wrong: console errors, uncaught exceptions, /admin answers that are not 2xx (but those `allow`ed). */
async function open(base, path, { viewport = { width: 1440, height: 1000 }, headers, allow = [] } = {}) {
  const context = await browser.newContext({ viewport, extraHTTPHeaders: headers });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && !allow.some((s) => m.text().includes(String(s))) && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/admin/') && r.status() >= 400 && !allow.includes(r.status())) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  await page.goto(`${base}/dashboard/${path}`, { waitUntil: 'load' });
  return { page, problems, close: () => context.close() };
}
const panel = (page, title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const radio = (scope, group, name) => scope.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name, exact: true });
const row = (page, key) => page.locator('tbody tr').filter({ has: page.getByRole('link', { name: key, exact: true }) });
const outcomes = async (page, key) => (await panel(page, 'Preview as').locator(`[data-key="${key}"] li`).allTextContents()).map((t) => t.trim());

describe('the demo', () => {
  let db, srv;
  before(async () => {
    if (process.env.E2E_BASE) srv = { base: process.env.E2E_BASE.replace(/\/$/, '') };
    else {
      db = await freshDatabase('hush_e2e_config');
      srv = await startServer(db, { DEMO: '1', ADMIN_TOKEN: '', TELEMETRY_ADMIN_TOKEN: '' });
    }
  });
  after(async () => {
    await srv?.stop?.();
    await db?.drop();
  });

  test('stillwater: four keys, an overridden rule list and an overridden default', async () => {
    const { page, problems, close } = await open(srv.base, '#/app/stillwater/config');
    await panel(page, 'Keys').waitFor();
    await row(page, 'paywall_variant').waitFor();
    assert.equal(await page.locator('tbody tr').count(), 4);
    for (const key of ['paywall_variant', 'review_prompt_after', 'session_lengths', 'streak_freeze']) await row(page, key).waitFor();
    await row(page, 'paywall_variant').getByText('Override: rules', { exact: true }).waitFor();
    await row(page, 'review_prompt_after').getByText('Override: default', { exact: true }).waitFor();
    assert.equal(await page.title(), 'Remote config · hush');
    assert.deepEqual(problems, []);
    await close();
  });

  test('tally: three keys, and an override the catalog lost, which the demo cannot delete', async () => {
    const { page, problems, close } = await open(srv.base, '#/app/tally/config');
    await row(page, 'paywall_variant').waitFor();
    assert.equal(await page.locator('tbody tr').count(), 3);
    const orphans = panel(page, 'Not in the catalog');
    await orphans.getByText('old_onboarding', { exact: true }).waitFor();
    assert.equal(await orphans.getByRole('button', { name: 'Delete' }).count(), 0);
    assert.deepEqual(problems, []);
    await close();
  });

  test('a key: its history newest first, and an editor the demo switches off', async () => {
    const { page, problems, close } = await open(srv.base, '#/app/stillwater/config/paywall_variant');
    const history = panel(page, 'History');
    await history.getByText('Start the copy test at 20%').waitFor();
    const text = await history.textContent();
    const at = ['Android joins the copy test', 'Raise to 50%', 'Start the copy test at 20%'].map((n) => text.indexOf(n));
    assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], `history order: ${at}`);
    assert.equal(await history.getByRole('button', { name: /Load into the editor/ }).count(), 0);
    await page.getByText('Editing is switched off in the demo.', { exact: false }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled());
    assert.ok(await radio(page, 'Rules source', 'Catalog').isDisabled());
    assert.ok(await page.getByLabel('Rule 1 version').isDisabled());
    assert.deepEqual(problems, []);
    await close();
  });

  test('preview as: a rollout as shares, a version, a language', async () => {
    const { page, problems, close } = await open(srv.base, '#/app/stillwater/config');
    const p = panel(page, 'Preview as');
    await p.locator('[data-key="paywall_variant"]').waitFor();
    const preview = async (fields, part) => {
      for (const [label, value] of Object.entries(fields)) await p.getByLabel(label, { exact: true }).fill(value);
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/config/preview?') && r.url().includes(part)),
        p.getByRole('button', { name: 'Preview' }).click(),
      ]);
      await page.waitForTimeout(150);
    };
    await preview({ Platform: 'android' }, 'platform=android');
    assert.deepEqual(await outcomes(page, 'paywall_variant'), ['"b" · 20%Rule 2', '"a" · 80%Default']);
    await preview({ Platform: 'ios', 'App version': '1.4.0' }, 'version=1.4.0');
    assert.deepEqual(await outcomes(page, 'paywall_variant'), ['"b" · 50%Rule 1', '"a" · 50%Default']);
    await preview({ Platform: '', 'App version': '', Language: 'de' }, 'language=de');
    assert.deepEqual(await outcomes(page, 'review_prompt_after'), ['5 · 100%Rule 1']);
    assert.deepEqual(problems, []);
    await close();
  });

  test('on a phone nothing runs off the side of either page', async () => {
    for (const path of ['#/app/stillwater/config', '#/app/stillwater/config/paywall_variant']) {
      const { page, problems, close } = await open(srv.base, path, { viewport: { width: 390, height: 844 } });
      await panel(page, 'Preview as').locator('li').first().waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${path}: ${overflow}px wider than the screen`);
      assert.deepEqual(problems, []);
      await close();
    }
  });
});

// The four keys of the spec's catalog example.
const CONFIG = {
  new_home: {
    type: 'bool',
    default: false,
    description: 'The redesigned home screen.',
    rules: [
      { when: { channel: ['testflight', 'dev'] }, value: true, note: 'Testers see it first' },
      { when: { platform: ['ios'], version: '>=2.1.0' }, rollout: 20, value: true },
    ],
  },
  paywall_copy: {
    type: 'string',
    default: 'Start your free week',
    description: 'The paywall headline.',
    rules: [{ when: { language: ['de'] }, value: 'Eine Woche gratis' }],
  },
  review_prompt_after: { type: 'number', default: 3, description: 'Sessions before the app asks for a review.' },
  session_presets: { type: 'json', default: [3, 5, 10], description: 'Session lengths on the start screen, in minutes.' },
};

describe('editing, on a server of its own', { skip: process.env.E2E_BASE ? 'E2E_BASE runs the demo only' : false }, () => {
  const secret = randomBytes(16).toString('hex');
  const headers = { 'x-hush-e2e': secret };
  const catalog = join(tmpdir(), `hush-rc-catalog-${randomUUID()}.json`);
  const env = { APPS: 'shop=Shop', CATALOG_FILE: catalog, ADMIN_PROXY_HEADER: 'x-hush-e2e', ADMIN_PROXY_SECRET: secret };
  let db, srv, v1, writeKey;
  const served = async () => {
    const r = await v1.get('/v1/config');
    assert.equal(r.status, 200);
    return r.json.config.keys;
  };
  const keyPage = (key, opts) => open(srv.base, `#/app/shop/config/${key}`, { headers, ...opts });
  const saved = (page, text = 'Saved. Apps get it on their next fetch.') => page.getByText(text).waitFor();

  before(async () => {
    writeFileSync(catalog, JSON.stringify({ shop: { config: CONFIG } }));
    db = await freshDatabase('hush_e2e_config_edit');
    srv = await startServer(db, env);
    writeKey = await addApp(db, 'shop');
    v1 = client(srv.base, writeKey);
  });
  after(async () => {
    await srv?.stop();
    await db?.drop();
    rmSync(catalog, { force: true });
  });

  test('an overridden default is listed and served', async () => {
    const { page, problems, close } = await keyPage('paywall_copy');
    await radio(page, 'Default source', 'Override').click();
    await page.getByLabel('Default value', { exact: true }).fill('Try a week on us');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(page);
    await page.goto(`${srv.base}/dashboard/#/app/shop/config`);
    await row(page, 'paywall_copy').getByText('Override: default', { exact: true }).waitFor();
    assert.equal((await served()).paywall_copy.default, 'Try a week on us');
    assert.deepEqual(problems, []);
    await close();
  });

  test('rules: a version the server would refuse cannot be saved; fixed, it is, with its note in the history', async () => {
    const { page, problems, close } = await keyPage('new_home');
    await radio(page, 'Rules source', 'Override').click();
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Rule 3 version').fill('2.1');
    await page.getByRole('alert').filter({ hasText: 'expected a range such as ">=2.1.0 <3"' }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled());
    await page.getByLabel('Rule 3 version').fill('>=2.1');
    await radio(page, 'Rule 3 value', 'True').click();
    await page.getByLabel('Rule 3 rollout').fill('5');
    await page.getByLabel('Change note').fill('Five percent from 2.1');
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(page);
    await panel(page, 'History').getByText('Five percent from 2.1').waitFor();
    const rules = (await served()).new_home.rules;
    assert.deepEqual(rules[2], { when: { version: '>=2.1' }, rollout: 5, value: true });
    assert.deepEqual(problems, []);
    await close();
  });

  test('reverting serves the catalog again', async () => {
    const { page, problems, close } = await keyPage('paywall_copy');
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Revert to the catalog', exact: true }).click();
    await saved(page, 'Reverted to the catalog. Apps get it on their next fetch.');
    await page.getByText('From the catalog', { exact: false }).waitFor();
    assert.equal((await served()).paywall_copy.default, 'Start your free week');
    assert.deepEqual(problems, []);
    await close();
  });

  test('two pages on one key: the second save is refused, and the current version loads', async () => {
    const a = await keyPage('review_prompt_after');
    const b = await keyPage('review_prompt_after', { allow: [409] });
    for (const { page } of [a, b]) await radio(page, 'Default source', 'Override').waitFor();
    for (const [{ page }, value] of [[a, '4'], [b, '6']]) {
      await radio(page, 'Default source', 'Override').click();
      await page.getByLabel('Default value', { exact: true }).fill(value);
    }
    await a.page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(a.page);
    await b.page.getByRole('button', { name: 'Save', exact: true }).click();
    await b.page.getByRole('alert').filter({ hasText: 'Not saved: changed since you opened it.' }).waitFor();
    await b.page.getByRole('button', { name: 'Load the current version' }).click();
    await b.page.waitForFunction(() => document.querySelector('input[aria-label="Default value"]')?.value === '4');
    assert.equal((await served()).review_prompt_after.default, 4);
    assert.deepEqual(a.problems, []);
    assert.deepEqual(b.problems, []);
    await a.close();
    await b.close();
  });

  test('preview by install: what that install gets, and its bucket', async () => {
    const install = randomUUID();
    await db.query(
      `INSERT INTO installs (id, app, env, platform, version, locale, pro) VALUES ($1, 'shop', 'prod', 'ios', '2.1.0', 'de-DE', true)`,
      [install],
    );
    const { page, problems, close } = await open(srv.base, '#/app/shop/config', { headers });
    const p = panel(page, 'Preview as');
    await p.locator('[data-key="paywall_copy"]').waitFor();
    await p.getByLabel('Install id').fill('not-an-id');
    await p.getByText('Not an install id').waitFor();
    await p.getByLabel('Install id').fill(install.toUpperCase());
    await Promise.all([page.waitForResponse((r) => r.url().includes(`install=${install}`)), p.getByRole('button', { name: 'Preview' }).click()]);
    await p.getByText('From the install: platform, version, language, pro').waitFor();
    const line = await p.locator('[data-key="paywall_copy"] p').textContent();
    assert.match(line, /^This install gets "Eine Woche gratis" \(Rule 1, bucket \d{1,2}\)\.$/);
    await p.getByText(/^Pro comes from the install's last batch/).waitFor();
    assert.deepEqual(problems, []);
    await close();
  });

  test('an override the catalog no longer fits: not served, both sources on the catalog, and its version cannot be loaded', async () => {
    const { page, problems, close } = await keyPage('review_prompt_after');
    await page.getByLabel('Default value', { exact: true }).fill('7');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(page);
    await close();

    writeFileSync(catalog, JSON.stringify({ shop: { config: { ...CONFIG, review_prompt_after: { ...CONFIG.review_prompt_after, type: 'string', default: 'three' } } } }));
    await srv.stop();
    srv = await startServer(db, env);
    v1 = client(srv.base, writeKey);
    assert.equal((await served()).review_prompt_after.default, 'three');

    const again = await keyPage('review_prompt_after');
    const p = again.page;
    await p.getByRole('alert').filter({ hasText: 'This override is not served: default: expected text of up to 2000 characters.' }).waitFor();
    assert.equal(await radio(p, 'Default source', 'Catalog').getAttribute('aria-checked'), 'true');
    assert.equal(await radio(p, 'Rules source', 'Catalog').getAttribute('aria-checked'), 'true');
    await p.getByText("The stored override does not fit this key's type; saving writes a new one, reverting deletes it.").waitFor();
    const load = panel(p, 'History').getByRole('button', { name: 'Load into the editor' }).first();
    await load.waitFor();
    assert.ok(await load.isDisabled());
    // Saving now would be a revert: the form holds no override.
    assert.equal(await p.getByRole('button', { name: 'Revert to the catalog', exact: true }).count(), 1);
    assert.deepEqual(problems, []);
    assert.deepEqual(again.problems, []);
    await again.close();
  });
});
