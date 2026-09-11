# Telemetry: app analytics, support tickets, and the Apps pages in Cockpit

Status: 2026-09-08 — **phases 1-3 are built** (the service, the SDK and Braele's
events, the Apps and Tickets pages) and phase 4 is built as a *pull*: the Apps
page shows RevenueCat's own numbers, fetched on open and cached (section 8). The
webhook receiver, and with it a transaction list and the `rc_id` funnel join,
is the one piece still outstanding. See [README.md](README.md) for how the
service is operated.

Two deviations from the plan below, both made while writing it: the service
uses `node:http` and hand-rolled validation instead of Fastify + zod, and a
plain `fetch` instead of the Resend SDK — `pg` is the only dependency. And
`docker system prune -f` in every per-app deploy workflow became
`docker image prune -f`: adding a service means more concurrent deploys from
one push, and system prune is what made them fail each other on 2026-09-06.

Source document: Ensar's "Multi-App Analytics Backoffice" plan (2026-08-25).
This spec keeps its decisions (first-party, privacy-first, batched, RevenueCat
as the financial truth, Postgres only) and shrinks the build to what the fleet
needs now: a few hundred installs, well under 200k events a month, one person
reading the dashboard.

## 1. What exists already, and what this reuses

| Need | Already there | Decision |
|---|---|---|
| Dashboard host | `ops.bavrk.com` is Cockpit (`cockpit/`, Fastify + Preact, Cloudflare Access or tailnet guard) | Add two pages to Cockpit: **Apps** and **Tickets**. No new site, no Next.js. |
| Database | shared `bavrk-db` (Postgres 16), `scripts/ensure-app-db.sh` | One new database `telemetry`. No Redis, no queue. |
| Mail | Resend, domain bavrk.com verified (termin sends from `termin@bavrk.com`) | Ticket mail from `Braele Support <support@bavrk.com>`, alerts to Ensar. |
| Shared app code | copy at scaffold time from `app-template/`, drift checked by `scripts/fleet-drift.mjs` | The SDK is one file, `src/lib/telemetry.ts`, added to the `SHARED` list. No npm package. |
| Purchases | react-native-purchases in every SDK 56 app, anonymous app user ids | Keep RevenueCat anonymous. The SDK records RevenueCat's own app user id as a property so webhooks join to installs. Never change `appUserID` on existing installs (it would detach current Pro users until they restore). |
| Deploy | per-app workflow pattern (`deploy-termin.yml`) | `deploy-telemetry.yml`, same shape. |

Dropped from the original plan for now: NestJS, Next.js, Redis/BullMQ,
monthly partitions, rollup tables, RevenueCat Charts API cache, customer
inspector, ClickHouse triggers. Each has a place to go later (section 9).

## 2. Architecture

```
phones ── https://telemetry.bavrk.com/v1/*  (public, Cloudflare proxied)
                     │
                     ▼
              telemetry:3000  (Node 22, Fastify 5, pg)  ──▶  bavrk-db / telemetry
                     ▲
      cockpit:8080 ──┘  /admin/* on the docker network only, bearer token
                     ▲
   ops.bavrk.com ────┘  Cockpit pages: Apps, Tickets (existing guard)
```

The public endpoint lives in its own container because Cockpit holds the
Docker socket and an SSH key; nothing reachable from the internet should run
in that process.

Service: `telemetry/` in this repo. Node 22 alpine, Fastify 5, `pg`, `zod`,
`resend`. SQL migrations as numbered files applied by the entrypoint before
the server starts (same migrate-before-start rule as termin). 128 MB memory
limit. Healthcheck on `/healthz`.

## 3. Identity and privacy

- `installation_id`: random UUID created on first launch, stored in
  AsyncStorage under `bavrk.telemetry.install.v1`. It is the only identifier.
- `session_id`: new UUID on cold start and after 30 minutes in background.
- `rc_id`: RevenueCat's anonymous app user id (`Purchases.getAppUserID()`),
  sent once per session as an identity property. Joins purchases to installs
  without touching RevenueCat identity.
