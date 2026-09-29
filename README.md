# hush

Anonymous analytics and in-app support for small mobile apps, self-hosted.

One small Node container and Postgres. Your app sends events and support
tickets with a one-file SDK; you read them on a dashboard the same container
serves. Nothing personal is collected, so there is nothing to ask consent
for: no account, no advertising id, no IP address, no fingerprint.

- **Events**: installs, sessions, screens, a paywall funnel, retention,
  versions, and whatever your app tracks, with props.
- **Support tickets**: users write from inside the app, you answer on the
  dashboard (and by email if they left one), they read your reply in the app
  and can answer back.
- **Revenue** (optional): RevenueCat's own numbers next to your usage, pulled
  by the server with a read-only key.

Node 22, one runtime dependency (`pg`), about 2,200 lines you can read in an
afternoon. MIT.

## Quickstart (five minutes)

```bash
git clone https://github.com/enso-works/hush && cd hush/examples
cp .env.example .env            # set ADMIN_TOKEN and POSTGRES_PASSWORD
docker compose up -d            # hush on http://localhost:3000, Postgres beside it

# register your app and mint a write key for it (printed once)
docker compose exec hush node src/cli.mjs apps:add myapp "My App"
docker compose exec hush node src/cli.mjs keys:create myapp prod
```

Open `http://localhost:3000/dashboard/` and sign in with your `ADMIN_TOKEN`.

In the app (Expo / React Native), copy [`sdk/src/index.ts`](sdk/src/index.ts)
in (it is one file; the npm package is not published yet) and:

```ts
import * as hush from './hush';

hush.configure({ url: 'https://hush.example.com', key: 'hush_myapp_prod_…' });
hush.init();                                  // once, at startup; never throws
hush.screen('Home');
hush.track('workout_completed', { minutes: 20, completed: true });
hush.identify({ pro: true });                 // paid or not, if you know
await hush.createTicket({ kind: 'issue', message: 'The timer stops on lock', email: 'optional@example.com' });
```

A full example, with the background-flush hook and the ticket screens'
calls: [`examples/expo/hush-setup.ts`](examples/expo/hush-setup.ts). The SDK:
[`sdk/README.md`](sdk/README.md).

## Privacy model

- **The only identifier is an install id**, a random UUID the app creates on
  first launch and keeps in its own storage. Deleting the app deletes it.
- **No IP address is stored**, anywhere. The rate limiter counts requests by
  a salted hash of the address that lives only in memory and dies with the
  process. Do not put an access log in front that records addresses.
- **Country is optional.** With `COUNTRY_HEADER` set (behind a proxy that
  sets a trusted two-letter country header) it is kept on the install row
  only; the dashboard folds any country under ten installs into "other".
  Unset, no country is stored.
- **An email address exists only when a user typed one** into a ticket, so
  you can answer them.
- **Raw events are deleted** after `RETENTION_DAYS` (180). Install rows
  (counters) and tickets (conversations) are kept.
- **The write key is not a secret.** It ships inside your app, so anyone can
  read it out. It identifies the app and can be revoked; it cannot read
  anything but the calling install's own tickets.

Write your privacy policy from that list. If you add props that describe a
person, the list stops being true: keep props to what the app did, not who
did it.

## Configuration

