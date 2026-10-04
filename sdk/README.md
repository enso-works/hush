# @bavrk/hush (Expo, React Native, web)

Server, dashboard and docs: [github.com/enso-works/hush](https://github.com/enso-works/hush)
· [hush.bavrk.com/docs](https://hush.bavrk.com/docs). Native iOS companions:
[`@bavrk/hush-expo`](https://www.npmjs.com/package/@bavrk/hush-expo) for Expo,
[`@bavrk/hush-capacitor`](https://www.npmjs.com/package/@bavrk/hush-capacitor)
for Capacitor.

The SDK for [hush](https://hush.bavrk.com): in-app feedback, anonymous
usage tracking and remote config, with your own hush server. It queues events on the device,
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
hush.optOut();            // "don't share anonymous usage": remembered: no usage data is queued or sent; the app still asks /v1/config for its config (see Privacy under Remote config)
hush.optIn();
hush.isOptedOut();        // after init(), or once optOut() has run

const r = await hush.forget(); // "delete my data"
// r.ok, or r.error: 'offline' | 'failed' | 'unavailable'
```

hush collects nothing personal, so neither is required, but both are cheap
to offer in Settings. `forget()` asks the server to delete everything stored
about this install (events, feedback and replies) and the tickets sent with
an email whose keys are on the device, then starts over with a new install
id without counting a new install. A batch already on its way lands before
the delete, and nothing is sent until the server has answered. On `offline`
or `failed` the install and its data stay; tickets with an email it had
already deleted on the way stay deleted, and calling it again finishes the
rest. It cannot reach a message sent with an email from a build before
2.3.0 once the server has unlinked it, or one whose key went with a
reinstall, so have your "delete my data" text give your support address for
messages sent with an email.
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
- `listTickets()` makes two requests: the install's tickets by its id
  (`POST /v1/tickets/list`, so the id is in no URL or access log), and the
  others by their keys (`POST /v1/tickets/threads`, the newest 50). It
  merges them, newest first. No request carries the install id and a key
  together. Reading by key records which reply the app has shown, not when
  it asked. `replyToTicket` sends the key, and `forget()` deletes those
  tickets by their keys, in a request of its own, before it forgets the
  install.
- Without an email nothing changes: the install id is how your answer gets
  back to the user, and the ticket carries nothing that says who they are.

Nothing hush stores joins such a ticket to the install. Its time and
diagnostics can still narrow it down for someone with the database, so leave
the feedback and inbox screens out of `screen()` (or give them a name other
screens share), and put nothing about a ticket in an event. On the server,
list them in the catalog's `private_screens` too: it then stores no view of
them, or of a screen under one (`support/42` under `support`), from any
build, and deletes the ones already stored.

The five a day count by the caller's address and app for a ticket with an
email, since there is no install to count by; behind a proxy that needs the
server's `CLIENT_IP_HEADER`, or all users share one count. The keys live in
the app's storage: deleting the app, or a new `storagePrefix`, loses them,
and with them the app's view of those threads. Your reply still reaches the
person by email.

**Server.** This needs a hush server with migration `007_unlinked_tickets.sql`
(October 2026), which adds `POST /v1/tickets/threads` and
`POST /v1/tickets/list`. An older server refuses a ticket with an email and
no install: `createTicket` returns `failed`, and the SDK does not fall back
to sending the install. On such a server `listTickets()` asks for the
install's tickets by the query, as before. Update the server before the
app.

**Apps on 2.2.x or older** (and SDKs copied into an app before the package)
still send the install id and RevenueCat's id with an email, and track
`ticket_opened` and `ticket_replied` with it. A current server drops the
RevenueCat id at once, and keeps the install id only so that the app's inbox
can list the ticket. It clears it once the ticket is closed and the app has
fetched it since (or 7 days after it closed), or 30 days after the last
activity on it, and with it deletes that install's ticket events since the
ticket was opened. Until then the ticket is linked to the install. Once it
is cleared, the app's `forget()` no longer reaches the ticket: the operator
deletes it on request. The dashboard never shows an install on a ticket with
an email.

## Remote config

Values the app reads at runtime and you change on the dashboard, without a
release: a feature flag, a kill switch, a staged rollout, copy per language.
Values and targeting only: no experiments, no exposure events, no variant
statistics.

Each key is declared in the server's catalog with a type (`bool`, `number`,
`string` or `json`), a default, a description and optional rules. The
dashboard can override a key's default, its rules or both, with a history;
it cannot create keys.

```json
"myapp": {
  "config": {
    "new_home": {
      "type": "bool", "default": false, "description": "The redesigned home screen.",
      "rules": [
        { "when": { "channel": ["testflight", "dev"] }, "value": true },
        { "when": { "platform": ["ios"], "version": ">=2.1.0" }, "rollout": 20, "value": true }
      ]
    },
    "session_presets": { "type": "json", "default": [3, 5, 10], "description": "Session lengths, in minutes." }
  }
}
```

A rule may ask for a platform, an app version range, a build channel, a
language and the paid flag; every condition it has must hold. A rollout puts
that share of installs in, by a bucket from the install id and the key, so an
install stays in or out, and raising 10 to 20 keeps the first 10 in. The
first rule that matches decides; otherwise the default. A condition on
something the device does not know (no channel, `pro` before any
`identify()`, though a paid flag stored at an earlier launch counts) does
not hold.

```ts
const config = hush.config; // the same on the web and core entries

config.bool('new_home', false);
config.number('review_prompt_after', 3);
config.string('paywall_copy', 'Start your free week');
config.json<number[]>('session_presets', [3, 5, 10]);
```

The getters never throw. The fallback comes back when the key is not in the
server's config, has another type, has no usable value, or nothing is loaded
yet. With `logLevel: 'error'` the SDK logs a key not in the server's config,
one of another type and one with no usable value, once per key and reason;
nothing loaded yet (before `init()` has read storage, an older server,
remote config off) logs nothing.

Values are not there on the first render: getters return their fallbacks
until init() has read storage. An app that must not show a fallback first
holds its splash screen until `config.ready()`:

```ts
SplashScreen.preventAutoHideAsync(); // at module load
config.ready().then(() => SplashScreen.hideAsync());
```

`ready(timeoutMs = 3000)` calls `init()` and resolves once values are usable:
at once from the cache, and on a first launch when the first fetch answers or
fails. It never rejects and gives up after its timeout.

A fetch can change a value while a screen shows it. To keep one for the
life of a screen, read it once it is loaded, not at the first render: a
screen mounted at launch (a root or tab screen, which Expo Router keeps
mounted) renders before `init()` has read storage, even behind a held
splash, so `useState(() => config.bool('new_home', false))` there keeps the
fallback for good. Either render no screen until `config.ready()` resolves
(the root layout returns `null` until then, as it does while fonts load),
or latch the value when it is ready:

```tsx
const [newHome, setNewHome] = useState<boolean | null>(null);
useEffect(() => {
  void hush.config.ready().then(() => setNewHome(hush.config.bool('new_home', false)));
}, []);
if (newHome === null) return null; // a moment at most: ready() gives up after 3 s
```

In a component, `useConfig()` (React Native entry) re-renders on any change:

```tsx
import { useConfig } from '@bavrk/hush';

function Home() {
  const config = useConfig();
  return config.bool('new_home', false) ? <NewHome /> : <ClassicHome />;
}
```

It returns a frozen object with `config`'s methods, new after each change
and the same in between, so a value derived from it (in `useMemo`, or by the
React Compiler, which memoizes components on its own) follows a change. In a
component, read from what `useConfig()` returns, not from `hush.config`: a
compiled component that reads `hush.config` directly, or calls a helper that
does, keeps its first values. Pass the object to such a helper instead.

`json()` returns an object or an array, its shape unchecked. The value is
frozen: copy it before changing it (`[...presets].sort()`). In a development
build the fallback is frozen too. An equal value from a later fetch keeps the
same reference.

- `config.onChange((keys) => ...)`: the keys whose value changed. Returns a
  function that removes the listener. Values are worked out again, and
  `onChange` called for what changed, when a stored config loads, a fetch
  brings a new revision, `identify()` changes the paid flag or the language,
  `forget()` gives a new install id, or `configure()` runs again. A 304, or a
  200 with the revision the device already has, changes nothing; nor does a
  getter call.
- `config.refresh()`: fetches now, `{ status, changed }`.
- `config.revision()`: the revision in use, or null.
- `config.snapshot()`: every key with its value, the rule that decided it
  and this install's bucket, for a debug screen.

**Timing and the cache.** The SDK fetches `/v1/config` at `init()`, then on
returning to the foreground and while in it, at most every `refreshMinutes`
(15 by default). A request is limited to 15 s. One that fails (offline, 429,
5xx) is tried again after 1, 2, 4 ... minutes, up to `refreshMinutes`. The
answer is kept under `<prefix>.config.v1`, and the next launch starts from
it; a failed fetch keeps it. The SDK sends the revision it holds and the
server answers 304 when nothing changed. With an attribution bridge one
request serves both the milestones and the config. The cache names the
server and key it came from (a hash, not the key): another app on the same
web origin with the default prefix, or a `configure()` with another url or
key, starts without it. When `init()` cannot read the install id from
storage, the rest of the SDK stays off for that launch, but config still
loads its cache and fetches (rollouts below 100 wait for the install id),
and `refresh()` tries `init()` again.

**Language.** Pass the language the app shows when it is not always the
phone's first: `language: () => locale`, the locale your i18n module
resolved. Otherwise a phone set to Catalan, then Spanish, gets your Spanish UI
and your default copy. It is read when values are worked out (above), not at
every getter call, and nothing works them out when the app switches
language. After an in-app switch, call `identify({ language })`: values
follow at once and `onChange` hears the keys that changed. A language given
to `identify()` wins over the function for the rest of the process (`''`
hands back to it). It is never sent or stored.

```ts
hush.configure({ url, key, remoteConfig: { language: () => i18n.locale } });

i18n.on('languageChanged', (lng) => hush.identify({ language: lng }));
```

**The web.** `@bavrk/hush/web` takes the platform from the user agent, so an
iPhone browser is `ios` and matches rules meant for the native app. A browser
build that shares an app with the native one passes
`createWebHush({ platform: 'web' })`.

**An older server.** A server without remote config answers without it: the
getters return their fallbacks, and nothing is logged. A server rolled back
to such a build keeps the cached values (a kill switch set on the dashboard
stays set) until it serves config again.

**`forget()` and `optOut()`.** Neither stops config: the request carries
nothing the SDK adds about the user (Privacy, below), and an app's features
should not depend on its analytics choice. `forget()` keeps the cache,
drops the stored paid flag, and gives a new install id, so rollouts
re-bucket as for a new install.

**Measuring a variant** is up to the app: put the value in a global prop
and compare funnels by it. Use a key whose values are short names
(`paywall_variant`, default `a`), not the copy itself: an event's props,
global ones included, are capped at 2 KB, and a string value can be 2000
characters. Set it once the value is usable, after `ready()`, and again
from `onChange`. The SDK reports nothing about config by itself.

```ts
const tagVariant = () => hush.setGlobalProps({ paywall_variant: config.string('paywall_variant', 'a') });
config.ready().then(tagVariant);
config.onChange((keys) => keys.includes('paywall_variant') && tagVariant());
```

`remoteConfig: false` turns it off for an app that does not want the
request: no config request, no cache, every getter returns its fallback.
With an attribution bridge, attribution still asks `/v1/config` for its
milestones on its own, as 2.3 does: at `init()` when its copy is older than
12 hours, and never for an opted-out user. The config code stays in the
bundle either way: it is part of `createHush`, so a bundler cannot drop it
(3.5 to 3.7 KB gzip, minified, per entry).

**Privacy.** Remote config sends nothing new. The SDK asks for `/v1/config` with the
app's write key and the revision it already has, and adds nothing about the
device: no install id, no device details, no events. Like any request, it
arrives with the device's IP address and the platform's User-Agent; hush
keeps neither (the address is only hashed, salted, for in-memory rate
limits), but a TLS proxy in front of it may keep both in its access log.
Every install of an app gets the same answer. Targeting and rollouts are
worked out on the device from what the SDK already knows (platform, app
version, build channel, the language the app shows or the phone's, the paid
flag the app passed to `identify()`, and the install id for the rollout).
The device never reports which value it got. The server learns nothing new:
for an install that sends events, it could work the value out from what
those events already carry (platform, version, channel, locale, paid flag,
install id), which is what the dashboard's Preview as does. A user who opted
out still gets config. An app that promises nothing leaves the device after
an opt-out should say in its privacy policy that this request does, or use
`remoteConfig: false`. The App Privacy answers do not change. An app that
reports a config value in an event, say as a global prop, sends it like any
other prop.

## Options

| | |
|---|---|
| `url` | the hush server; missing or not a string turns the SDK off (2.2.1 and older throw), so give env vars a fallback |
| `key` | a write key; empty or missing turns the SDK off |
| `storagePrefix` | Storage key prefix (AsyncStorage, or localStorage on the web), default `hush`. Changing it gives every install a new id: an app moving from a copied SDK passes the prefix it used before. It also forgets the user's opt-out, once-events, session count, the ad-attribution state, the keys of tickets sent with an email, and the config cache (`.config.v1`: fallbacks until the next fetch). |
| `runInBackground` | wraps the flush that runs when the app goes to the background, e.g. in a native background task, so the request is not cut off by suspension: `hushExpo.runInBackground` or `hushCapacitor.runInBackground` |
| `channel` | where this build came from: `app_store`, `testflight`, `play`, `internal`... (snake_case, 24 chars). The dashboard filters by it, so TestFlight and dev-client builds on a prod key stop counting as store users. Pass it per EAS build profile, e.g. `process.env.EXPO_PUBLIC_HUSH_CHANNEL`. Default `dev` in `__DEV__` builds, otherwise not sent. |
| `logLevel` | `silent` (default), `error` (mistakes such as an invalid event name or a missing url), `debug` (every send) |
| `onFlush` | called after every send with its result |
| `attribution` | a bridge `{ update({ fine, coarse, lock }) }` that sets Apple's conversion value, e.g. `hushExpo.attribution` from `@bavrk/hush-expo` or `hushCapacitor.attribution` from `@bavrk/hush-capacitor`; see [Ad attribution](#ad-attribution-ios) below |
| `remoteConfig` | [Remote config](#remote-config): on by default. `false` never fetches it, and every getter returns its fallback. `{ refreshMinutes }`: how often to fetch again at most, on returning to the foreground and while in it (default 15, 1 to 1440). `{ language: () => locale }`: the language the app shows, for language rules (default: the phone's first locale) |

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

A Capacitor app on iOS adds
[`@bavrk/hush-capacitor`](https://www.npmjs.com/package/@bavrk/hush-capacitor)
for what a web view cannot do: Apple's ad attribution, the TestFlight or App
Store channel, and background time for the last send. Its `channel()` is a
promise, as it crosses Capacitor's bridge:

```ts
import * as hushCapacitor from '@bavrk/hush-capacitor'; // npm i @bavrk/hush-capacitor && npx cap sync ios

hush.configure({
  url,
  key,
  channel: (await hushCapacitor.channel()) ?? import.meta.env.VITE_HUSH_CHANNEL,
  attribution: hushCapacitor.attribution,
  runInBackground: hushCapacitor.runInBackground,
});
hush.init();
```

Where the app cannot await first, `configure()` may be called again with the
channel before `init()`; see [its guide](https://github.com/enso-works/hush/tree/main/capacitor#readme).

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

In a Capacitor app, the same through `@bavrk/hush-capacitor`, whose
`channel()` is a promise ([above](#the-web-and-web-apps-shipped-as-native-ones)).

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
tickets](#a-ticket-with-an-email-is-not-linked-to-the-install)), and the
install id out of every URL. No call in the app changes for it, though the
support screens and the "delete my data" text above deserve a look.
Messages sent with an email from earlier builds leave `forget()`'s reach
when the server unlinks them, starting with the server's update.
2.4.0 adds [remote config](#remote-config), on by default. Any server
works; config needs one with migration 009, and an older one gives every
getter its fallback. An app that never reads a value still pays for it: one
`GET /v1/config` at each launch, and at most one every 15 minutes in the
foreground, mostly 304s with no body; a new storage key,
`<prefix>.config.v1`; a request that goes on after `optOut()`; with
`logLevel: 'debug'`, a line for each 304 or failed request; and 3.5 to
3.7 KB gzip in the bundle. `remoteConfig: false` gives exactly 2.3's
behaviour, the bundle aside.
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
(2.3.0 and later): nothing hush stores joins the usage data to the person
who wrote, and the dashboard offers no way to. Timing and build details can
still narrow a ticket down for someone with the database; an app keeps
"not linked" true by never trying. Remote config sends nothing new: its
request carries the write key and a revision, nothing the SDK adds about
the user. Like any request it arrives with the device's IP address and the
platform's User-Agent; hush keeps neither, but a TLS proxy's access log may
([Remote config](#remote-config)).

SDK 2 talks to any hush server; an older server ignores the fields it does
not know (`channel`, `sdk`), and `forget()` needs a server with `/v1/forget`. See the privacy model in the
[main README](https://github.com/enso-works/hush#what-is-collected).
