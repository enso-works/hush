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

The SDK (`sdk/`, published as `@enso/hush`) is tested by `npm test` too:
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

## Migrations

Add a new `migrations/NNN_name.sql`; never edit one that has shipped. They
are applied in order, by file name, each in a transaction, at every boot.

## Style

The server: plain Node, no framework, one runtime dependency. Comments say
why, not what.