Environment variables. Only `DATABASE_URL` and `ADMIN_TOKEN` are required.

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres connection string. Migrations run at every boot, before the server listens. |
| `ADMIN_TOKEN` | – | Guards `/admin/*` and the dashboard's data. Long and random: `openssl rand -hex 32`. |
| `PORT` | `3000` | |
| `APPS` | – | Apps to register at boot: `myapp=My App,other=Other`. Existing apps are left as they are. |
| `CATALOG_FILE` | – | Path to a JSON file naming each app's events and its highlight metric (below). |
| `CLIENT_IP_HEADER` | – | The header a trusted proxy puts the caller's address in (`cf-connecting-ip`, `x-forwarded-for`), for the rate limits. Unset: the socket address. Never name a header your proxy does not overwrite. |
| `COUNTRY_HEADER` | – | The header a trusted proxy puts the caller's two-letter country in (`cf-ipcountry`). Unset: no country. |
| `RESEND_API_KEY` | – | Ticket email through [Resend](https://resend.com). Unset: tickets are stored and shown, nothing is mailed. |
| `MAIL_FROM` | – | Sender, on a domain verified in Resend: `Support <support@example.com>`. |
| `ALERT_EMAIL` | – | Where new tickets and user replies are announced. At most 30 alerts an hour. |
| `REPLY_HINT` | – | A line at the end of each alert, e.g. your dashboard's URL. |
| `MAIL_DRY_RUN` | – | `1` logs mail instead of sending it. |
| `RETENTION_DAYS` | `180` | Raw events older than this are deleted. |
| `RC_API_KEY` | – | RevenueCat v2 **secret** key, read-only scopes (see RevenueCat below). |
| `RC_PROJECTS` | – | `myapp=projabc`, only when a project's name is neither the app's slug nor its name. |
| `RC_CURRENCY` | `USD` | What RevenueCat converts money to. |
| `RC_STALE_MINUTES` | `10` | Opening the dashboard refreshes a revenue cache older than this. |
| `RC_FLOOR_SECONDS` | `60` | How soon a forced refresh may ask again. |
| `RC_RATE_PER_MINUTE` | `20` | RevenueCat allows 25. |

### The event catalog

Every app knows the common names (`app_first_opened`, `session_started`,
`screen_viewed`, `paywall_viewed`, `purchase_started`, `purchase_result`,
`restore_result`, `ticket_opened`). `CATALOG_FILE` adds each app's own, and
names its **highlight**: the one event the dashboard counts per period, and
the boolean prop that marks it done (shown as a completion rate).

```json
{
  "myapp": {
    "events": ["workout_started", "workout_completed"],
    "highlight": { "event": "workout_completed", "done_prop": "completed" }
  }
}
```

Unknown names are still stored, never dropped (a shipped app must not lose
data because the server is behind); the dashboard flags them so you can fix
the typo or add the name.

## Deploying

`examples/docker-compose.yml` is the whole thing. Put it behind a reverse
proxy that terminates TLS, and:

- expose `/v1/*` and `/healthz` to the internet (the apps);
- expose `/dashboard/` and `/admin/*` only as far as you need to: a VPN, an
  IP allowlist or an access proxy in front, with `ADMIN_TOKEN` as the second
  lock rather than the only one;
- set `CLIENT_IP_HEADER` (and `COUNTRY_HEADER`, if you want countries) to what
  your proxy sets, or leave them unset;
- back up the Postgres database. It is the only state.

**Limits, stated plainly.** Rate limits (120 requests a minute per address on
`/v1`, 60 event batches, 10 ticket writes, 5 tickets a day per install) are
in memory and per process: they reset on restart and do not add up across
replicas. A public ingest endpoint will be probed; the limits make that
cheap for you, not impossible for them. One instance handles small apps
comfortably; if you need more than one, put a shared limiter in front.

## API

Apps (the SDK does this for you): `Authorization: Key <write key>`.

| | |
|---|---|
| `POST /v1/events` | `{ context, events: [{ id, name, at, session, install, props }] }`, up to 100 events. 200 `{ accepted, duplicate, rejected }`: a retried batch is counted, not stored twice; malformed events are dropped, the rest land. 4xx (except 429) means the batch will never be accepted: drop it. 429 and 5xx: retry later. |
| `POST /v1/tickets` | `{ install, kind: issue\|feature\|love, message, email?, subject?, diag?, rc_id? }` → 201 `{ id, created_at, status }`. 429 past five a day per install. |
| `GET /v1/tickets?install=` | `{ tickets: [...] }` with replies and an `unread` flag, only the calling app's. |
| `POST /v1/tickets/:id/reply` | `{ install, body }` → 201; 409 once closed. |
| `GET /healthz` | `{ ok, db }` |

Operator: `Authorization: Bearer <ADMIN_TOKEN>`. The dashboard uses exactly
these.

| | |
|---|---|
| `GET /admin/apps?days=&env=` | every app with its counters |
| `GET /admin/apps/:app?days=&env=` | one app: current and prior period, daily series, versions, events, funnel, retention, countries |
| `GET /admin/apps/:app/breakdown?event=&prop=` | one event sliced by one prop |
| `GET /admin/revenue?app=&days=&refresh=1` | RevenueCat cache, refreshed when stale |
| `GET /admin/tickets?status=&kind=`, `GET /admin/tickets/:id` | the inbox, one thread |
| `POST /admin/tickets/:id/reply` | `{ body, close? }`; emailed to the user if they left an address |
| `POST /admin/tickets/:id/status` | `{ status: open\|answered\|closed }` |

## CLI

```bash
node src/cli.mjs apps:list | apps:add <slug> <name>
node src/cli.mjs keys:create <app> <prod|dev> [label] | keys:list | keys:revoke <id>
node src/cli.mjs rc:projects | rc:sync | rc:link <app> <project> | rc:charts | rc:poll
node src/cli.mjs migrate
```

`dev` and `prod` keys are separate; the dashboard shows either. Only a key's
SHA-256 is stored, so a lost key is revoked and replaced, never recovered.

## RevenueCat

With `RC_API_KEY` set, the dashboard shows RevenueCat's own figures for each
linked app. The server is the only thing that calls RevenueCat, never a
browser: it pulls on demand when someone opens the page and the cache is
older than `RC_STALE_MINUTES`, caches in Postgres, and shares one in-flight
pull between concurrent requests. There is no poller.

Create the key under Project settings → API keys → v2 secret key, with
`charts_metrics:overview:read`, `charts_metrics:charts:read` and
`project_configuration:projects:read`. It can read customer data, so it is a
real secret. Projects are linked to apps by name automatically
(`rc:sync`), or by hand (`rc:link`).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). The test suite runs the real server
against a real Postgres, and freezes the `/v1` contract apps are built
against: a change there breaks apps already in users' hands.

## License

MIT. See [LICENSE](LICENSE).
