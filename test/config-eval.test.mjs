// The remote config evaluator has one source, sdk/src/evaluate.js, run on the
// device; the server runs a byte-identical copy (src/evaluate.mjs) for the
// dashboard's "preview as". Both must give the same answer for every case in
// the shared fixture, or the dashboard would preview what no device gets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'evaluate.mjs');
const SDK = join(ROOT, 'sdk', 'src', 'evaluate.js');
const fixture = JSON.parse(readFileSync(join(ROOT, 'test', '__fixtures__', 'config-eval.json'), 'utf8'));

test('src/evaluate.mjs is byte for byte sdk/src/evaluate.js', () => {
  assert.ok(readFileSync(SERVER).equals(readFileSync(SDK)), 'src/evaluate.mjs is a copy of sdk/src/evaluate.js: copy it over');
});

// An evaluation as the fixture writes it: no `value` when there is none.
const shape = (r) => ({ rule: r.rule, ...(r.value === undefined ? {} : { value: r.value }) });

for (const [name, file] of [['server', SERVER], ['sdk', SDK]]) {
  describe(`the fixture against the ${name} copy`, async () => {
    // The SDK's copy is a .js file in a package whose type is module, so Node
    // loads it as ESM either way.
    const impl = await import(pathToFileURL(file).href);

    test('buckets', () => {
      for (const b of fixture.buckets) assert.equal(impl.bucket(b.install, b.key), b.bucket, JSON.stringify(b));
    });
    test('versions', () => {
      for (const v of fixture.versions) assert.equal(impl.satisfies(v.version, v.range), v.satisfies, JSON.stringify(v));
    });
    test('languages', () => {
      for (const l of fixture.languages) assert.equal(impl.languageOf(l.tag), l.language, JSON.stringify(l));
    });
    test('cases', () => {
      for (const c of fixture.cases) {
        const got = 'install' in c
          ? impl.evaluateAll({ [c.key]: c.entry }, c.context, c.install)[c.key]
          : impl.evaluate(c.entry, c.context, c.bucket);
        assert.deepStrictEqual(shape(got), c.expect, c.name);
      }
    });
  });
}

test('the fixture has the sizes the spec gives it', () => {
  assert.equal(fixture.buckets.length, 12);
  assert.equal(fixture.versions.length, 26);
  assert.equal(fixture.languages.length, 11);
  assert.equal(fixture.cases.length, 76);
});
