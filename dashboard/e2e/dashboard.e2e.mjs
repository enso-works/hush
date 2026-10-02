// The dashboard in a real browser, against a DEMO server (invented data,
// every panel populated): each page and panel renders, every switch works,
// and nothing logs an error or gets an error from /admin. Run by CI; locally:
//   (Postgres at TEST_DATABASE_URL) npm run e2e     # from dashboard/
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { freshDatabase, startServer } from '../../test/helpers.mjs';

// E2E_BASE=https://hush.bavrk.com/demo runs the same checks against a live demo.
let db, srv, browser;
before(async () => {
  if (process.env.E2E_BASE) srv = { base: process.env.E2E_BASE.replace(/\/$/, '') };
  else {
    db = await freshDatabase('hush_e2e');
    srv = await startServer(db, { DEMO: '1', ADMIN_TOKEN: '', TELEMETRY_ADMIN_TOKEN: '' });
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await srv?.stop?.();
  await db?.drop();
});

/** A page that records what went wrong: console errors, uncaught exceptions, /admin answers that are not 2xx. */
async function open(path, viewport = { width: 1440, height: 1000 }) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/admin/') && r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  await page.goto(`${srv.base}/dashboard/${path}`, { waitUntil: 'load' });
  return { page, problems };
}
const panel = (page, title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const radio = (scope, name) => scope.getByRole('radio', { name, exact: true });

describe('overview', () => {
  test('three apps with their numbers, ads counted, feedback badged', async () => {
    const { page, problems } = await open('');
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    for (const name of ['Stillwater', 'Tally', 'Pace']) await page.getByText(name, { exact: true }).first().waitFor();
    await page.getByText(/from ads/).first().waitFor();
    // The installs the server keeps: those seen in INSTALL_RETENTION_DAYS, 180 here by default (a live demo
    // may set another, and an older one says all time).
    const total = process.env.E2E_BASE ? /^Installs(?: seen in \d+ days|, all time)$/ : 'Installs seen in 180 days';
    assert.ok(await page.getByText(total, { exact: true }).isVisible());
    if (!process.env.E2E_BASE) {
      // New installs are counted inside that window too, so a year is cut to it.
      await radio(page, '1y').click();
      await page.getByText('New in 180 days', { exact: true }).waitFor();
    }
    for (const period of ['7d', '90d', '30d']) {
      await radio(page, period).click();
      await page.waitForTimeout(300);
    }
    assert.deepEqual(problems, []);
    await page.close();
  });
});

describe('an app', () => {
  test('every panel renders', async () => {
    const { page, problems } = await open('#/app/stillwater');
    for (const title of [
      'Activity', 'Funnels', 'Retention', 'Cohorts', 'Campaigns', 'Attribution', 'Where the paywall opens', 'Plans chosen',
      'Paywall variants seen', 'Versions', 'Countries', 'Engagement', 'How sessions start', 'Build channels', 'Build a funnel',
      'Explore', 'Events',
    ]) {
      await panel(page, title).first().waitFor({ timeout: 10000 });
    }
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('campaigns: every split has rows, narrowing to Meta keeps its ads, and each funnel can be chosen', async () => {
    const { page, problems } = await open('#/app/stillwater');
    const p = panel(page, 'Campaigns');
    await p.waitFor();
    // Each change is a new request; read the table once its answer is in.
    const answered = (part) => page.waitForResponse((r) => r.url().includes('/campaigns?') && r.url().includes(part));
    for (const [split, by] of [['Ad set', 'utm_term'], ['Source', 'utm_source'], ['Campaign', 'utm_campaign'], ['Ad', 'utm_content']]) {
      await Promise.all([answered(`by=${by}&funnel`), radio(p, split).click()]);
      await page.waitForTimeout(200);
      assert.ok((await p.locator('tbody tr').count()) > 0, split);
    }
    await Promise.all([answered('where=utm_source'), p.getByRole('combobox', { name: 'Source' }).selectOption('meta')]);
    await page.waitForTimeout(200);
    const ads = await p.locator('tbody tr td:first-child').allTextContents();
    assert.deepEqual(new Set(ads), new Set(['ugc review', 'static streak', 'video calm']));
    await Promise.all([answered('funnel=1'), p.getByRole('combobox', { name: 'Funnel' }).selectOption({ index: 1 })]);
    await page.waitForTimeout(200);
    assert.match(await p.locator('thead').textContent(), /Purchase started/, 'the Paywall funnel as columns');
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('attribution: postbacks by campaign and value, App Store campaigns, the conversion-value table', async () => {
    const { page, problems } = await open('#/app/stillwater');
    const p = panel(page, 'Attribution');
    await p.waitFor();
    await p.getByText('Meta', { exact: true }).first().waitFor();
    assert.ok(await p.getByText('Purchased').first().isVisible(), 'a value named by its milestone');
    await radio(p, 'App Store campaigns').click();
    await p.getByText('meta_autumn').waitFor();
    assert.ok(await p.getByText('First downloads').isVisible());
    await radio(p, 'Conversion values (5)').click();
    await p.getByText('(ends the window)').waitFor();
    assert.ok(await p.getByText('Events Manager', { exact: false }).isVisible());
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('a build channel filters the app and says Apple does not split by it', async () => {
    const { page, problems } = await open('#/app/stillwater');
    const channels = page.getByRole('radiogroup', { name: 'Build channel' });
    await channels.waitFor();
    await radio(channels, 'testflight').click();
    await panel(page, 'Attribution').getByText(/not split by build channel/).waitFor();
    await radio(channels, 'All channels').click();
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('a funnel built on the page, with a condition, and a prop explored', async () => {
    const { page, problems } = await open('#/app/tally');
    const builder = panel(page, 'Build a funnel');
    await builder.waitFor();
    await builder.getByLabel('Step 1 event').selectOption('paywall_viewed');
    await builder.getByLabel('Step 2 event').selectOption('purchase_result');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/funnel?') && r.url().includes('result%3Dpurchased')),
      builder.getByLabel('Step 2 condition').fill('result=purchased'),
    ]);
    await builder.getByText(/made it from the first step to the last/).waitFor();
    const explore = panel(page, 'Explore');
    assert.ok((await explore.locator('select').count()) >= 2, 'an event and a prop to pick');
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('dev: every panel still renders, empty where dev has nothing', async () => {
    const { page, problems } = await open('#/app/pace');
    await radio(page, 'Dev').click();
    await page.waitForTimeout(800);
    await panel(page, 'Attribution').waitFor();
    await panel(page, 'Campaigns').waitFor();
    await radio(page, 'Prod').click();
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('on a phone nothing runs off the side of the page', async () => {
    const { page, problems } = await open('#/app/stillwater', { width: 390, height: 844 });
    await panel(page, 'Attribution').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page ${overflow}px wider than the screen`);
    assert.deepEqual(problems, []);
    await page.close();
  });
});

describe('the rest', () => {
  test('feedback: the inbox and a thread', async () => {
    const { page, problems } = await open('#/feedback?status=all');
    const first = page.locator('main a, main button').filter({ hasText: /.{12,}/ }).first();
    await first.waitFor();
    await first.click();
    await page.waitForTimeout(600);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('feedback: a thread with an email is not linked to an install; one without links to its install', async () => {
    const { page, problems } = await open('#/feedback?status=all');
    const details = page.locator('details');
    await page.getByRole('link', { name: /Restore purchase/ }).click();
    await details.locator('summary').click();
    await details.getByText('Not linked to an install (email given)').waitFor();
    assert.equal(await details.locator('a[href^="#/installs"]').count(), 0, 'nothing leads to an install page');
    await page.getByRole('link', { name: /Sleep sounds after a session/ }).click();
    await page.getByRole('heading', { name: 'Sleep sounds after a session' }).waitFor();
    if (!(await details.evaluate((d) => d.open))) await details.locator('summary').click();
    await details.locator('a[href^="#/installs"]').waitFor();
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('installs: the lookup page, and dark mode everywhere', async () => {
    const { page, problems } = await open('#/installs');
    await page.getByRole('heading', { name: /Installs/ }).first().waitFor();
    await page.getByRole('radio', { name: /dark/i }).click().catch(async () => page.getByRole('button', { name: /dark/i }).click());
    for (const path of ['#/', '#/app/stillwater', '#/feedback']) {
      await page.goto(`${srv.base}/dashboard/${path}`);
      await page.waitForTimeout(700);
    }
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('an unknown app is a clear error, not a blank page', async () => {
    const { page } = await open('#/app/nope');
    await page.waitForTimeout(800);
    assert.ok((await page.locator('main').textContent()).trim().length > 0);
    await page.close();
  });
});
