# The hush server

What the operator runs: one Node container (Node 22 or later, one runtime
dependency, `pg`) and Postgres. Migrations run at every boot, before it listens.

## Contents

1. [Run it](#1-run-it)
2. [Environment](#2-environment)
3. [Apps and keys](#3-apps-and-keys)
4. [What to expose](#4-what-to-expose)
5. [The catalog](#5-the-catalog)
6. [Validate a catalog](#6-validate-a-catalog)
7. [Funnels and breakdowns on the dashboard](#7-funnels-and-breakdowns-on-the-dashboard)
8. [The /v1 API](#8-the-v1-api)
9. [The admin API and the CLI](#9-the-admin-api-and-the-cli)

## 1. Run it

```bash
git clone https://github.com/enso-works/hush && cd hush/examples
cp .env.example .env            # set ADMIN_TOKEN (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose up -d            # builds the image from ..; http://localhost:3000

docker compose exec hush node src/cli.mjs apps:add myapp "My App"
docker compose exec hush node src/cli.mjs keys:create myapp prod   # prints the key once
docker compose exec hush node src/cli.mjs keys:create myapp dev
```

- The compose file builds from source. There is no published image yet.
- It binds `127.0.0.1:${HUSH_PORT:-3000}` and keeps Postgres 16 in the volume
  `hush_db`.
- Dashboard: `http://localhost:3000/dashboard/`, signed in with `ADMIN_TOKEN`.
- Health: `GET /healthz` returns `{ ok: true, db: 'up' }`, or a 503.
- Without Docker: `npm ci --omit=dev`, then
  `DATABASE_URL=… ADMIN_TOKEN=… node src/server.mjs`.
- In the operator's own compose file the service may have another name; use it
  in place of `hush` in `docker compose exec`.

## 2. Environment

Only `DATABASE_URL` and `ADMIN_TOKEN` are required. With the example compose
file, set them in `examples/.env`: it passes every variable below into the
container except `PORT` (the container listens on 3000; `HUSH_PORT` picks the
host port) and `TELEMETRY_ADMIN_TOKEN` (use `ADMIN_TOKEN`), and builds
`DATABASE_URL` from `POSTGRES_PASSWORD`. A compose file of your own passes only
what its `environment:` block lists.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres |
| `ADMIN_TOKEN` | Guards `/admin/*` and the dashboard's data. `TELEMETRY_ADMIN_TOKEN` is an older alias. |
| `APPS` | Apps registered at boot: `myapp=My App,other=Other`. Slugs match `^[a-z][a-z0-9-]{0,39}$`; a malformed entry stops the boot. Existing apps keep their name. |
| `CATALOG_FILE` | The catalog (section 5). The compose file mounts it at `/config/catalog.json`. |
| `CLIENT_IP_HEADER` | Header a trusted proxy sets with the caller's address (`cf-connecting-ip`, `x-forwarded-for`), for rate limits. Unset: the socket address. Behind a proxy, set it: otherwise every caller shares the proxy's limits, and one app takes five tickets with an email a day from all its users. The server warns once when a request comes from a private address and it is unset. |
| `COUNTRY_HEADER` | Header a trusted proxy sets with a two-letter country (`cf-ipcountry`). Unset: no country. |
| `RESEND_API_KEY`, `MAIL_FROM` | Mail through Resend: feedback alerts, and replies to users who left an address. |
| `ALERT_EMAIL`, `REPLY_HINT` | Where new feedback is announced (at most 30 mails an hour; tickets are always stored), and a last line saying where to answer. |
| `RETENTION_DAYS` | Raw events are deleted after this many days. Default 180. Swept every 6 hours. |
| `INSTALL_RETENTION_DAYS` | An install's row is deleted once it has sent nothing for this many days (no batch, no event dated inside the window), in the same sweep. Default `RETENTION_DAYS`; 0 keeps every row. Not shorter than `RETENTION_DAYS`: the row would go while its events stay, and the install would count as new if it sent again before they went (the server warns at boot). Its tickets keep the install id: the operator can still answer them, and the app lists them again if the install comes back, as a new install. The dashboard's install total and Countries panel then count the installs seen in that window, not all time; new installs and retention count only the installs first seen inside it, so the 1y view is cut to it and says so. |
| `RC_API_KEY` | RevenueCat v2 secret key with read-only scopes, for the revenue panel. |
| `RC_PROJECTS`, `RC_CURRENCY`, `RC_STALE_MINUTES`, `RC_FLOOR_SECONDS`, `RC_RATE_PER_MINUTE` | Project mapping (`myapp=projabc`) when names differ; currency (USD); cache and rate settings (10 min, 60 s, 20 a minute). |
| `ADMIN_PROXY_HEADER`, `ADMIN_PROXY_SECRET` | A header a trusted proxy sets, and its secret (16 characters or more), accepted on `/admin/*` in place of the token. Both or neither. |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` or `ASC_PRIVATE_KEY_FILE`, `ASC_API_BASE` | App Store Connect API key for campaign reports; see [attribution.md](attribution.md). `ASC_PRIVATE_KEY_FILE` is a path inside the container: mount the `.p8` there. |
| `MAIL_DRY_RUN` | `1` logs mail instead of sending it. |
| `DEMO` | `1`: a public, read-only showcase with invented data. Wipes its database daily and refuses a database that has write keys; `/v1` returns 403. |
| `PORT` | Default 3000. |

Secrets (`ADMIN_TOKEN`, `RC_API_KEY`, the `.p8`, the Resend key) stay on the
server. Never commit them or print them.

## 3. Apps and keys

- **Register an app** with `APPS` or `node src/cli.mjs apps:add <slug> "<Name>"`.
  `apps:add` does not check the slug; keep to the `APPS` rule.
- **Mint keys** with `node src/cli.mjs keys:create <app> <prod|dev> [label]`.
  The app must exist. The key, `hush_<app>_<env>_<24 characters>`, is printed
  once; only its SHA-256 hash is stored. Keys minted under an older prefix keep
  working.
- **List and revoke** with `keys:list` (id, app, env, label, active or
  REVOKED) and `keys:revoke <id>`. Key lookups are cached for 60 s, so a
  revoked key works for up to a minute.
- **prod and dev.** The key's env is stamped on every event and install. The
  dashboard has a prod/dev switch (prod by default) and a channel filter (all
  channels by default; `unknown` means none was sent). A release build on the
  dev key is invisible in the default view. A dev build on the prod key
  pollutes it, unless you filter by channel.
- A write key ships inside the app and is not a secret: it identifies the app,
  can be revoked, and reads nothing but the calling install's own feedback.

## 4. What to expose

- **Public**, behind a TLS proxy: `/v1/*` and `/healthz`. For attribution,
  also `POST /.well-known/skadnetwork/report-attribution` and
  `POST /.well-known/appattribution/report-attribution`, on the registrable
  domain the app names (see [attribution.md](attribution.md)).
- **Private**, behind a VPN or an access proxy: `/dashboard/` and `/admin/*`.
  The token is the second lock, not the only one.
- A proxy on a private network may sign the dashboard in by adding
  `Authorization: Bearer <ADMIN_TOKEN>` or `<ADMIN_PROXY_HEADER>: <secret>` on
  `/admin/*`. Admin writes are accepted only as same-origin
  `Content-Type: application/json`.
- Set `CLIENT_IP_HEADER` and `COUNTRY_HEADER` only when the proxy overwrites
  those headers; otherwise any client can pick its own values.
- Run one instance: rate limits live in memory and reset on restart.
- Back up Postgres. It is the only state.

## 5. The catalog

`CATALOG_FILE` is a JSON object keyed by app slug. It is parsed once at boot:
any error throws with its path and stops the boot, and changes need a restart.
An app missing from the file still works, with only the common names known, no
highlight and the default Paywall funnel. A bare array is read as the app's
`events`.

```json
{
  "myapp": {
    "events": ["onboarding_completed", "workout_started", "workout_completed"],
    "highlight": { "event": "workout_completed", "done_prop": "completed" },
    "funnels": [
      { "name": "First workout", "steps": ["app_first_opened", "onboarding_completed", "workout_completed"] },
      { "name": "Paywall", "window_days": 3, "steps": ["paywall_viewed", "purchase_started",
        { "event": "purchase_result", "where": { "result": "purchased" }, "label": "Purchased" }] }
    ],
    "breakdowns": [
      { "event": "workout_completed", "prop": "kind", "title": "Workouts by kind" },
      { "event": "onboarding_completed", "prop": "goal", "count": "installs" }
    ],
    "private_screens": ["support", "feedback"],
    "app_store_id": "1234567890",
    "conversion_values": [
      { "value": 1, "coarse": "low", "event": "onboarding_completed", "label": "Onboarded" },
      { "value": 8, "coarse": "medium", "event": "workout_completed", "label": "First workout" },
      { "value": 63, "coarse": "high", "event": "purchase_result", "where": { "result": "purchased" }, "label": "Purchased", "lock": true }
    ]
  }
}
```

| Key | Rules |
|---|---|
| `events` | Event names (`^[a-z][a-z0-9_]{1,63}$`), added to the common names: `app_first_opened`, `session_started`, `screen_viewed`, `paywall_viewed`, `purchase_started`, `purchase_result`, `restore_result`, `ticket_opened`, `ticket_replied`. Unknown names are still stored, flagged unknown on the dashboard. |
| `highlight` | `{ event, done_prop? }`. The dashboard counts `event` per period, and "done" where `props[done_prop]` is `true`. `done_prop` is a prop name or null. |
| `funnels` | Up to 10. Each `{ name, steps, window_days? }`: a name (trimmed, up to 60), 2 to 8 steps, `window_days` an integer 1 to 90 (default 7). Steps are ordered, each within `window_days` of the first. A step is an event name or `{ event, where?, label? }`; `where` has 1 to 3 props with string, number or boolean values, compared as text; `label` up to 60. Present, it replaces the default Paywall funnel. **Omit the key rather than writing `[]`**: an empty list breaks the campaigns panel. |
| `breakdowns` | Up to 12. Each `{ event, prop, title?, count? }`: `prop` is a prop name, `title` up to 60 (default "Event by prop"), `count` `events` (default) or `installs` (for an answer that can change later). |
| `private_screens` | Screen names, as the app passes them to `screen()`: non-empty strings, without a trailing `/`. The server never stores a `screen_viewed` that names one, or a screen under one (`support` covers `support/new` and `support/42`, not `supportive` or `Support`), in any prop: it is counted as accepted and discarded. Any other event is stored without a prop that names one. Views stored before the catalog named it are deleted at boot (every prop) and in the six-hourly sweep (the `screen` prop). Matched exactly, case included: list each spelling the app sends. For the feedback and inbox screens. |
| `app_store_id` | The App Store id, digits (`^[1-9][0-9]{5,11}$`), string or number. Needed for App Store campaigns and to attach postbacks to the app. |
| `conversion_values` | Up to 20 milestones `{ value, coarse?, event, where?, label?, lock? }`: `value` an integer 1 to 63, strictly increasing; `coarse` `low`, `medium` or `high` (default `low`), never lower than the one before; `event` and `where` as in a funnel step; only `lock: true` locks. See [attribution.md](attribution.md). |

How to choose the contents: [tracking-plan.md](tracking-plan.md).

## 6. Validate a catalog

From a checkout of the hush repository, with its dependencies installed
(`npm ci`), without a database. A copy of this skill has no server code.
Importing `src/catalog.mjs` also parses the file `CATALOG_FILE` names, so unset
it:

```bash
env -u CATALOG_FILE node --input-type=module -e "import { readFileSync } from 'node:fs'; const m = await import('./src/catalog.mjs'); m.parseCatalog(readFileSync('/path/to/catalog.json', 'utf8')); console.log('ok')"
```

It prints `ok`, or throws with the path of the first problem, such as
`catalog.myapp.events: expected event names matching …`. A key in an app's
entry that the server does not read, misspelt or from a later version, is
ignored with a warning line before `ok` (a server before this check ignores
it without one). Check by eye what it does not:

- The key is the app's slug on the server, the `<app>` in its write keys. Any
  other key is accepted and never matches an app.
- Every event named in `highlight`, `funnels`, `breakdowns` and
  `conversion_values` is in `events` or is a common name.
- `conversion_values` come with `app_store_id`. Without it, postbacks are
  stored with no app and never shown.
- `private_screens` names the screens as the app sends them: route patterns
  with Expo Router (`support`), route names with React Navigation
  (`Support`, `SupportThread`).
- No `"funnels": []`.

## 7. Funnels and breakdowns on the dashboard

- The catalog's funnels are pinned to the app's page, counted in distinct
  installs per step, with the median time between steps.
- Any other funnel can be built on the dashboard without touching the catalog
  (`step=a&step=b:prop=value&window=7`).
- The breakdown panel splits any event by any prop; the catalog's
  `breakdowns` pin the ones worth keeping.
- The Campaigns panel counts each install once, for its first tagged session,
  split by `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
  `utm_content` or `ref`, and runs a catalog funnel from that session on.
- The Installs page shows one install's latest events: paste the id from
  `getInstallationId()`. It never lists a ticket with an email, and a ticket
  with an email shows "Not linked to an install (email given)" and no
  customer id. A "please delete my message" that comes by email is the
  ticket's Delete button. An install whose row went with
  `INSTALL_RETENTION_DAYS` shows its tickets without an email, and no row.
- No view shows a screen in `private_screens`: not the install page, not a
  breakdown, even before the sweep has deleted a view stored earlier.
- Every view takes the prod/dev switch and the channel filter.

## 8. The /v1 API

Apps send `Authorization: Key <write key>`. The SDK does this.

| Route | Body and answer |
|---|---|
| `POST /v1/events` | `{ sent_at, sdk, context, events }`, up to 100 events. 200 `{ accepted, duplicate, rejected }`. Any 4xx but 429: drop the batch. 429 and 5xx: retry. A view of a screen in `private_screens` counts as accepted and is not stored. |
| `POST /v1/tickets` | `{ install?, kind, message, email?, subject?, rc_id?, diag? }`. 201 `{ id, created_at, status }`. With an email and no install (SDK 2.3.0): stored with no install and no `rc_id`, and the answer adds `thread`, the key for that ticket (only its sha256 is stored). Without an email, `install` is required. 429 after five a day, per install, or per caller address and app without one. |
| `GET /v1/tickets?install=` | That install's tickets under this app, with replies and `unread`. Marks replies read. |
| `POST /v1/tickets/list` | `{ install }`. The same as the GET, with the install out of the URL and the access log (SDK 2.3.0). |
| `POST /v1/tickets/threads` | `{ threads: [key, …] }`, up to 50. The same answer as `GET /v1/tickets` for those tickets under this app. Marks replies read by the time of the newest reply shown, never the time of the request, which would match the install's own tickets. A POST so keys stay out of URLs and logs. |
| `POST /v1/tickets/:id/reply` | `{ install, body }` or `{ thread, body }`. 201, 404 for a wrong install or key, 409 once closed. |
| `POST /v1/forget` | `{ install }`: 200 `{ ok, deleted }`, the install's events, tickets and row under this app. Or `{ threads }` alone: 200 `{ ok, deleted: { tickets } }`. Both in one request is a 400. |
| `GET /v1/config` | `{ conversion_values: [{ value, coarse, event, where, lock }] }` from the catalog. |

`/v1` answers CORS for any origin. An install id that belongs to another app
gets 403 on tickets and forget. **The `/v1` contract is frozen**: shipped apps
cannot be redeployed, so a change there is a breaking change.

A ticket with an email from an app on SDK 2.2.x or older still arrives with
the install id and `rc_id`, and that app tracks `ticket_opened` and
`ticket_replied` with the install. The server drops `rc_id` at once and keeps
the install only so that app's inbox can list the ticket. The sweep (every
6 hours) clears it once the ticket is closed and the app has fetched it since
(or 7 days after it closed), or 30 days after its last activity, and deletes
that install's `ticket_opened` and `ticket_replied` events since the ticket
was opened. Migration `007_unlinked_tickets.sql` did the same for the tickets
stored before it. Once unlinked, the app's `forget()` no longer reaches the
ticket: the operator deletes it with Delete, on request.

## 9. The admin API and the CLI

The dashboard reads the admin API with `Authorization: Bearer <ADMIN_TOKEN>`:
`/admin/session`, `/admin/apps` (`?days=&env=`; with `install_retention_days`, null when off), `/admin/apps/:app`
(`?channel=`), `/admin/apps/:app/funnels`, `/funnel?step=…`, `/breakdown?event=&prop=`,
`/props?event=`, `/cohorts`, `/campaigns?by=&where=&funnel=`, `/attribution`,
`/admin/installs/:id` (and `POST …/forget`), `/admin/tickets`,
`/admin/tickets/:id` (and `POST …/reply`, `…/status`, `DELETE` for one
ticket and its replies), `/admin/revenue` (`?refresh=1`). Reads are GETs.
Replies, status changes, deletes and forget are writes, and every write is
`Content-Type: application/json`.

CLI, `node src/cli.mjs <command>`: `apps:list`, `apps:add`, `keys:create`,
`keys:list`, `keys:revoke`, `rc:projects`, `rc:link <app> <project_id>`,
`rc:sync`, `rc:charts`, `rc:poll`, `asc:request <app>`, `asc:sync [app]`,
`migrate`.
