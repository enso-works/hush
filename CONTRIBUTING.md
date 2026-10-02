# Contributing

## Running the tests

The suite runs the real server (`node src/server.mjs`) against a real
Postgres, one fresh database per test file, so migrations from empty run
every time.

```bash
docker run -d --rm --name hush-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
npm ci
npm test
```

Any Postgres you can create databases on works: point `TEST_DATABASE_URL` at
it (default `postgresql://test:test@127.0.0.1:55432/postgres`).

The SDK (`sdk/`, published as `@bavrk/hush`) is tested by `npm test` too:
`test/sdk.test.mjs` runs its TypeScript under Node with React Native mocked.
`cd sdk && npm ci && npm run typecheck && npm run build` checks and builds it.

## Releasing the SDK

1. Bump `version` in `sdk/package.json` and `SDK_VERSION` in `sdk/src/core.ts`
   (a test fails when they differ), and say what changed in the commit.
2. `git tag sdk-v<version> && git push origin sdk-v<version>`.

The `publish sdk` workflow checks the tag against the package, runs the
tests, builds, and publishes with npm provenance. It needs the `NPM_TOKEN`
secret. Semver: anything an app would have to change for is a major.

## The dashboard

The dashboard's source is `dashboard/` (React, Tailwind, shadcn and Magic UI,
built with Vite). It builds into `src/dashboard/`, which is committed: running
hush never needs a build step or anything beyond `pg`. After changing it,
rebuild and commit both; CI fails when the two disagree.

```bash
cd dashboard && npm ci
# against a local DEMO=1 server: DATABASE_URL=... DEMO=1 PORT=3055 node src/server.mjs
npm run dev              # http://127.0.0.1:5173/, /admin proxied to HUSH_URL (default :3055)
npm run build            # writes ../src/dashboard/
```

The page is served with a strict CSP (scripts, styles and fonts from 'self'
only), so nothing may inject a `<style>` element or an inline script:
components that do (next-themes, the upstream shadcn chart) were adapted.
Style props set from JavaScript are fine.

## The /v1 contract is frozen

`test/compat.test.mjs` replays a fixed script against `/v1` and compares every
status code and body with `test/__snapshots__/v1-compat.json`, recorded from
the server that apps in the wild were built against. Apps cannot be
redeployed when the server changes, so a diff there is a breaking change for
people already using them. Regenerate the snapshot (`UPDATE_SNAPSHOTS=1 npm
test`) only for a change every shipped SDK version handles, and say why in
the commit.

## The config evaluator

Remote config targeting is evaluated on the device by `sdk/src/evaluate.js`,
and by the server for the dashboard's Preview as. The evaluator has one
source, `sdk/src/evaluate.js`; `src/evaluate.mjs` is a byte-identical copy,
since the Docker image has no `sdk/` (`test/config-eval.test.mjs` fails when
they differ). Edit the SDK's, copy it over, and add a fixture case in
`test/__fixtures__/config-eval.json`: both copies run every case in it.

## Migrations

Add a new `migrations/NNN_name.sql`; never edit one that has shipped. They
are applied in order, by file name, each in a transaction, at every boot.

## Style

The server: plain Node, no framework, one runtime dependency. Comments say
why, not what.

## The dashboard in a browser

`dashboard/e2e/` drives the built dashboard in Chromium against a DEMO server:
every page and panel, every switch, and any console error or failed `/admin`
request fails it. With the test Postgres running:

```sh
cd dashboard && npx playwright install chromium && npm run e2e
```

## Releasing @bavrk/hush-expo

Bump `expo/package.json`, commit, then `git tag expo-v<version> && git push
origin expo-v<version>`; `.github/workflows/publish-expo.yml` publishes it
with the same `NPM_TOKEN`. Its Swift is only compiled by an app: build one
(Braele is the reference) for the simulator before tagging.
