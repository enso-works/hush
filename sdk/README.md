# @bavrk/hush (Expo, React Native, web)

Server, dashboard and docs: [github.com/enso-works/hush](https://github.com/enso-works/hush)
· [hush.bavrk.com/docs](https://hush.bavrk.com/docs). Native iOS companion:
[`@bavrk/hush-expo`](https://www.npmjs.com/package/@bavrk/hush-expo).

The SDK for [hush](https://hush.bavrk.com): in-app feedback and anonymous
usage tracking, sent to your own hush server. It queues events on the device,
sends them in small batches, and survives being offline, killed or
backgrounded. It never throws into your app and never blocks a render: if the
server is down, or the url or key is missing, the app behaves exactly as
without it.

Expo:

```sh
npx expo install @bavrk/hush @react-native-async-storage/async-storage expo-constants expo-device expo-localization
```

Plain JavaScript: in Expo it works in Expo Go and needs no native build. The
peer dependencies are marked optional so that `@bavrk/hush/core` (below)
installs without React Native; a React Native app needs all four.

Bare React Native (0.73+): the default entry reads the version, device and
locale through Expo modules, so add them, then rebuild the native app.

```sh
npx install-expo-modules@latest
npx expo install @bavrk/hush @react-native-async-storage/async-storage expo-constants expo-device expo-localization
npx pod-install
```

The version and build come from the Expo app config (`expo.version`,
`expo.ios.buildNumber`, `expo.android.versionCode` in app.json), not the
native project; keep them in step.

Web, PWA or Capacitor: `npm install @bavrk/hush` and import
`@bavrk/hush/web` ([below](#the-web-and-web-apps-shipped-as-native-ones)); no
peers. Never import the default entry outside React Native. TypeScript needs
`moduleResolution` set to `bundler`, `node16` or `nodenext` to see
`@bavrk/hush/web` and `@bavrk/hush/core`.

Upgrading an app that used the SDK copied into its source before this
package existed: pass the `storagePrefix` that copy used (bavrk apps:
`'bavrk.telemetry'`) to keep every install id.

## Setup

```ts
import * as hush from '@bavrk/hush';

hush.configure({
  url: 'https://hush.example.com',
  // A write key ships inside the app bundle: it identifies the app, it is
  // not a secret. Mint one per app and environment with keys:create. Release
  // builds carry the prod key in code: an env var read at build time can
  // pick up a local .env and ship the dev key.
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : 'hush_myapp_prod_…',
});
hush.init(); // at startup; safe to call again, never throws
```

With an empty key the SDK stays off entirely: no storage, no requests. A
missing or non-string `url` or `key` (an env variable unset in one build
profile, say) turns it off the same way, and with `logLevel: 'error'` it says
why. Give an env variable a fallback so release builds stay on:
`process.env.EXPO_PUBLIC_HUSH_URL ?? 'https://…'`.

Call `configure()` first: the SDK is off until it runs, and events tracked
before it are dropped. After it, the order of calls does not matter. Events tracked before
`init()` resolves belong to the launch's session and join the queue the
last launch saved. An `entry()` made before the session exists is held for
it. Until `identify({ pro })` runs, batches carry no paid flag, and the
server keeps the one it has.

SDK 2.2.1 and older need these workarounds; 2.2.2 fixes all four:

- Call `init()` right after `configure()`, before any `track()`. An event
  tracked more than about a second before `init()` resolves overwrites the
  queue the last launch saved.
- Call `entry()` only after `init()` has resolved and within 2.5 seconds
  (`await hush.init(); hush.entry('link', { url })`); earlier it does
  nothing. A link that brings the app back can arrive before the new
  session exists: hold it and call `entry()` again on the next `active`.
- Call `identify({ pro })` as early as possible on every launch: until it
  runs, batches say `pro: false`, which marks a paid install unpaid.
- Pass `url` as a string and props as an object: `configure()` throws on an
  undefined `url`, and `track()` on `null` props.

## Events

```ts
hush.screen('Settings');                              // screen_viewed { screen }
hush.track('workout_completed', { minutes: 20, completed: true });
hush.identify({ pro: true, rcId: customerInfo.originalAppUserId });
hush.entry('widget');                                 // how this session began
hush.entry('link', { url });                          // a link: keeps its utm_* and ref tags, never the URL
await hush.flushNow();                                // e.g. before a purchase sheet
```

`entry()` says how the session began: pass the URL from
`Linking.getInitialURL()` or the `url` event, or `'notification'` for the
notification response that opened the app. Call it as soon as the app knows.
It claims the session that has just started, for 2.5 seconds after its start.
Made before the session exists, it waits for it: the launch's first session
takes it however late `init()` resolves, and a session that starts within 2.5
seconds takes a later one (iOS delivers a link that brings the app back before
the app is active). Anything else is a tap inside a running session, not its
entry, and is ignored.

### Global props

```ts
hush.setGlobalProps({ paywall_variant: 'b' }); // on every event from now on
hush.removeGlobalProp('paywall_variant');
hush.clearGlobalProps();
```

For context you want to slice everything by: an A/B variant, an onboarding
flow. An event's own props win over globals. They live in memory, so set them
each launch. The dashboard's breakdown slices any event by any prop.

### Once per install

```ts
hush.track('onboarding_completed', {}, { once: true });        // at most once, ever
hush.track('tip_seen', { tip: 'streaks' }, { once: 'streaks' }); // once per key
```

For milestones a code path might fire twice. The SDK remembers what it sent
(the last 200 keys), across launches.

- Event names match `^[a-z][a-z0-9_]{1,63}$` (snake_case, 2-64
  characters). Props are one flat level:
  at most 40 keys (global props included), each key `^[a-z][a-z0-9_]{0,39}$`,
  each value a string of up to 200 characters, a finite number, a boolean or
  null, and 2 KB in all. An event that breaks any of these is rejected whole
  by the server; `onFlush` reports it in `rejected`.
- An invalid event name, or a prop value that is not flat (an object, an
  array, a press event), drops the event on the device: the server would
  reject it anyway. A global prop like that is not set. A `Date` is sent as
  its ISO string, as JSON writes it. With
  `logLevel: 'error'` the SDK says so in the console.
- `app_first_opened` and `session_started` are sent for you. A session starts
  at every cold launch (each new process, even seconds after the last one was
  killed in the background) and when the app comes back after more than 30
  minutes in the background; a return within 30 minutes to a process that is
  still alive continues the session. `session_started` carries `entry`, `n`
  (this install's session number) and `prev_fg_s` (the previous session's
  seconds in the foreground: reported with the next start, because an
  explicit "session ended" dies with the process when iOS kills an app).
  Events tracked before `init()` resolves carry the first session's id, and
  its `session_started` is dated from the moment the SDK loaded, so it sorts
  first.
- `identify({ pro })`: batches carry no paid flag until it runs, and the
  server keeps a paid install paid when a batch carries none (a new install
  starts unpaid). Call it whenever RevenueCat's customerInfo arrives.
- `rcId`: `originalAppUserId` is anonymous only while the app never calls
  `Purchases.logIn()` with its own user ids. If it does, leave `rcId` out.
- Events are sent after a few seconds, every 30 s, in batches of 20, and on
  backgrounding. The queue keeps 500 events for up to 7 days. It is saved a
  second after a change, and at once after a delivered batch and as the app leaves, so
  a process killed right after a send does not send it again.

## The user's choices

```ts
hush.optOut();            // "don't share anonymous usage": remembered, nothing queued or sent
hush.optIn();
hush.isOptedOut();        // after init(), or once optOut() has run

const r = await hush.forget(); // "delete my data"
// r.ok, or r.error: 'offline' | 'failed' | 'unavailable'
```

hush collects nothing personal, so neither is required, but both are cheap
to offer in Settings. `forget()` asks the server to delete everything stored
about this install (events, feedback and replies), then starts over with a
new install id without counting a new install. A batch already on its way
lands before the delete, and nothing is sent until the server has answered.
A choice made before `init()` has read storage (the app applying a stored
consent at startup) wins over the stored one. Feedback keeps working after
`optOut()`: a user sends that on purpose.

## Debugging

```ts
hush.configure({ url, key, logLevel: __DEV__ ? 'debug' : 'silent', onFlush: (r) => console.log(r) });
const id = await hush.getInstallationId(); // show it in a debug screen, paste it into the dashboard
hush.pause(); hush.resume();               // hold sends (not events), e.g. on a metered connection
```

`onFlush` gets `{ status, accepted, duplicate, rejected, willRetry }` after
every send. The dashboard's Installs page shows one install's latest events
as they arrive. `installationId()` is the id synchronously (`''` before
init); `telemetryAvailable()` says whether the SDK is on; `setEnabled(false)`
turns it off for this launch (dev and tests); `flushNow()` sends one batch
of up to 20, after the one in flight if there is one.

## Support tickets

```ts
const r = await hush.createTicket({ kind: 'issue', message, email, subject });
// r.ok, r.id; r.error: 'offline' | 'too_many' | 'failed' | 'unavailable'

const tickets = await hush.listTickets();       // with replies and `unread`
await hush.replyToTicket(ticket.id, 'Thanks!'); // error 'closed' once closed
```

`kind` is `issue`, `feature` or `love`. A user can send five a day. Replies
you send from the dashboard show up in `listTickets()`, flagged `unread`
once. `listTickets()` marks every reply read as it fetches, so for an unread
badge at launch keep your own seen list. A sent ticket and reply are tracked
as `ticket_opened { kind }` and `ticket_replied`, both names every hush
server knows (a server from before `ticket_replied` joined them lists it as
unknown: add it to the catalog there). Neither is tracked for a ticket with
an email (below).

### A ticket with an email is not linked to the install

An email is contact info, and the install id ties a person to everything
their app sends. From 2.3.0 a ticket with an email is kept apart from the
install, so usage data stays "not linked to you" for the people who write in
too:

- `createTicket` with an `email` sends no install id and no RevenueCat id.
  The server answers with a thread key for that one ticket, and the SDK keeps
  it on the device (`<prefix>.threads.v1`). The diagnostics (version, build,
  OS, device, paid flag) still go: they describe the build, not the person.
- No `ticket_opened` is tracked for it, and no `ticket_replied` for a reply
  on it: either event would put the install next to the ticket.
- `listTickets()` makes two requests: the install's tickets by its id, and
  the others by their keys (`POST /v1/tickets/threads`, the newest 50). It
  merges them, newest first. No request carries the install id and a key
  together. `replyToTicket` sends the key, and `forget()` deletes those
  tickets by their keys, in a request of its own, before it forgets the
  install.
- Without an email nothing changes: the install id is how your answer gets
  back to the user, and the ticket carries nothing that says who they are.

The five a day count by the caller's address for a ticket with an email,
since there is no install to count by. The keys live in the app's storage:
deleting the app, or a new `storagePrefix`, loses them, and with them the
app's view of those threads. Your reply still reaches the person by email.

**Server.** This needs a hush server with migration `007_unlinked_tickets.sql`
(October 2026), which adds `POST /v1/tickets/threads`. An older server
refuses a ticket with an email and no install: `createTicket` returns
`failed`, and the SDK does not fall back to sending the install. Update the
server before the app.

**Apps on 2.2.x or older** (and SDKs copied into an app before the package)
still send the install id and RevenueCat's id with an email. A current server
drops the RevenueCat id at once, and keeps the install id only so that the
app's inbox can list the ticket: it is cleared when the ticket is closed, or
30 days after the last activity on it. The dashboard never shows an install
on a ticket with an email.

## Options

| | |
|---|---|
| `url` | the hush server; missing or not a string turns the SDK off (2.2.1 and older throw), so give env vars a fallback |
| `key` | a write key; empty or missing turns the SDK off |
| `storagePrefix` | Storage key prefix (AsyncStorage, or localStorage on the web), default `hush`. Changing it gives every install a new id: an app moving from a copied SDK passes the prefix it used before. It also forgets the user's opt-out, once-events, session count, the ad-attribution state and the keys of tickets sent with an email. |
| `runInBackground` | wraps the flush that runs when the app goes to the background, e.g. in a native background task, so the request is not cut off by suspension |
| `channel` | where this build came from: `app_store`, `testflight`, `play`, `internal`... (snake_case, 24 chars). The dashboard filters by it, so TestFlight and dev-client builds on a prod key stop counting as store users. Pass it per EAS build profile, e.g. `process.env.EXPO_PUBLIC_HUSH_CHANNEL`. Default `dev` in `__DEV__` builds, otherwise not sent. |
| `logLevel` | `silent` (default), `error` (mistakes such as an invalid event name or a missing url), `debug` (every send) |
| `onFlush` | called after every send with its result |
| `attribution` | a bridge `{ update({ fine, coarse, lock }) }` that sets Apple's conversion value, e.g. `hushExpo.attribution` from `@bavrk/hush-expo`; see [Ad attribution](#ad-attribution-ios) below |

## The web, and web apps shipped as native ones

`@bavrk/hush/web` is the same SDK for a web page, a PWA or a Capacitor app:
localStorage keeps the install id and the queue, the page hiding counts as
leaving the app (and sends, with `keepalive`), and the platform, OS and device
model come from the user agent, coarsely. A page has no version of its own,
so pass it; nothing else to install.

```ts
import { Capacitor } from '@capacitor/core'; // Capacitor only
import { createWebHush } from '@bavrk/hush/web';

export const hush = createWebHush({
  version: import.meta.env.VITE_APP_VERSION,
  build: import.meta.env.VITE_APP_BUILD,
  platform: Capacitor.getPlatform(), // Capacitor only: 'ios' | 'android' | 'web'; leave out to read the user agent
  dev: import.meta.env.DEV,
});
hush.configure({
  url: 'https://hush.example.com',
  key: import.meta.env.DEV ? (import.meta.env.VITE_HUSH_KEY ?? '') : 'hush_mygame_prod_…',
  channel: import.meta.env.VITE_HUSH_CHANNEL,
});
hush.init();
// Only a tagged link, so direct visits keep their entry. 2.2.1 and older: call it in init().then().
if (/[?&](utm_|ref=)/i.test(location.search)) hush.entry('link', { url: location.href });
```

The hush server answers CORS on `/v1` for any origin (including Capacitor's
`capacitor://localhost`); a server older than that needs a proxy that does.

## Other platforms: the core

`@bavrk/hush/core` is the whole SDK without React Native or the browser:
`createHush()` takes a storage, the app's foreground/background changes, a
description of the device, and a dev flag, and returns the same API. The web
entry above is about fifty lines of it.

```ts
import { createHush } from '@bavrk/hush/core';

const hush = createHush({
  storage: myStorage, // getItem, setItem, removeItem, async
  onAppState: (fn) => myLifecycle.on('change', (active) => fn(active ? 'active' : 'background')),
  device: () => ({ version: '1.0.0', build: '1', platform: 'desktop', os: 'macOS 15', device: 'Mac', locale: 'en-US' }),
  isDev: () => false,
});
```

## Ad attribution (iOS)

With a native bridge, the SDK sets Apple's conversion value for
SKAdNetwork and AdAttributionKit: it registers the install on first launch
(value 0), then raises the value as the milestones in the server's catalog
(`conversion_values`) happen, for the 35 days Apple listens. The value goes
to Apple and to the ad network that won the install, aggregated; hush gets a
copy of the postback, never anything per install. No App Tracking
Transparency prompt is needed, and nothing is set for an opted-out user.

```ts
import * as hushExpo from '@bavrk/hush-expo'; // SKAdNetwork, AdAttributionKit, TestFlight detection

hush.configure({
  url,
  key,
  attribution: hushExpo.attribution,
  channel: hushExpo.channel() ?? process.env.EXPO_PUBLIC_HUSH_CHANNEL, // Android and internal builds from the EAS profile
});
```

Link tags (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`, `ref`) from a link passed to `entry('link', { url })` join the
session; anything else in the URL, a click id included, is dropped.

## Versions

Semver. `SDK_VERSION` is sent with every batch and stored per install, so the
dashboard can tell which SDK an install runs. Any 2.x works with any hush
server that speaks `/v1`; `forget()` needs one with `/v1/forget`, the web
entry one that answers CORS, and from 2.3.0 a ticket with an email one with
migration 007. 2.1 added `@bavrk/hush/web`; 2.2 the
`attribution` bridge (with `/v1/config` on the server) and `utm_term`.
2.3.0 keeps a ticket with an email apart from the install ([Support
tickets](#a-ticket-with-an-email-is-not-linked-to-the-install)); nothing in
the app has to change for it.
2.2.2 makes the order of calls at startup safe: an early `entry()` is held for
its session, early events keep the launch's session id and the last launch's
queue, the paid flag is left out until `identify()`, a missing `url` turns the
SDK off instead of throwing, `forget()` waits for a send in flight, a
privacy choice made before `init()` wins, and a saved value that cannot be
read or parsed starts over instead of turning the SDK off.

## Privacy

The SDK creates one random install id and stores it on the device; it reads
the app version and build, the OS, the device model and the phone's language,
and nothing else. It reads no advertising or device identifiers, so there is
nothing to declare for App Tracking Transparency, and it suits apps for
children as well. From a link it keeps only the campaign tags, never the URL.
A ticket with an email carries neither the install id nor RevenueCat's id
(2.3.0 and later), so the usage data is not linked to the person who wrote.

SDK 2 talks to any hush server; an older server ignores the fields it does
not know (`channel`, `sdk`), and `forget()` needs a server with `/v1/forget`. See the privacy model in the
[main README](https://github.com/enso-works/hush#what-is-collected).