- Never sent: name, email (except when the user types it into a ticket),
  IDFA, IP, precise location, any user content. The server does not store
  the client IP anywhere; Caddy's access log for this host is disabled.
- Country: `CF-IPCountry` header from Cloudflare, stored as a two-letter code
  on the install row only. Rows are never shown per country below 10 installs.
- No consent UI (Ensar's decision, 2026-09-06): everything collected is
  anonymous by construction, so there is nothing to consent to. The privacy
  policy gets one paragraph describing the anonymous usage data. The SDK
  keeps `setEnabled(false)` as a plain API for dev builds and tests only.
- Retention: raw events 180 days (nightly delete inside the service), installs
  and tickets kept.

## 4. Ingestion API (public)

Auth: `Authorization: Key <write key>` per app and environment. Write keys are
rows in the database (hashed), created by a CLI command in the service. Keys
in a mobile bundle are identifiers, not secrets: strict validation, 60
requests per minute per key, 100 events per batch, 64 KB body.

```
POST /v1/events
{ "sent_at": "...", "sdk": "1", "events": [
  { "id": "<uuid>", "name": "breathing_session_completed", "at": "...",
    "install": "<uuid>", "session": "<uuid>", "props": { ... } } ] }
→ 200 { "accepted": 3, "duplicate": 1, "rejected": 0 }
```

Per-batch context (version, build, platform, os, locale, rc_id) is sent once
in the batch header, not per event. `id` is unique in the database, so retries
are safe. Unknown event names are accepted but flagged (`known = false`), so
a new app version can ship events before the catalog is updated; the Apps
page shows unknown names so they get added or removed.

Environment: `dev` keys and `prod` keys; the dashboard shows prod by default.

## 5. Tickets

```
POST /v1/tickets   { install, email?, subject?, message, diag: { version, build, os, device, locale, pro } }
GET  /v1/tickets?install=<uuid>   → the install's tickets with status and replies
POST /v1/tickets/:id/reply   { install, body }   → 201; sets status back to open. 409 once closed.
```

- On a new ticket the service mails Ensar (subject `[braele] #123 …`, the
  message, the diagnostics), via Resend.
- Reply from the Tickets page in Cockpit: stored on the ticket, mailed to the
  user if they left an email, and visible in the app's ticket list either way.
- Status: `open` → `answered` → `closed`. The app shows a small badge on the
  Support row while a ticket has an unread answer.
- The install id is the only credential for reading tickets. It is a random
  UUID that never leaves the device except in these requests, which matches
  the write-key trust level. Nothing sensitive comes back: subject, message,
  replies, status.
- Rate limit: 5 tickets per install per day.

## 6. Mobile SDK: `src/lib/telemetry.ts` (one file, no dependencies beyond AsyncStorage)

```ts
telemetry.init({ app: 'braele', key: TELEMETRY_KEY, url: TELEMETRY_URL, version, build });
telemetry.track('breathing_session_completed', { pattern: 'box', cycles: 4, completed: true });
telemetry.screen('settings');
telemetry.setEnabled(false);      // consent toggle; clears the queue
telemetry.flush();                // best effort, also called on background
telemetry.installId();            // for the support screen
```

Behaviour: queue in AsyncStorage (max 500 events, 7 days), flush at 20 events
or 30 seconds while active and on backgrounding, exponential backoff, never
blocks startup (init is fire-and-forget), `session_started` once per session,
`app_first_opened` once per install. Under 250 lines. Config follows the
`src/constants/live.ts` pattern: `EXPO_PUBLIC_TELEMETRY_URL`, dev key vs prod
key by `__DEV__`.

### Braele event catalog (first version)

| Event | Props |
|---|---|
| `app_first_opened` | – |
| `session_started` | `entry` (`launch`, `widget`, `quick_action`, `siri`, `notification`) |
| `screen_viewed` | `screen` |
| `onboarding_completed` | – |
| `breathing_session_started` | `pattern`, `cycles`, `voice` (on/off), `ambient` |
| `breathing_session_completed` | `pattern`, `cycles_done`, `duration_s`, `completed` (bool), `locked` (bool) |
| `paywall_viewed` | `placement` |
| `purchase_started` | `product` |
| `purchase_result` | `result` (`purchased`, `cancelled`, `error`), `product` |
| `restore_result` | `result` |
| `reminder_set` | `count` |
| `feature_used` | `feature` (`widget_added`, `live_activity`, `health_sync`, `builder`) |
| `ticket_opened` | – |

Financial truth stays with RevenueCat (section 8); `purchase_result` is the
client-side funnel only.

## 7. Cockpit pages

Cockpit gets `TELEMETRY_URL=http://telemetry:3000` and `TELEMETRY_ADMIN_TOKEN`
and proxies `/api/apps/*` and `/api/tickets/*` to the service's `/admin/*`.
Charts are small inline SVG (bars and sparklines); no chart library.

**Apps** (portfolio, then one app):
- Range picker: 7 / 30 / 90 days, environment prod/dev.
- Money block above the table: RevenueCat's overview cards per app, and every
  daily series the project answers for once an app is opened (section 8).
- Portfolio table: app, installs (new / total), DAU / WAU / MAU, sessions,
  sessions per active install, 28-day revenue, open tickets. Trials and paid
  counts live in the cards rather than the table: a lifetime purchase has
  neither, and two zero columns would say less than nothing.
- App page: daily active installs and sessions (bars), version split, top
  events, paywall funnel (`paywall_viewed` → `purchase_started` →
  `purchase_result=purchased` → RC purchase), app-specific block (Braele:
  sessions by pattern, completion rate, voice on/off share, locked share),
  unknown event names, last event received (feeds a "silent app" alert).
- All queries are plain SQL over `events` with `GROUP BY day`; at this
  volume that is milliseconds. Rollups come when they are needed.

**Tickets**: list (open first, app badge, age, has-email), ticket view with
diagnostics, reply box, status buttons. New tickets also appear as a count on
the Overview page.

## 8. RevenueCat (phase 4)

**Built 2026-09-08, pull half only.** The plan below was a webhook receiver;
what shipped is the opposite direction, because the question in front of us was
"what does ops show *today*" and 1.4.0 has not shipped, so the events tables are
empty and RevenueCat is the only real data there is. A webhook only fires on the
next purchase; the v2 read API answers for the last 28 days now.

`telemetry/src/revenuecat.mjs` reads RevenueCat's Charts & Metrics API and
caches the answer in Postgres (`rc_projects`, `rc_overview`, `rc_series`,
migration `003`). Cockpit reads the cache through `/admin/revenue`; nothing
else in the fleet holds the key.

**No poller** (Ensar, 2026-09-08). One person reads this dashboard, so a timer
would spend ninety-odd pulls a day to be ready for the two that get read.
Opening the Apps page refreshes a cache older than `RC_STALE_MINUTES` (10), the
page's refresh button forces one no sooner than `RC_FLOOR_SECONDS` (60), and
concurrent requests share one in-flight pull. A refresh waits at most twelve
seconds: past that the page is answered from the cache while the pull finishes
writing, because a dashboard that hangs on a slow upstream is worse than one
showing an hour-old number next to the time it was fetched.

- **Overview** (`/v2/projects/{id}/metrics/overview`) is the card row on the
  Apps page: revenue and new/active customers over 28 days, active
  subscriptions, active trials, MRR. Stored as RevenueCat returns it —
  `{id, name, unit, period, value}` — so a metric added upstream appears
  without a migration or a UI change.
- **Charts** (`/v2/projects/{id}/charts/{name}`, resolution `day`) give the
  daily series: `revenue`, `customers_active`, `customers_new`,
  `non-subscription_purchases`, `actives`, `trials`, `mrr`, `churn`,
  `initial_conversion`, `conversion_to_paying`, `ltv_per_customer`,
  `refund_rate`. Those are the API's spellings, which are not the dashboard's
  labels and not, for the hyphenated one, what the docs page says; an invalid
  name returns a 400 listing the whole enum. A chart is several series
  (`revenue` also returns Transactions and Ad Impressions), each point is
  `{cohort, measure, value}`, and the `measures` array is stored verbatim so
  the page can label and format from RevenueCat's own metadata. What a project
  answers for is discovered once, remembered in `rc_charts` and rechecked
  weekly. The page draws what came back, hides series flat at zero, and folds
  together the ones that repeat across charts.
- **Money scale.** Whether a series is money is its measure's `unit`, not the
  chart's name. The live project returns whole currency units, but RevenueCat
  does not document that, so the revenue chart is still calibrated against
  `/v2/projects/{id}/metrics/revenue` each pull and the factor it learns scales
  `mrr` and the LTV measures, which have nothing of their own to check against.
- **Rate.** Charts & Metrics allows 25 requests a minute and a full pull is a
  dozen-odd, so the client holds a sliding window (20/min) and the refresh
  floor is a minute. Waiting is safe because every caller has a budget.
- **Linking**: projects are matched to apps by name, overridable with
  `RC_PROJECTS` or `cli.mjs rc:link`. An unmatched project is left alone rather
  than guessed at — a wrong link puts another app's money on this app's page.
- The key is a v2 *secret* key (`charts_metrics:*:read`,
  `project_configuration:projects:read`). It never reaches a phone or a
  browser, and the service is the only caller — Charts & Metrics allows 25
  requests a minute, which a page fetching directly would exhaust.

Still not built, and still worth building: the webhook receiver
`POST /v1/rc/<app>`, raw events by RC event id, for the two things a pull
cannot give — a transaction list, and the `rc_id` join that turns the
client-side paywall funnel into a real one. Needs confirmation that the current
plan offers webhooks (the dashboard's Integrations page shows it).

## 9. Growth path (not built now)

Monthly partitions and daily rollups when events pass ~10 M; RevenueCat
Charts cache when revenue views are needed in Cockpit; customer inspector with
audit log when support needs it; Mindsaid joins when it moves to the template.

## 10. Build order and effort

1. **Service + deploy** (this repo): schema, `/v1/events`, `/v1/tickets`,
   `/admin/*`, write-key CLI, Resend mail, `deploy-telemetry.yml`, compose,
   Caddy `telemetry.bavrk.com`, DNS. About one session. Verified with curl.
2. **SDK + Braele** (bavrk-apps): `src/lib/telemetry.ts` in `app-template/`
   and braele, Braele events wired, Support screen (form + ticket list)
   reachable from Settings, i18n in six languages, privacy policy paragraph
   (bavrk.com repo, owned by the other session, so a note for it). About one
   session. Ships as Braele 1.4.0; 1.3.0 (build 9) is already in review.
3. **Cockpit pages**: Apps and Tickets. About one session.
4. **RevenueCat**: (done) the pull, cached and on the Apps page. The webhook
   receiver is half a session once plan support is confirmed.

Order 1 → 2 → 3 lets the first real Braele data land before the pages are
drawn against it. Each step is its own PR.

## 11. Decisions

1. (built) Public host `telemetry.bavrk.com`, Cloudflare-proxied so `CF-IPCountry` exists; no Caddy access log for that host.
2. (decided) No consent UI; anonymous by construction, policy paragraph only.
3. (built) Support mail sender `support@bavrk.com`, replies mailed to the user when they gave an email, new tickets mailed to Ensar with the diagnostics.
4. (built) Raw event retention 180 days, swept in-process every six hours.
5. (built) RevenueCat is read from the v2 API on demand, not by webhook: it answers
   for the 28 days that already happened, which is what an empty telemetry
   database needs. Webhooks stay open for the transaction list and the funnel
   join; confirm availability on the current plan first.
6. (done) 1.3.0 build 9 submitted 2026-09-06; app work targets 1.4.0.
