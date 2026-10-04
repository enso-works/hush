## Run it

You need Docker. hush is one container and a Postgres database beside it.

```bash
git clone https://github.com/enso-works/hush && cd hush/examples
cp .env.example .env            # set ADMIN_TOKEN and POSTGRES_PASSWORD
docker compose up -d            # http://localhost:3000
```

Register your app and mint its write keys: `prod` for release builds, `dev`
for development. Each key is printed once; only its hash is stored.

```bash
docker compose exec hush node src/cli.mjs apps:add myapp "My App"
docker compose exec hush node src/cli.mjs keys:create myapp prod
docker compose exec hush node src/cli.mjs keys:create myapp dev
```

Open `http://localhost:3000/dashboard/` and sign in with your `ADMIN_TOKEN`.
It looks like [the live demo](/demo/dashboard/), with your data instead of
invented apps.

## Wire the SDK

The SDK is [`@bavrk/hush`](https://www.npmjs.com/package/@bavrk/hush) on npm,
for Expo, React Native and the web (below). An AI coding agent can do this
part for you: see [With an AI coding agent](#with-an-ai-coding-agent). This
page is for `@bavrk/hush` 2.3.0 and `@bavrk/hush-expo` 0.1.3; where older
versions behave differently, it says so. 2.3.0 keeps a ticket sent with an
email apart from the install, and needs a server with migration 007 for it:
update the server before the app ([Feedback](#feedback)).

```sh
npx expo install @bavrk/hush @react-native-async-storage/async-storage expo-constants expo-device expo-localization
```

The SDK's peer dependencies are marked optional, so npm does not add them:
install them yourself, as above. In a bare React Native app (0.73 or later), run
`npx install-expo-modules@latest` first and `npx pod-install` after, then
rebuild.

In one module the app imports first, say `src/lib/hush.ts`:

```ts
import * as hush from '@bavrk/hush';

hush.configure({
  url: 'https://hush.example.com',
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : 'hush_myapp_prod_…',
});
export const hushReady = hush.init(); // at startup; never throws
export * from '@bavrk/hush';
```

Release builds carry the prod key in code. In development the dev key comes
from the app's `.env` as `EXPO_PUBLIC_HUSH_KEY`, and its data shows only under
the dashboard's dev switch. With no key the SDK stays off. `configure()` never
throws: a missing or non-string `url` or `key` (an environment variable unset
in one build profile, say) turns the SDK off the same way, and
`logLevel: 'error'` says why. Give such a variable a fallback so release builds
stay on: `process.env.EXPO_PUBLIC_HUSH_URL ?? 'https://…'`.

Call `configure()` first: the SDK is off until it runs, and events tracked
before it are dropped. After it, the order of calls does not matter. Events
tracked before `init()` resolves belong to the launch's session and join the
queue the last launch left. An `entry()` made before the session exists is
held for it. Until `identify({ pro })` runs, batches carry no paid flag, and
the server keeps the one it has.

On SDK 2.2.1 and older, upgrade. Until then these workarounds apply:

- Call `init()` right after `configure()`, before any `track()`. An event
  tracked more than about a second before `init()` resolves overwrites the
  queue the last launch left unsent.
- Call `entry()` only after `init()` has resolved, within 2.5 seconds
  (`await hushReady`); earlier it does nothing. A link that brings the app
  back can arrive before the new session exists: hold it and call `entry()`
  again on the next `active`.
- Call `identify({ pro })` as early as you can on every launch. Until it runs,
  batches say `pro: false`, which marks a paid install unpaid.
- Pass `url` as a string and props as an object: `configure()` throws on an
  undefined `url`, and `track()` on `null` props.

Then, anywhere in the app:

```ts
hush.screen('Settings');
hush.track('workout_completed', { minutes: 20, completed: true });
hush.identify({ pro: true, rcId: customerInfo.originalAppUserId });
```

- Event names are `snake_case`; props are one flat level of strings, numbers,
  booleans or null.
- An invalid name, or a prop value that is not flat (an object, an array, a
  press event), drops the event on the device, since the server would reject
  it anyway; a global prop like that is not set, and `logLevel: 'error'` says
  so. A `Date` is sent as its ISO string, and `null` props are no props.
- `app_first_opened` and `session_started` are sent for you. A session ends
  after 30 minutes in the background.
- Events queue on the device (500, up to 7 days), go out in batches of 20,
  every 30 seconds, a few seconds after something happens, and when the app
  goes to the background.
- The write key ships inside the app, so it is not a secret: it identifies the
  app, can be revoked, and can read nothing but the calling install's own
  feedback, or a ticket whose key the caller holds.

### Context, milestones and links

```ts
hush.setGlobalProps({ paywall_variant: 'b' });          // joins every event; the event's own props win
hush.track('onboarding_completed', {}, { once: true }); // at most once per install, across launches
hush.entry('link', { url });                            // how the session began: keeps utm_* and ref, never the URL
```

Call `entry()` as soon as the app has the link: the URL from
`Linking.getInitialURL()` or the `url` event, or `'notification'` for the
notification that opened the app. It claims the session that has just
started, for 2.5 seconds after its start. Made before the session exists, it
waits for it, so a link that brings the app back counts too. A tap inside a
running session is not its entry, and is ignored.

Every `session_started` carries its number (`n`) and the previous session's
seconds in the foreground (`prev_fg_s`). The dashboard turns them into
session length and sessions per install; the Explore panel breaks any event
down by any prop, so a global `paywall_variant` becomes an A/B comparison.

### The user's choices

```ts
hush.optOut();                  // remembered: nothing is queued or sent until optIn()
const r = await hush.forget();  // "delete my data": this install's data on the server, and its tickets sent with an email
```

Neither is required, since nothing personal is collected, but both fit in a
Settings screen. `forget()` deletes the install's events, feedback and row,
and the tickets sent with an email whose keys are on the device
([Feedback](#feedback)). Then the SDK carries on with a new install id,
without counting a new install; a batch already on its way lands before the
delete. It cannot reach a ticket sent with an email by a build before 2.3.0
once the server has unlinked it, nor one whose key went with a reinstall:
you delete those on the dashboard (Delete on the ticket), on request. So have
the app's "delete my data" text give your support address for messages sent
with an email. A choice made at startup, before `init()` has read storage,
wins over the stored one.

### Feedback

```ts
const r = await hush.createTicket({ kind: 'issue', message, email, subject });
// r.ok and r.id, or r.error: 'offline' | 'too_many' | 'failed' | 'unavailable'

const tickets = await hush.listTickets();       // with replies and `unread`
await hush.replyToTicket(ticket.id, 'Thanks!'); // error 'closed' once closed
```

`kind` is `issue`, `feature` or `love`. A user can send five a day. Your
replies from the dashboard appear in `listTickets()`, flagged `unread` once,
and are emailed to the user if they left an address. `listTickets()` marks
every reply read as it fetches, so for an unread badge at launch keep your
own seen list.

An email is contact info, and the install id ties a person to everything
their app sends. So from 2.3.0 a ticket with an email is kept apart from the
install:

| | Without an email | With an email (2.3.0 and later) |
|---|---|---|
| Message, kind, subject | yes | yes |
| App version, build, OS, device model, paid flag | yes | yes |
| Install id | yes | no: a thread key for that ticket instead |
| RevenueCat's customer id | when the app has passed one | no |
| Email | no | yes |
| `ticket_opened` and `ticket_replied` events | yes | no |
| When the app last fetched it | yes | no: only which reply it has shown |

- **Thread keys.** For a ticket with an email the server answers with a key
  to that one ticket and keeps only its hash. The SDK stores the key on the
  device (`<prefix>.threads.v1`) and uses it to list the ticket, reply on it
  and delete it, so your reply shows in the app as well as by email.
  Deleting the app, or a new `storagePrefix`, loses the keys and with them
  the app's view of those threads; your reply still reaches the person by
  email.
- **Listing.** `listTickets()` asks for the install's tickets by its id with
  `POST /v1/tickets/list`, which keeps the id out of every URL and access
  log, and for the others by their keys with `POST /v1/tickets/threads`
  (the newest 50). It merges them, newest first. No request carries the
  install id and a key together.
- **Without an email** nothing changes: the install id is how your answer
  gets back to the user, and the ticket carries nothing that says who they
  are.
- **The daily five** count by caller address for a ticket with an email,
  since there is no install to count by. Behind a proxy that needs
  `CLIENT_IP_HEADER` ([Configure it](#configure-it)), or all your users share
  one count.

**The server.** 2.3.0 needs a hush server with migration
`007_unlinked_tickets.sql` (October 2026), which adds `POST /v1/tickets/list`
and `POST /v1/tickets/threads`. An older server refuses a ticket with an
email and no install, so `createTicket` returns `failed`, and the SDK does
not fall back to sending the install. Update the server before the app.

**Builds on 2.2.x or older** still send the install id and RevenueCat's id
with an email, and track `ticket_opened` and `ticket_replied` with it. A
current server drops RevenueCat's id at once and keeps the install id only so
that app's inbox can list the ticket. It clears it once the ticket is closed
and the app has fetched it since (or 7 days after it closed), or after 30
days without activity, and with it deletes that install's ticket events since
the ticket was opened. Until then that ticket is linked to that install. The
dashboard never shows an install on a ticket with an email.

### Options

| Option | |
|---|---|
| `url` | the hush server. Missing or not a string turns the SDK off (2.2.1 and older throw), so give an environment variable a fallback. |
| `key` | a write key; empty or missing turns the SDK off |
| `storagePrefix` | storage key prefix (AsyncStorage, or localStorage on the web), default `hush`. Changing it gives every install a new id and forgets the user's opt-out and the keys of tickets sent with an email. |
| `runInBackground` | wraps the flush when the app goes to the background, e.g. in a native background task |
| `channel` | the build's source: `app_store`, `testflight`, `play`... Pass it per build profile; the dashboard filters by it, so TestFlight stays out of store numbers. `dev` in `__DEV__` builds by default. |
| `logLevel` | `silent` (default), `error` (mistakes such as an invalid event name, a nested prop or a missing `url`) or `debug` (every send) |
| `onFlush` | called after every send with `{ status, accepted, duplicate, rejected, willRetry }` |
| `attribution` | a native bridge for Apple's ad attribution, from `@bavrk/hush-expo` (below) |

### On the web, and in Capacitor

`@bavrk/hush/web` is the same SDK for a page, a PWA or a Capacitor app:
localStorage, the page hiding as leaving the app, the device read coarsely
from the user agent. A page has no version of its own, so pass it, and say
when it is a development build so those page loads count under `dev`. With
Vite:

```ts
import { createWebHush } from '@bavrk/hush/web';

export const hush = createWebHush({ version: '1.4.0', build: '42', dev: import.meta.env.DEV });
hush.configure({
  url: 'https://hush.example.com',
  key: import.meta.env.DEV ? (import.meta.env.VITE_HUSH_KEY ?? '') : 'hush_mygame_prod_…',
});
export const hushReady = hush.init();
// An ad's utm_* tags join the first session. 2.2.1 and older: call it in init().then().
if (/[?&](utm_[a-z]+|ref)=/.test(location.search)) hush.entry('link', { url: location.href });
```

`npm install @bavrk/hush` is all it needs; the web entry has no peers. In
TypeScript, set `moduleResolution` to `bundler`, `node16` or `nodenext` so the
`/web` types resolve. Never import the default `@bavrk/hush` in a browser:
that is the React Native entry. In Capacitor, pass
`platform: Capacitor.getPlatform()` to `createWebHush()`.

### The native side: @bavrk/hush-expo

What JavaScript cannot do on iOS: Apple's ad attribution, whether the build
came from TestFlight or the App Store, and background time for the last send.
It needs a development build, not Expo Go. Install it with the SDK and its
peers:

```sh
npx expo install @bavrk/hush @bavrk/hush-expo @react-native-async-storage/async-storage expo-constants expo-device expo-localization
```

Its only peer is `expo`, like Expo's own modules: `expo-modules-core` comes
with it, so do not install that directly. (0.1.2 and older listed it, and
`npx expo-doctor` reported it as a missing peer.)

```ts
import * as hushExpo from '@bavrk/hush-expo';

hush.configure({
  url, key,
  channel: hushExpo.channel() ?? process.env.EXPO_PUBLIC_HUSH_CHANNEL,
  attribution: hushExpo.attribution,     // Apple's conversion values
  runInBackground: hushExpo.runInBackground,
});
```

`channel()` returns `testflight` or `app_store`, as iOS reports it. On
Android, and for development, ad hoc and EAS internal iOS builds, it returns
`undefined`, so set `EXPO_PUBLIC_HUSH_CHANNEL` in each non-development EAS
profile (preview: `internal`, production: `play`). Leave it unset in
development, so the SDK sends `dev`. Without it the other builds show as
`unknown`. On Android, on the web and in Expo Go every hush-expo function is
a quiet no-op.

In `app.json`:

```json
{
  "expo": {
    "plugins": [
      ["@bavrk/hush-expo", { "attributionEndpoint": "https://example.com" }]
    ]
  }
}
```

`attributionEndpoint` is where iOS sends copies of the attribution postbacks:
`https://` and a host only, with no path, port or trailing slash, or
`expo prebuild` fails. Rebuild the app after changing it.

The pod needs an iOS deployment target of 16.4. Expo SDK 56 and later have it
by default. On Expo SDK 52 to 55, run `npx expo install expo-build-properties`
and add `["expo-build-properties", { "ios": { "deploymentTarget": "16.4" } }]`
to those plugins, or `pod install` fails.

For a debug screen, `await hush.getInstallationId()` gives the id to paste
into the dashboard's Installs page, which shows that install's events as they
arrive.

## Configure it

Only `DATABASE_URL` and `ADMIN_TOKEN` are required.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres. Migrations run at every boot, before listening. |
| `ADMIN_TOKEN` | Guards `/admin/*` and the dashboard's data. `openssl rand -hex 32`. |
| `APPS` | Register apps at boot: `myapp=My App,other=Other`. |
| `CATALOG_FILE` | Each app's known events, highlight metric, funnels, pinned charts, private screens and conversion values, as JSON. |
| `CLIENT_IP_HEADER` | Header a trusted proxy sets with the caller's address (`cf-connecting-ip`, `x-forwarded-for`), for rate limits. Unset: the socket address. Behind a proxy, set it: otherwise every caller has the proxy's address and shares its limits, and an app takes five tickets with an email a day from all its users together. The server warns once when a request comes from a private address and it is unset. |
| `COUNTRY_HEADER` | Header a trusted proxy sets with a two-letter country. Unset: no country. |
| `RESEND_API_KEY`, `MAIL_FROM` | Email through Resend: feedback alerts, and replies to users who left an address. |
| `ALERT_EMAIL`, `REPLY_HINT` | Where new feedback is announced (at most 30 an hour), and a line saying where to answer. |
| `RETENTION_DAYS` | Raw events older than this are deleted. Default 180. |
| `INSTALL_RETENTION_DAYS` | An install's row is deleted once it has sent nothing for this many days. Default `RETENTION_DAYS`, when its events are gone too; 0 keeps every row. Shorter than `RETENTION_DAYS`, the row goes while its events stay, and the server warns at boot. Its tickets keep the install id. The dashboard's install total and Countries panel then count the installs seen in that window, and new installs and retention over a longer period (the 1y view) count only the installs first seen inside it, and say so. |
| `RC_API_KEY` | RevenueCat v2 secret key with read-only scopes, for revenue on the dashboard. |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | An App Store Connect API key, for App Store campaign reports. The Admin role once; Sales and Reports after. Or `ASC_PRIVATE_KEY_FILE`, a path inside the container, in place of `ASC_PRIVATE_KEY`. |
| `ADMIN_PROXY_HEADER`, `ADMIN_PROXY_SECRET` | A header and secret a trusted proxy sets instead of the token, so the dashboard opens signed in on a private network. |

### The event catalog

The catalog names the events you expect. Anything else is still stored,
never dropped, and flagged as unknown on the dashboard so you can fix the
typo or add the name. It also names one **highlight**: the event the
dashboard counts per period, and the boolean prop that marks it done.

```json
{
  "myapp": {
    "events": ["onboarding_completed", "workout_started", "workout_completed"],
    "highlight": { "event": "workout_completed", "done_prop": "completed" },
    "funnels": [
      { "name": "First workout", "steps": ["app_first_opened", "onboarding_completed", "workout_completed"] },
      { "name": "Paywall", "window_days": 3, "steps": ["paywall_viewed", "purchase_started",
        { "event": "purchase_result", "where": { "result": "purchased" }, "label": "Purchased" }] }
    ]
  }
}
```

Funnels are ordered: each step must follow the one before, within
`window_days` (default 7) of the first, and a step can match props with
`where`. The dashboard shows each with its conversion and the median time
between steps; an app with none gets a paywall funnel, and any funnel can be
built on the dashboard without editing the catalog. Beside them, a weekly
cohort table shows how many of each week's new installs are still around.

`breakdowns` pin charts to the app's page (one event by one prop),
`private_screens` are screens the server never stores, and `app_store_id` and
`conversion_values` are for where installs come from:

```json
"breakdowns": [{ "event": "workout_completed", "prop": "kind", "title": "Workouts by kind" }],
"private_screens": ["support", "feedback"],
"app_store_id": "1234567890",
"conversion_values": [
  { "value": 1, "coarse": "low", "event": "onboarding_completed", "label": "Onboarded" },
  { "value": 63, "coarse": "high", "event": "purchase_result", "where": { "result": "purchased" }, "label": "Purchased", "lock": true }
]
```

`private_screens` take the names the app gives `screen()`. A `screen_viewed`
naming one, or a screen under one (`support/42` under `support`), in any prop
is accepted and discarded, any other event loses a prop that names one, and
views stored before are deleted at boot and in the six-hourly sweep. Names
match exactly, case included. List the feedback and inbox screens there
([App Privacy answers](#app-privacy-answers)). The catalog is read once at
boot and a mistake in it stops the boot; a key the server does not read,
misspelt or from a later version, is ignored with a warning in the log.

## Where installs come from

Three ways, all in aggregate. Nothing fingerprints anyone, reads an
advertising id, or needs an App Tracking Transparency prompt.

**Link tags.** Give an ad's URL tags, and pass the link to
`entry('link', { url })`. For Meta, in the ad's URL parameters:

```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}
```

The Campaigns panel counts each install once, for its first tagged session,
split by source, campaign, ad set or ad, and follows it through any funnel:
installs, then onboarding, first session, purchase. On the web the link opens
the product itself, so that is the whole path from the ad. On iOS a link only
opens an app someone already has; new installs are Apple's to count:

**App Store campaigns.** Links to the App Store with a campaign token
(`apps.apple.com/app/id…?pt=…&ct=autumn`) are counted by App Store Connect:
views, first downloads, sessions and proceeds. With an API key and the app's
`app_store_id`, hush imports those reports every six hours. Apple leaves out
anything under five users and adds noise, as it should.

**Ad attribution.** For an install ad, Apple tells the ad network which
campaign won, with a conversion value the app sets. Your catalog's
`conversion_values` are those milestones: `@bavrk/hush-expo` registers the
install and raises the value as they happen. The app's Info.plist asks iOS
to send hush a copy of each postback; hush verifies Apple's signature, keeps
Apple's test postbacks under dev, and never counts one that does not verify.
hush matches a postback to an app by the catalog's `app_store_id` alone, so
attribution needs it; the catalog is read at boot, so restart hush after
editing it. Enter the same milestone table in the ad network (Meta: Events
Manager, the app, SKAdNetwork) so it reads the values the way you do. The
Attribution panel shows installs per ad network and campaign, how far they got, and the
App Store campaigns beside them.

## Deploy it

Put hush behind a proxy that terminates TLS, then:

- expose `/v1/*` and `/healthz` to the internet: that is what apps talk to;
- for ad attribution, also expose `POST /.well-known/skadnetwork/report-attribution/`
  and `POST /.well-known/appattribution/report-attribution/`, on the
  registrable domain your `attributionEndpoint` names: that is what iOS talks
  to;
- keep `/dashboard/` and `/admin/*` behind a VPN or an access proxy. The
  admin token is the second lock, not the only one;
- set `CLIENT_IP_HEADER`, or every caller shares the proxy's address and its
  rate limits; set it and `COUNTRY_HEADER` only to headers your proxy
  overwrites;
- back up Postgres. It is the only state.

Rate limits are in memory and per process (120 requests a minute per address,
5 feedback messages a day per install, or per address and app for a ticket
with an email). One instance is plenty for small apps.

## What is collected

- **A random install id** the app creates on first launch; the only
  identifier.
- **App version, OS, device model, the device's language**, and the events and
  props your app sends.
- **Feedback messages**, and an email address only if a user typed one. A
  ticket with an email carries neither the install id nor RevenueCat's id
  ([Feedback](#feedback)).
- **Country**, only with `COUNTRY_HEADER` behind a trusted proxy; the
  dashboard folds any country under ten installs into "other".
- **Never an IP address.** Rate limits count a salted hash held in memory.
- **No advertising or device identifiers**, so nothing for App Tracking
  Transparency to ask about; from a link, only its campaign tags.

Raw events are deleted after `RETENTION_DAYS` (180), and an install that has
sent nothing for `INSTALL_RETENTION_DAYS` (`RETENTION_DAYS` unless set) loses
its row too. With the defaults, a privacy policy can say that everything about
an install's use of the app is deleted from the live database 180 days after
it last sends anything, and from backups as they expire: name how long yours
are kept, if you keep any. Feedback threads are kept until they are forgotten,
so a policy names them apart: a thread without an email keeps the install id
when the row goes, so it can still be answered. They are forgotten with the
SDK's `forget()`, the dashboard's Installs page, or Delete on one ticket.
Write your privacy policy from this list, and keep your props to what the app
did, not who did it.

### App Privacy answers

What an app on hush and `@bavrk/hush-expo` can declare in App Store Connect's
App Privacy section, for builds on SDK 2.3.0 or later against a server with
migration 008 (`private_screens`; an older server ignores the key). Every row
is Tracking: No. A row applies when its "When" does; an app that collects none
of it leaves the row out.

| Data type | When | Linked to the user | Purposes |
|---|---|---|---|
| Usage Data: Product Interaction | Always: events, sessions, screens | No | Analytics; Developer's Advertising or Marketing when hush-expo reports conversion values |
| Usage Data: Other Usage Data | When the app sends an answer about its use as a prop, such as where the user heard of the app | No | Analytics |
| Usage Data: Advertising Data | With hush-expo's ad attribution: hush stores Apple's postback copies | No | Developer's Advertising or Marketing; Analytics |
| Purchases: Purchase History | When the app sends purchase events (`purchase_started`, `purchase_result`, `restore_result`) | No | Analytics; Developer's Advertising or Marketing when a conversion value marks a purchase |
| Diagnostics: Other Diagnostic Data | Always: app version, build, OS, device model, language, channel, paid flag | No | Analytics |
| Location: Coarse Location | When the server sets `COUNTRY_HEADER` | No | Analytics |
| Contact Info: Email Address | When the feedback form asks for one | Yes, only for people who write in with an email | App Functionality |
| User Content: Customer Support | When the app takes feedback | Yes, only for people who write in with an email; No without an email field | App Functionality |

Usage data is not linked because the install id is a random UUID made on the
device, and a ticket with an email carries neither it nor RevenueCat's id:
hush stores nothing that joins the two, and the dashboard offers no way to.
An app without an email field can answer that Customer Support is not linked
either. Other SDKs in the app (RevenueCat, a crash reporter) answer for
themselves, in the same rows: RevenueCat adds App Functionality to Purchase
History.

What no id can hide: a ticket's time and its build details (version, build,
OS, device model, paid flag) are not ids, but the install's row and events
hold them too, so on an app with few users someone with the database could
narrow a ticket down to one install. hush never does, and an app must not
try: Apple counts data as not linked only while nobody tries to link it back.
So leave the feedback and inbox screens out of `screen()` (or report them
under a name other screens share), list them in the catalog's
`private_screens`, and put nothing about a ticket in an event. The server
then stores no view of them from any build, which matters for app versions
that named a screen by its URL with the ticket id in it, and deletes the
views stored before; backups taken before then keep them until they expire. Builds on 2.2.x or older keep a ticket with an email linked to the
install until the server unlinks it, so these answers hold in full only for
builds on 2.3.0 or later.

## API

Apps send `Authorization: Key <write key>`. The SDK does this for you.

| Endpoint | |
|---|---|
| `POST /v1/events` | Up to 100 events. `200 { accepted, duplicate, rejected }`. Any 4xx but 429 means never: drop the batch. 429 and 5xx: retry later. A view of a screen in the catalog's `private_screens` counts as accepted and is not stored. |
| `POST /v1/tickets` | `{ install?, kind, message, email?, subject?, rc_id?, diag? }` → `201 { id, created_at, status }`. With an email and no install it is stored with neither install nor `rc_id`, and the answer adds `thread`, the key to that ticket. Without an email, `install` is required. |
| `GET /v1/tickets?install=` | That install's feedback (the last 50), with replies and `unread`. Reading marks every reply read. |
| `POST /v1/tickets/list` | `{ install }` → the same, with the install id out of the URL (SDK 2.3.0). |
| `POST /v1/tickets/threads` | `{ threads: [key, …] }` (up to 50) → the same, for the tickets those keys open. Replies are marked read up to the newest one shown. |
| `POST /v1/tickets/:id/reply` | `{ install, body }` or `{ thread, body }` → `201`; `404` for a wrong install or key, `409` once closed, `429` after 20 replies a day. |
| `POST /v1/forget` | `{ install }` → `200 { ok, deleted }`: that install's events, feedback and row, under the calling app. `{ threads }` on its own → `200 { ok, deleted: { tickets } }`; both in one request is a `400`. |
| `GET /v1/config` | The app's conversion values, for the SDK. |
| `POST /.well-known/skadnetwork/report-attribution/` | A copy of Apple's SKAdNetwork postback. No key: Apple's signature is the proof. |
| `POST /.well-known/appattribution/report-attribution/` | The same, for AdAttributionKit. |
| `GET /healthz` | `{ ok, db }` |

The operator side takes `Authorization: Bearer <ADMIN_TOKEN>` and is what the
dashboard reads: `/admin/apps` (with `install_retention_days`), `/admin/apps/:app` (`?channel=`), its
`/breakdown`, `/props`, `/funnels`, `/funnel`, `/cohorts`, `/campaigns` and
`/attribution`, `/admin/installs/:id` with `/forget`,
`/admin/tickets`, `/admin/tickets/:id` with `/reply`, `/status` and `DELETE`, and
`/admin/revenue`.

The command line, inside the container:

```bash
node src/cli.mjs apps:list | apps:add <slug> <name>
node src/cli.mjs keys:create <app> <prod|dev> [label] | keys:list | keys:revoke <id>
node src/cli.mjs rc:projects | rc:sync | rc:link <app> <project> | rc:poll
node src/cli.mjs asc:request <app> | asc:sync [app]
```

## The demo

[The live demo](/demo/dashboard/) is a hush instance started with `DEMO=1`:
three invented apps with sixty days of usage and a few feedback threads,
regenerated every day, read-only, and closed to app data. You can run the same
thing locally to try the dashboard before wiring anything. A demo wipes its
database on start, so it refuses to run against one that holds any write
key.

## With an AI coding agent

hush has a plugin for Claude Code and a skill for other coding agents
(Cursor, Codex and others). They carry the steps and rules on this page, so
the agent wires the SDK the way it is meant to be wired.

In Claude Code:

```
/plugin marketplace add enso-works/hush
/plugin install hush@hush
```

In any other agent:

```sh
npx skills add enso-works/hush
```

Use one or the other in Claude Code, not both, or the skill loads twice. The
plugin brings:

- **The `hush` skill**: install steps, the SDK's API and rules, tracking
  plans, attribution and troubleshooting. The agent loads it when a task mentions hush or
  `@bavrk/hush`. It is the only part `npx skills` installs.
- **`/hush:install`**: adds hush to the app you have open, through the
  installer agent.
- **`hush:installer`**: an agent that finds out whether the app is Expo, bare
  React Native, web or Capacitor, installs the matching packages (and
  upgrades an app on `@bavrk/hush` 2.2.1 or older), writes one
  module that calls `configure()` and then `init()`, wires screens and
  `entry()`, and `identify()` when the app uses RevenueCat or you ask. It
  typechecks and reports what changed. It needs the server URL and the keys
  from you (`/hush:install` asks) and never makes one up.
- **`hush:tracking-planner`**: an agent that reads the app and proposes what
  to track: event names and props within the rules above, funnels, and the
  catalog entry for the server. No personal data in any of it.
