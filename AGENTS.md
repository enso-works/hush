# hush: notes for agents working on this repository

hush is in-app feedback and anonymous usage tracking: a Node server with
Postgres and a dashboard, an SDK on npm (`@bavrk/hush`), native iOS
companions for Expo (`@bavrk/hush-expo`) and Capacitor
(`@bavrk/hush-capacitor`), a Swift SDK for native iOS apps (`Hush`, through
Swift Package Manager from this repository), and an iOS dashboard app
(`ios-app/`). This file is for work on hush itself. Agents
that add hush to an app use the plugin in `plugins/hush/` instead.

## Layout

| Path | What it is |
|---|---|
| `src/` | The server: plain Node 22 ESM, no framework, one runtime dependency (`pg`). `server.mjs` routes, `ingest.mjs` events, `catalog.mjs` the catalog, `sweep.mjs` what the server deletes on its own (retention, private screens), `attribution.mjs` Apple postbacks, `remote-config.mjs` remote config (`/v1/config`, overrides, history, preview), `devices.mjs` phones signed in with a token of their own (pairing codes for the dashboard's QR code), `config-schema.mjs` its validation, `evaluate.mjs` the config evaluator (a copy of the SDK's), `cli.mjs` the admin CLI. |
| `src/dashboard/` | The built dashboard, committed so running hush needs no build step. Never edit by hand. |
| `migrations/` | SQL, applied in file-name order at every boot, each in a transaction. |
| `dashboard/` | The dashboard's source (React, Tailwind, shadcn, Magic UI, Vite). Builds into `src/dashboard/`. `e2e/` drives it in Chromium. |
| `sdk/` | `@bavrk/hush`: `src/core.ts` (platform-free), `src/index.ts` (React Native and Expo), `src/web.ts` (browser), `src/evaluate.js` (the remote config evaluator). |
| `expo/` | `@bavrk/hush-expo`: the Swift module in `ios/`, the JS in `src/`, the config plugin `app.plugin.js`. |
| `capacitor/` | `@bavrk/hush-capacitor`: the same for Capacitor, iOS 15. The Swift plugin in `ios/Sources/HushCapacitorPlugin/`, `Package.swift` and `BavrkHushCapacitor.podspec` (both named as `npx cap sync` derives from the package name), the JS in `src/`. No config plugin. |
| `ios-app/` | The iOS app (work in progress): `HushKit/`, a Swift package with the `/admin` API's models and client (`swift test`), and `Hush/`, the SwiftUI app, iOS 18. `project.yml` is the Xcode project for XcodeGen; `Hush.xcodeproj` is generated, not committed. |
| `Package.swift`, `swift/` | `Hush`, the Swift SDK for native iOS apps (iOS 15), at the root because Swift Package Manager installs from there. `swift/Sources/Hush/`: the same rules as `sdk/src/core.ts` (events, sessions, queue, opt-out, forget, feedback); no remote config or attribution yet. Released by plain semver tags (`0.1.0`). |
| `test/` | `node:test` suites. Server tests run the real server against real Postgres. `sdk.test.mjs` runs the SDK under Node with React Native mocked (`test/sdk/`). `expo.test.mjs`, `capacitor.test.mjs` (Capacitor's bridge mocked) and `plugin.test.mjs` need no database. `__snapshots__/v1-compat.json` freezes `/v1`. |
| `examples/` | `docker-compose.yml`, `.env.example`, `catalog.example.json`, an Expo setup file. |
| `docs/dogfood.md` | Friction found while using hush in our own apps, newest first. |
| `docs/accounts.md` | The design for accounts (people, roles, teams), agreed before it is built. |
| `docs/img/` | The README's images: `logo.svg` (a copy of `dashboard/public/favicon.svg`), and the hero and dashboard images, in light and dark, taken from hush.bavrk.com by `dashboard/e2e/readme-shots.mjs`. |
| `docs/site/` | The content of hush.bavrk.com: `docs.md` (its docs page), `en.json` (every string), `site.config.json` (features' icons, showcase), `shots/`. The site's code is in the private `enso-works/bavrk` repo under `hush/`, which copies these in at build; `test/site.test.mjs` checks them. |
| `.claude-plugin/marketplace.json`, `plugins/hush/` | The Claude Code marketplace and plugin shipped to users: the `hush` skill (also installable with `npx skills add enso-works/hush`), the `installer` and `tracking-planner` agents, and `/hush:install`. |

## Commands

Tests need a Postgres the suite can create databases on
([CONTRIBUTING.md](CONTRIBUTING.md)):

```bash
docker run -d --rm --name hush-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
npm ci
npm test                                   # every test/*.test.mjs
node --test test/events.test.mjs           # one file
```

`TEST_DATABASE_URL` points elsewhere (default
`postgresql://test:test@127.0.0.1:55432/postgres`).

Without a database:

```bash
node --test test/sdk.test.mjs test/expo.test.mjs test/capacitor.test.mjs test/plugin.test.mjs
```

The packages and the dashboard, from the repository root:

```bash
(cd sdk && npm ci && npm run typecheck && npm run build)
(cd expo && npm install && npm run typecheck && npm run build)
(cd capacitor && npm ci && npm run typecheck && npm run build)
(cd capacitor && xcodebuild -scheme BavrkHushCapacitor -destination 'generic/platform=iOS Simulator' build)   # the Swift, against capacitor-swift-pm
(cd dashboard && npm ci && npm run lint && npm run build)                  # writes src/dashboard/
(cd dashboard && npx playwright install chromium && npm run e2e)           # needs the test Postgres
swift test                                                                # the Swift SDK; HUSH_E2E_URL, _KEY, _ADMIN add the live test
(cd ios-app/HushKit && swift test)                                       # the iOS app's models and client; HUSH_LIVE=1 adds the live demo
(cd ios-app && xcodegen && xcodebuild -project Hush.xcodeproj -scheme Hush -destination 'generic/platform=iOS Simulator' build)
(cd dashboard && npm run shots)                                          # the README's and the site's images, from the live demo; needs pngquant
```

The dashboard in development: run a server with `DEMO=1 PORT=3055` against its
own database, then `cd dashboard && npm run dev` (`/admin` is proxied to
`HUSH_URL`, default `:3055`).

The plugin:

```bash
node --test test/plugin.test.mjs
claude plugin validate .
claude plugin validate ./plugins/hush
```

## Rules

- **`/v1` is frozen.** `test/compat.test.mjs` replays a script against `/v1`
  and compares every status and body with `test/__snapshots__/v1-compat.json`.
  Apps in users' hands cannot be redeployed, so a diff there is a breaking
  change. Regenerate (`UPDATE_SNAPSHOTS=1 npm test`) only for a change every
  shipped SDK version handles, and say why in the commit.
- **Usage data is not linked.** A ticket with an email never carries the
  install id or RevenueCat's id, no request carries an install id and a
  thread key together, nothing stored on such a ticket records when an app
  read it, and nothing on the dashboard, in an alert mail or in the log puts
  an install id next to an email. Nothing stores or shows a screen in an
  app's `private_screens`. Apps answer the App Store's
  privacy questions on that ([README](README.md#what-a-ticket-carries)).
- **Never commit secrets**: `.env`, `examples/.env`, `ADMIN_TOKEN`, App Store
  Connect `.p8` keys, RevenueCat or Resend keys, npm tokens. Never print them.
  Write keys in docs and tests are placeholders such as `hush_myapp_prod_…`.
- **The config evaluator has one source**, `sdk/src/evaluate.js`;
  `src/evaluate.mjs` is a byte-identical copy (`test/config-eval.test.mjs`).
  Edit the SDK's, copy it over, and add a fixture case in
  `test/__fixtures__/config-eval.json`.
- **Migrations**: add a new `migrations/NNN_name.sql`; never edit one that has
  shipped.
- **Dashboard**: after changing `dashboard/`, rebuild and commit
  `src/dashboard/` with it; CI fails when they differ. The page runs under a
  strict CSP: nothing may inject a `<style>` element or an inline script.
- **Releasing the SDK**: bump `sdk/package.json` and `SDK_VERSION` in
  `sdk/src/core.ts` together (a test fails when they differ), commit, then tag
  `sdk-v<version>` and push the tag. The `publish sdk` workflow publishes with
  provenance. Semver: anything an app must change for is a major.
- **Releasing hush-expo**: bump `expo/package.json`, build an app that uses it
  for the simulator, commit, then tag `expo-v<version>` and push the tag.
- **Releasing hush-capacitor**: bump `capacitor/package.json`, build the
  Swift (the `xcodebuild` line above) and an app that uses it, commit, then
  tag `capacitor-v<version>` and push the tag.
- **Releasing the Swift SDK**: bump `sdkVersion` in
  `swift/Sources/Hush/Client.swift` and the version in `docs/site/docs.md`
  and `swift/README.md` (`test/site.test.mjs` checks the docs page), commit,
  then tag the plain version (`git tag 0.1.1`) and push the tag. The `publish
  swift` workflow checks the tag against `sdkVersion`, tests, builds for iOS
  and creates the GitHub release; Swift Package Manager reads the tag. A
  change to `/v1` the JavaScript SDK makes, the Swift one makes too: they
  must stay indistinguishable to the server.
- **Keep the plugin in step.** `plugins/hush/skills/hush/SKILL.md` and its
  `references/` describe the SDK, hush-expo, hush-capacitor, the server and
  the catalog as they are. When any of those change, update them in the same
  change, set `metadata.sdk-version` in `SKILL.md` to the SDK version (a test
  checks it), and bump `version` in `plugins/hush/.claude-plugin/plugin.json`:
  installed users only get a new plugin version.
- **Keep the README and the site in step.** A change users can see (a
  feature, an option, an endpoint, a variable, a dashboard page) updates
  `README.md` (or the package's README) and `docs/site/docs.md` in the same
  change; a new feature also gets a card in `docs/site/en.json` with its icon
  in `docs/site/site.config.json`. After a dashboard change is on the live
  demo, run `npm run shots` and commit the images. A new package version
  updates the "This page is for" line in `docs/site/docs.md`
  (`test/site.test.mjs` checks it). The `docs` workflow fails a pull request
  that changes code users see without touching any docs; the `no-docs` label
  is for changes with nothing to say. A merge that changes `docs/site/`
  deploys hush.bavrk.com.
- **Style**: comments say why, not what. Docs are plain and concrete, in short
  sentences, without marketing adjectives.
- Record friction from using hush in `docs/dogfood.md`.
