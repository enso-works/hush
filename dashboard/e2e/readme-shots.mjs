// The README's images: the site's hero and the live demo's pages, in both
// themes, written to docs/img/. Run after a dashboard or site change shows
// up on hush.bavrk.com, then commit the images.
//   npm run shots                 # from dashboard/; pngquant on PATH
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const SITE = 'https://hush.bavrk.com/';
const DEMO = `${SITE}demo/dashboard/`;
const OUT = join(import.meta.dirname, '../../docs/img');
const RAW = join(tmpdir(), 'hush-readme-shots');
const WIDTH = 1280;
// Animations would be caught mid-way; the demo's CSP refuses the style that stops them.
const STILL = '*{animation:none!important;transition:none!important}';

mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });
const browser = await chromium.launch();

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: 'reduce',
    bypassCSP: true,
  });
  const page = await ctx.newPage();
  const save = (name, opts = {}) => page.screenshot({ path: join(RAW, `${name}-${theme}.png`), ...opts });

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
  await save('hero', { clip: { x: 0, y: section.y, width: WIDTH, height: note.y + note.height + 40 - section.y } });

  await page.goto(DEMO, { waitUntil: 'networkidle' });
  await page.evaluate((t) => localStorage.setItem('hush.theme', t), theme);
  const shot = async (hash, name, height) => {
    await page.setViewportSize({ width: WIDTH, height });
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
    await save(name);
  };

  await shot('#/', 'overview', 600);
  await shot('#/app/stillwater', 'app', 1500);
  // Ticket ids follow the demo's seed, so follow its links instead of naming them.
  await page.goto(DEMO + '#/feedback', { waitUntil: 'networkidle' });
  await shot(await page.getAttribute('a[href^="#/feedback/"]', 'href'), 'feedback', 720);
  await shot(await page.getAttribute('a[href^="#/installs/"]', 'href'), 'installs', 760);
  await shot('#/app/stillwater/config', 'config', 496);
  await ctx.close();
}
await browser.close();

for (const name of ['hero', 'overview', 'app', 'feedback', 'installs', 'config']) {
  for (const theme of ['dark', 'light']) {
    const file = `${name}-${theme}.png`;
    execFileSync('pngquant', ['--quality', '70-90', '--speed', '1', '--strip', '--force', '--output', join(OUT, file), join(RAW, file)]);
  }
}
rmSync(RAW, { recursive: true });
console.log(`wrote ${OUT}`);
