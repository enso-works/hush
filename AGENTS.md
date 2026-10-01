# hush: notes for agents working on this repository

hush is in-app feedback and anonymous usage tracking: a Node server with
Postgres and a dashboard, an SDK on npm (`@bavrk/hush`), and a native iOS
companion (`@bavrk/hush-expo`). This file is for work on hush itself. Agents
that add hush to an app use the plugin in `plugins/hush/` instead.

## Layout

| Path | What it is |
|---|---|
| `src/` | The server: plain Node 22 ESM, no framework, one runtime dependency (`pg`). `server.mjs` routes, `ingest.mjs` events, `catalog.mjs` the catalog, `attribution.mjs` Apple postbacks, `cli.mjs` the admin CLI. |
| `src/dashboard/` | The built dashboard, committed so running hush needs no build step. Never edit by hand. |
| `migrations/` | SQL, applied in file-name order at every boot, each in a transaction. |
| `dashboard/` | The dashboard's source (React, Tailwind, shadcn, Magic UI, Vite). Builds into `src/dashboard/`. `e2e/` drives it in Chromium. |
| `sdk/` | `@bavrk/hush`: `src/core.ts` (platform-free), `src/index.ts` (React Native and Expo), `src/web.ts` (browser). |
| `expo/` | `@bavrk/hush-expo`: the Swift module in `ios/`, the JS in `src/`, the config plugin `app.plugin.js`. |
| `test/` | `node:test` suites. Server tests run the real server against real Postgres. `sdk.test.mjs` runs the SDK under Node with React Native mocked (`test/sdk/`). `expo.test.mjs` and `plugin.test.mjs` need no database. `__snapshots__/v1-compat.json` freezes `/v1`. |
| `examples/` | `docker-compose.yml`, `.env.example`, `catalog.example.json`, an Expo setup file. |
| `docs/dogfood.md` | Friction found while using hush in our own apps, newest first. |
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
node --test test/sdk.test.mjs test/expo.test.mjs test/plugin.test.mjs
```

The packages and the dashboard, from the repository root:

```bash
(cd sdk && npm ci && npm run typecheck && npm run build)
(cd expo && npm install && npm run typecheck && npm run build)
(cd dashboard && npm ci && npm run lint && npm run build)                  # writes src/dashboard/
(cd dashboard && npx playwright install chromium && npm run e2e)           # needs the test Postgres
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
  an install id next to an email. Apps answer the App Store's
  privacy questions on that ([README](README.md#what-a-ticket-carries)).
- **Never commit secrets**: `.env`, `examples/.env`, `ADMIN_TOKEN`, App Store
  Connect `.p8` keys, RevenueCat or Resend keys, npm tokens. Never print them.
  Write keys in docs and tests are placeholders such as `hush_myapp_prod_…`.
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
- **Keep the plugin in step.** `plugins/hush/skills/hush/SKILL.md` and its
  `references/` describe the SDK, hush-expo, the server and the catalog as they
  are. When any of those change, update them in the same change, set
  `metadata.sdk-version` in `SKILL.md` to the SDK version (a test checks it),
  and bump `version` in `plugins/hush/.claude-plugin/plugin.json`: installed
  users only get a new plugin version.
- **Style**: comments say why, not what. Docs are plain and concrete, in short
  sentences, without marketing adjectives.
- Record friction from using hush in `docs/dogfood.md`.
