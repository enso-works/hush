# hush

In-app feedback and anonymous usage tracking for mobile apps. One small
container, Postgres, a one-file SDK and a dashboard.

Built for our own apps ([bavrk](https://bavrk.com): Braele and friends), where
it runs in production. It is public so you can read it, fork it or run it
yourself; it is not a product, and there is no support beyond what the code
and this page say. MIT.

- **Feedback**: users write from inside the app (a problem, an idea, or kind
  words). You answer on the dashboard, and by email if they left an address;
  they read your reply in the app and can answer back.
- **Anonymous tracking**: installs, sessions, screens, a paywall funnel,
  retention, versions, and your own events with props. No account, no
  advertising id, no IP address, so nothing to ask consent for.
- **Revenue** (optional): RevenueCat's own figures next to your usage.

## Run it

```bash
git clone https://github.com/enso-works/hush && cd hush/examples
cp .env.example .env            # set ADMIN_TOKEN and POSTGRES_PASSWORD
docker compose up -d            # http://localhost:3000

docker compose exec hush node src/cli.mjs apps:add myapp "My App"
docker compose exec hush node src/cli.mjs keys:create myapp prod   # prints the write key once
```

Dashboard: `http://localhost:3000/dashboard/`, signed in with `ADMIN_TOKEN`.

In the app, copy [`sdk/src/index.ts`](sdk/src/index.ts) in (Expo / React
Native, one file; [SDK guide](sdk/README.md)):

```ts
import * as hush from './hush';

hush.configure({ url: 'https://hush.example.com', key: 'hush_myapp_prod_…' });
hush.init();
hush.screen('Home');
hush.track('workout_completed', { minutes: 20, completed: true });
await hush.createTicket({ kind: 'issue', message: 'The timer stops on lock' });
```

Before pointing real apps at it: put it behind a TLS proxy, expose only
`/v1/*` and `/healthz` publicly, keep `/dashboard/` and `/admin/*` behind a VPN
or an access proxy (the token is the second lock, not the only one), and back
up Postgres; it is the only state.

## What is collected

- **An install id**: a random UUID the app creates on first launch. Deleting
  the app deletes it. It is the only identifier.
- **The app version and build, OS, device model, the phone's language**, and
  the events and props your app sends. Keep props to what the app did, not
  who did it.
- **Country**, only if you set `COUNTRY_HEADER` behind a proxy that provides a
  trusted one. The dashboard folds any country under ten installs into
  "other".
- **An email address**, only when a user types one into feedback.
- **No IP address**, anywhere. Rate limits count a salted hash that lives in
  memory only.

Raw events are deleted after `RETENTION_DAYS` (180); install rows and
feedback threads are kept. The write key ships inside the app, so it is not a
secret: it identifies the app, can be revoked, and can read nothing but the
calling install's own feedback.

## Configuration

Only `DATABASE_URL` and `ADMIN_TOKEN` are required.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres. Migrations run at every boot, before listening. |
| `ADMIN_TOKEN` | Guards `/admin/*` and the dashboard's data. `openssl rand -hex 32`. |
| `APPS` | Register apps at boot: `myapp=My App,other=Other`. |
| `CATALOG_FILE` | Each app's known events and its highlight metric, as JSON (below). |
| `CLIENT_IP_HEADER` | Header a trusted proxy sets with the caller's address (`cf-connecting-ip`, `x-forwarded-for`), for rate limits. Unset: the socket address. |
| `COUNTRY_HEADER` | Header a trusted proxy sets with a two-letter country (`cf-ipcountry`). Unset: no country. |
| `RESEND_API_KEY`, `MAIL_FROM` | Email through [Resend](https://resend.com): feedback alerts, and your replies to users who left an address. |
| `ALERT_EMAIL`, `REPLY_HINT` | Where new feedback is announced (at most 30 an hour), and a last line saying where to answer. |
| `RETENTION_DAYS` | Default 180. |
| `RC_API_KEY`, `RC_PROJECTS`, `RC_CURRENCY` | RevenueCat v2 secret key with read-only scopes; see `src/revenuecat.mjs`. |
| `PORT`, `MAIL_DRY_RUN` | `3000`; `1` logs mail instead of sending it. |

The catalog names the events you expect (anything else is still stored,
flagged as unknown on the dashboard) and one highlight: the event counted
per period, and the prop that marks it done.

```json
{ "myapp": { "events": ["workout_completed"], "highlight": { "event": "workout_completed", "done_prop": "completed" } } }
```

## API

Apps send `Authorization: Key <write key>`; the SDK does this for you.

| | |
|---|---|
| `POST /v1/events` | up to 100 events. 200 `{ accepted, duplicate, rejected }`. Any 4xx but 429 means never: drop the batch. 429 and 5xx: retry. |
| `POST /v1/tickets` | feedback: `{ install, kind: issue\|feature\|love, message, email?, subject? }` → 201. Five a day per install. |
| `GET /v1/tickets?install=` | that install's feedback, with replies and `unread` |
| `POST /v1/tickets/:id/reply` | `{ install, body }` → 201, or 409 once closed |

The operator side, `Authorization: Bearer <ADMIN_TOKEN>`, is what the
dashboard reads: `/admin/apps`, `/admin/apps/:app`, `/admin/tickets`,
`/admin/tickets/:id` (+ `/reply`, `/status`), `/admin/revenue`. CLI:
`node src/cli.mjs apps:add | keys:create | keys:list | keys:revoke | rc:* | migrate`.

Limits are honest about what this is: rate limits are in memory, per
process, and reset on restart. One instance is plenty for small apps.

## Working on it

`npm test` runs the real server against a real Postgres
([CONTRIBUTING.md](CONTRIBUTING.md)). The `/v1` responses are frozen in a
snapshot taken from the server our shipped apps talk to: apps in users'
hands cannot be redeployed, so a change there is a breaking change.
