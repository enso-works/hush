// What the site and the README show, checked before it ships: docs/site/ (what
// hush.bavrk.com says; its build lives in another repository, so a mistake
// here would only surface at its deploy) and the README's images. No
// database, no network.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'docs', 'site');
const read = (file) => readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const version = (dir) => json(join(root, dir, 'package.json')).version;

const config = json(join(site, 'site.config.json'));
const strings = json(join(site, 'en.json'));
const docs = read(join(site, 'docs.md'));

// Numbered strings until the first gap, as the site's list() reads them.
const list = (group, suffix) => {
  const out = [];
  for (let i = 1; typeof strings[group]?.[`${group[0]}${i}_${suffix}`] === 'string'; i++) out.push(strings[group][`${group[0]}${i}_${suffix}`]);
  return out;
};
// The site serves docs/site/shots/ as /img/shots/.
const shotFile = (url) => {
  assert.match(url, /^\/img\/shots\/[a-z0-9-]+\.png$/, `${url}: not under /img/shots/`);
  return join(site, 'shots', url.slice('/img/shots/'.length));
};

test('every feature has an icon, and every icon a feature', () => {
  const heads = list('features', 'h');
  assert.equal(list('features', 'p').length, heads.length, 'a feature without its text');
  assert.equal(config.featureIcons.length, heads.length, `${heads.length} features, ${config.featureIcons.length} featureIcons`);
});

test('every showcase screen has its caption and both images', () => {
  const heads = list('showcase', 'h');
  assert.ok(config.showcase.length > 0);
  config.showcase.forEach((s, i) => {
    assert.ok(heads[i], `showcase[${i}] has no showcase.s${i + 1}_h in en.json`);
    assert.ok(strings.showcase[`s${i + 1}_p`], `showcase[${i}] has no showcase.s${i + 1}_p in en.json`);
    for (const url of [s.light, s.dark]) assert.ok(existsSync(shotFile(url)), `${url}: no such file in docs/site/shots/`);
  });
  assert.equal(heads.length, config.showcase.length, 'a showcase caption without a screen');
  for (const url of [config.heroScreen, config.heroScreenDark]) assert.ok(existsSync(shotFile(url)), `${url}: no such file`);
});

test('no shot is left that nothing shows', () => {
  const used = new Set([config.heroScreen, config.heroScreenDark, ...config.showcase.flatMap((s) => [s.light, s.dark])]);
  for (const file of readdirSync(join(site, 'shots'))) assert.ok(used.has(`/img/shots/${file}`), `docs/site/shots/${file} is not in site.config.json`);
});

test('the docs page names the package versions this repository is at', () => {
  const m = /This page is for `@bavrk\/hush` ([\d.]+), `@bavrk\/hush-expo` ([\d.]+) and\s+`@bavrk\/hush-capacitor` ([\d.]+)/.exec(docs);
  assert.ok(m, 'docs.md: the "This page is for" sentence is gone or reworded');
  assert.deepEqual(m.slice(1), [version('sdk'), version('expo'), version('capacitor')], 'docs.md describes other versions than sdk/, expo/ and capacitor/ are at');
});

test("the docs page's links within it reach a heading", () => {
  // Astro's slugs (github-slugger): lower case, punctuation dropped, spaces to dashes.
  const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const slugs = new Set([...docs.matchAll(/^#{2,6} (.+)$/gm)].map((m) => slug(m[1].replace(/`/g, ''))));
  for (const [, anchor] of docs.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(slugs.has(anchor), `docs.md links to #${anchor}, which no heading makes`);
});

test("the README's images exist", () => {
  const readme = read(join(root, 'README.md'));
  const images = [...readme.matchAll(/(?:src|srcset)="(docs\/img\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(images.length > 0);
  for (const file of images) assert.ok(existsSync(join(root, file)), `README.md shows ${file}, which does not exist`);
});
