# telemetry

Anonymous app analytics and support tickets for the bavrk mobile fleet.
Public at `https://telemetry.bavrk.com`, read by the Apps and Tickets pages in
Cockpit (`ops.bavrk.com`). Design and rationale: [SPEC.md](SPEC.md).

Node 22, one dependency (`pg`). Fastify, zod and the Resend SDK from the
original plan are not here: a dozen routes and one flat body shape do not need
them, and a 192 MB container that talks to phones is better off with a small
dependency tree.

## Endpoints

| Route | Who calls it |
|---|---|
| `POST /v1/events` | phones — `Authorization: Key <write key>` |
| `POST /v1/tickets` | phones — same key |
| `GET /v1/tickets?install=<uuid>` | phones — the install's own tickets |
| `GET /healthz` | Caddy, the deploy smoke check, `scripts/healthcheck.sh` |
| `GET /admin/apps`, `/admin/apps/:app`, `/admin/apps/:app/breakdown` | Cockpit — `Authorization: Bearer $TELEMETRY_ADMIN_TOKEN` |
| `GET /admin/revenue` | Cockpit — the cached RevenueCat answer, same token |
| `GET /admin/tickets`, `/admin/tickets/:id`, `POST /admin/tickets/:id/{reply,status}` | Cockpit — same token |

`/admin/*` is answered with 404 by Caddy: it exists only on the docker
network, where Cockpit reaches it as `http://telemetry:3000`. The token is the
second lock, not the only one.

## Privacy

The only identifier is `installation_id`, a UUID the app generates for itself.
No IP is stored — not in the database, not in a Caddy access log (the site
block deliberately does not import one). The only thing derived from the
caller's address is Cloudflare's two-letter `CF-IPCountry`, kept on the install
row; the dashboard folds any country under ten installs into "other". An email
address exists only when a user typed one into a support ticket. Raw events are
deleted after `RETENTION_DAYS` (180); install rows and tickets are kept.

There is no consent toggle in the apps, because there is nothing personal to
consent to; the privacy policy describes what is collected.

## Write keys

A write key ships inside the app bundle, so it is an identifier, not a secret —
anyone can read one out of an IPA. Only its SHA-256 lives in the database,
requests are rate limited, and a key can be revoked without a redeploy.

```bash
# on the server, from /opt/bavrk
docker compose exec telemetry node src/cli.mjs apps:list
docker compose exec telemetry node src/cli.mjs keys:create braele prod "1.4.0"   # prints the key once
docker compose exec telemetry node src/cli.mjs keys:list
docker compose exec telemetry node src/cli.mjs keys:revoke 3
```

The printed key goes into the app's `EXPO_PUBLIC_TELEMETRY_KEY` and nowhere
else. `dev` and `prod` keys are separate rows; the dashboard shows `prod`.

## Server configuration

In `/opt/bavrk/.env` — every value double-quoted, as everything in that file
must be (it is sourced by bash during deploys):

| Variable | Notes |
|---|---|
| `TELEMETRY_DB_PASSWORD` | required; `scripts/ensure-app-db.sh` creates the role and database |
| `TELEMETRY_ADMIN_TOKEN` | required; also given to Cockpit |
| `TELEMETRY_RESEND_API_KEY` | ticket mail; without it tickets still store, nothing is mailed |
| `TELEMETRY_MAIL_FROM` | default `Bavrk Support <support@bavrk.com>` |
| `TELEMETRY_ALERT_EMAIL` | where new tickets land, default `ensar.bavrk@gmail.com` |
| `TELEMETRY_RETENTION_DAYS` | default 180 |
| `TELEMETRY_RC_API_KEY` | RevenueCat v2 **secret** key; without it the money block says so and nothing else changes |
| `TELEMETRY_RC_PROJECTS` | `braele=projabc,invoit=projdef`; only needed when a project's name is not the app's slug or display name |
| `TELEMETRY_RC_CURRENCY` | default `USD` — what RevenueCat converts to |
| `TELEMETRY_RC_STALE_MINUTES` | default 10 — opening the Apps page refreshes a cache older than this |
| `TELEMETRY_RC_FLOOR_SECONDS` | default 60 — how soon the refresh button may ask again |
| `TELEMETRY_RC_RATE_PER_MINUTE` | default 20; RevenueCat allows 25 |

## RevenueCat

Money is not derived from events: the Apps page shows RevenueCat's own numbers,
fetched by this service and cached in Postgres. There is no poller — one person
reads this dashboard, so a timer would spend ninety-odd pulls a day to be ready
for the two that get read. Opening the page refreshes a cache older than
`RC_STALE_MINUTES`, the page's refresh button forces one (no sooner than
`RC_FLOOR_SECONDS`), and concurrent requests share a single in-flight pull.

It is still the service that calls RevenueCat and never the browser. Nothing
else in the fleet holds the key, and Charts & Metrics allows 25 requests a
minute — a page fetching directly on every render would spend that in an
afternoon.

The key is created in RevenueCat under **Project settings → API keys → v2
secret key**, with `charts_metrics:overview:read`, `charts_metrics:charts:read`
and `project_configuration:projects:read`. It can read customers, so it is a
real secret: `/opt/bavrk/.env` only.

```bash
docker compose exec telemetry node src/cli.mjs rc:projects   # what the key can see
docker compose exec telemetry node src/cli.mjs rc:sync       # link by name
docker compose exec telemetry node src/cli.mjs rc:link braele projabc123
docker compose exec telemetry node src/cli.mjs rc:charts     # which charts this project answers for
docker compose exec telemetry node src/cli.mjs rc:poll       # pull now, print the result
```

Each pull stores the overview metrics (a row only when a number changed) and
the daily series for every chart the project answers for:

```
revenue  customers_active  customers_new  actives  trials
non_subscription_purchases  mrr  churn  initial_conversion
ltv_per_customer  refund_rate
```

Those are chart *names* from the API's own enum, not the dashboard's labels —
`customers_new`, not `new_customers`. A project without subscriptions answers
404 for `mrr` and `trials`; that is remembered in `rc_charts` and asked about
again a week later, so the fleet's next app gets its own list without a code
change. The Apps page draws whatever came back, labelled the way RevenueCat
labels it, and hides a chart that is flat at zero.

Money charts are scaled by what the `revenue` chart taught us: its scale is not
documented upstream, so it is calibrated on every pull against
`/metrics/revenue` for the same window rather than assumed — the difference
between $18 and $1,800 on the dashboard — and the same factor is applied to
`mrr` and `ltv_per_customer`, which have nothing to calibrate against.

Not pulled, and available if wanted: the `*_movement` charts and
`subscription_status` (several series in one), `cohort_explorer`,
`prediction_explorer` and `subscription_retention` (cohort grids), the `ad_*`
family, and the `segment` parameter, which slices any chart by country, store,
product or offering.

A refresh waits at most twelve seconds for RevenueCat. Past that the page is
answered from the cache and the pull keeps going in the background, so a slow
upstream shows stale numbers with a timestamp rather than a hanging dashboard.

## Running it locally

```bash
docker run -d --rm --name tdb -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -e POSTGRES_DB=telemetry -p 127.0.0.1:55432:5432 postgres:16-alpine
npm install
DATABASE_URL=postgresql://test:test@127.0.0.1:55432/telemetry \
  TELEMETRY_ADMIN_TOKEN=dev MAIL_DRY_RUN=1 PORT=3055 npm start
```

Migrations run inside `src/server.mjs` before it listens, so a first boot
against an empty database is the normal path, not a special case.
