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
