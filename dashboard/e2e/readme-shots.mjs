// The README's images and the site's showcase, from the live demo, in both
// themes: docs/img/ (the README, plus the site's hero) and docs/site/shots/
// (hush.bavrk.com's browser frames, 1200x700). Run after a change to the
// dashboard is live on the demo, or to the site's hero, then commit them.
//   npm run shots                 # from dashboard/; pngquant on PATH
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const SITE = 'https://hush.bavrk.com/';
const DEMO = `${SITE}demo/dashboard/`;
const DOCS = join(import.meta.dirname, '../../docs');
const RAW = join(tmpdir(), 'hush-readme-shots');
// Animations would be caught mid-way; the demo's CSP refuses the style that stops them.
const STILL = '*{animation:none!important;transition:none!important}';

// name, the README's height, the site's: the README shows a page down to the
// end of what matters, the site a fixed frame.
const PAGES = [
  ['overview', 600, 700],
  ['app', 1500, 700],
  ['feedback', 720, 700],
  ['installs', 760, null],
  ['config', 496, 700],
];

rmSync(RAW, { recursive: true, force: true });
mkdirSync(join(RAW, 'img'), { recursive: true });
mkdirSync(join(RAW, 'site'), { recursive: true });
const browser = await chromium.launch();

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: 'reduce',
    bypassCSP: true,
  });
  const page = await ctx.newPage();

  // The hero, from the badge to the note under it. Its buttons go: in a README
  // an image is one link, so the README puts real links under it. Found by
  // their link, not a class name: Tailwind scans this file too, and would add
  // that class to the dashboard's CSS.
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: STILL });
  await page.evaluate(() => {
    const hero = document.querySelector('h1').parentElement;
    [...hero.children].find((el) => el.querySelector('a[href*="/demo/"]'))?.remove();
    document.querySelector('header')?.remove();
  });
  await page.waitForTimeout(1000);
  const section = await page.locator('h1').locator('xpath=ancestor::section[1]').boundingBox();
  const note = await page.locator('h1').locator('xpath=following-sibling::p[last()]').boundingBox();
  await page.screenshot({
    path: join(RAW, 'img', `hero-${theme}.png`),
    clip: { x: 0, y: section.y, width: 1280, height: note.y + note.height + 40 - section.y },
  });

  // Ticket ids follow the demo's seed, so follow its links instead of naming
  // them: a thread with an answer in it, and an install from a ticket that
  // has one (a ticket with an email has none).
  await page.goto(`${DEMO}#/feedback?status=answered`, { waitUntil: 'networkidle' });
  const answered = (await page.getAttribute('a[href^="#/feedback/"]', 'href')).match(/^#\/feedback\/(\d+)/)[1];
  await page.goto(`${DEMO}#/feedback?status=all`, { waitUntil: 'networkidle' });
  let install;
  for (const href of await page.locator('a[href^="#/feedback/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
    await page.goto(DEMO + href, { waitUntil: 'networkidle' });
    install = await page.locator('a[href^="#/installs/"]').first().getAttribute('href', { timeout: 2000 }).catch(() => null);
    if (install) break;
  }
  const hashes = {
    overview: '#/',
    app: '#/app/stillwater',
    feedback: `#/feedback/${answered}?status=all`,
    installs: install,
    config: '#/app/stillwater/config',
  };

  await page.goto(DEMO, { waitUntil: 'networkidle' });
  await page.evaluate((t) => localStorage.setItem('hush.theme', t), theme);
  const shot = async (hash, width, height, file) => {
    await page.setViewportSize({ width, height });
    await page.goto(DEMO + hash, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.addStyleTag({ content: STILL });
    // The demo's banner, outermost element holding only its text.
    await page.evaluate(() => {
      const hits = [...document.querySelectorAll('body *')].filter((el) => /^Demo: invented/.test(el.textContent?.trim() ?? ''));
      let el = hits.at(-1);
      while (el?.parentElement && el.parentElement.textContent.trim() === el.textContent.trim()) el = el.parentElement;
      el?.remove();
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: file });
  };
  for (const [name, readme, site] of PAGES) {
    await shot(hashes[name], 1280, readme, join(RAW, 'img', `${name}-${theme}.png`));
    if (site) await shot(hashes[name], 1200, site, join(RAW, 'site', `${name}-${theme}.png`));
  }
  await ctx.close();
}
await browser.close();

const squeeze = (from, to) => execFileSync('pngquant', ['--quality', '70-90', '--speed', '1', '--strip', '--force', '--output', to, from]);
for (const theme of ['dark', 'light']) {
  squeeze(join(RAW, 'img', `hero-${theme}.png`), join(DOCS, 'img', `hero-${theme}.png`));
  for (const [name, , site] of PAGES) {
    squeeze(join(RAW, 'img', `${name}-${theme}.png`), join(DOCS, 'img', `${name}-${theme}.png`));
    if (site) squeeze(join(RAW, 'site', `${name}-${theme}.png`), join(DOCS, 'site', 'shots', `${name}-${theme}.png`));
  }
}
rmSync(RAW, { recursive: true });
console.log(`wrote ${join(DOCS, 'img')} and ${join(DOCS, 'site', 'shots')}`);
