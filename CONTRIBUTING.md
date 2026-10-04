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

## The README and the site

What users read about hush is in this repository: the README and the
packages' READMEs, and `docs/site/`, the content of
[hush.bavrk.com](https://hush.bavrk.com) (its docs page, every string on it,
its showcase and the screenshots; see [docs/site/README.md](docs/site/README.md)).
A change users can see updates them in the same pull request:

- a new or changed feature, option, endpoint or variable: the README, and
  `docs/site/docs.md`; a new feature also gets a card in `docs/site/en.json`
  (`features.fN_h`, `fN_p`) with its icon in `site.config.json`;
- a change to the dashboard: the screenshots, once it is on the live demo
  (`cd dashboard && npm run shots`, with `pngquant` installed), and a
  showcase screen for a new page;
- a new package version: the "This page is for" line in `docs/site/docs.md`
  (`test/site.test.mjs` fails until it matches).

The `docs` check fails a pull request that changes the dashboard, the SDK,
the server or the native packages without touching any of these. Add the
`no-docs` label when there is nothing to say (a refactor, a test, a fix that
changes nothing a user sees). A merge that changes `docs/site/` deploys the
site.

## The iOS app

`ios-app/` is the dashboard as an iOS app. `HushKit/` holds the `/admin`
API's models and client and is tested on a Mac with `swift test`; its
fixtures are the demo's own answers. `Hush/` is the SwiftUI app. The Xcode
project is generated from `project.yml` with XcodeGen:

```sh
brew install xcodegen
cd ios-app/HushKit && swift test && cd ..
xcodegen && open Hush.xcodeproj
```

A change to an `/admin` answer the app reads updates `HushKit`'s models and
fixtures in the same pull request. The `ios` workflow runs on changes under
`ios-app/` only.

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

## Releasing @bavrk/hush-capacitor

Bump `capacitor/package.json`, commit, then `git tag capacitor-v<version> &&
git push origin capacitor-v<version>`; `.github/workflows/publish-capacitor.yml`
typechecks, builds and publishes it with the same `NPM_TOKEN`. Its Swift
builds on its own against capacitor-swift-pm:
`cd capacitor && xcodebuild -scheme BavrkHushCapacitor -destination 'generic/platform=iOS Simulator' build`.
Build an app that uses it (`npx cap sync ios`, then Xcode) before tagging.
