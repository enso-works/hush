# hush SDK (Expo / React Native)

One file, [`src/index.ts`](src/index.ts). It queues events on the device,
sends them in small batches, and survives being offline, killed or
backgrounded. It never throws into your app and never blocks a render: if the
server is down or the key is missing, the app behaves exactly as without it.

Not on npm yet: copy `src/index.ts` into your app (e.g. `src/lib/hush.ts`).

**Peer dependencies**: `react-native`, `@react-native-async-storage/async-storage`,
`expo-constants`, `expo-device`, `expo-localization`.

## Setup

```ts
import * as hush from '@/lib/hush';

hush.configure({
  url: 'https://hush.example.com',
  // A write key ships inside the app bundle: it identifies the app, it is
  // not a secret. Mint one per app and environment with keys:create.
  key: __DEV__ ? '' : 'hush_myapp_prod_…',
});
hush.init(); // once, early; safe to call again, never throws
```

With an empty key the SDK stays off entirely: no storage, no requests.

## Events

```ts
hush.screen('Settings');                              // screen_viewed { screen }
hush.track('workout_completed', { minutes: 20, completed: true });
hush.identify({ pro: true, rcId: customerInfo.originalAppUserId });
hush.entry('widget');                                 // how this session began
hush.entry('link', { url });                          // a link: keeps its utm_* and ref tags, never the URL
await hush.flushNow();                                // e.g. before a purchase sheet
```

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

- Names are `snake_case`, props are one flat level of strings, numbers,
  booleans or null (at most 40 keys, 2 KB). Anything else is dropped by the
  server rather than stored.
- `app_first_opened` and `session_started` are sent for you. A session ends
  after 30 minutes in the background. `session_started` carries `entry`, `n`
  (this install's session number) and `prev_fg_s` (the previous session's
  seconds in the foreground: reported with the next start, because an
  explicit "session ended" dies with the process when iOS kills an app).
- An invalid event name is dropped on the device (the server would drop it
  anyway); with `logLevel: 'error'` the SDK says so in the console.
- `identify({ pro })` is tri-state on the server: a batch that does not know
  yet never downgrades a paid install; only an explicit `false` does.
- Events are sent after a few seconds, every 30 s, in batches of 20, and on
  backgrounding. The queue keeps 500 events for up to 7 days.

## The user's choices

```ts
hush.optOut();            // "don't share anonymous usage": remembered, nothing queued or sent
hush.optIn();
hush.isOptedOut();        // after init()

const r = await hush.forget(); // "delete my data"
// r.ok, or r.error: 'offline' | 'failed' | 'unavailable'
```

hush collects nothing personal, so neither is required, but both are cheap
to offer in Settings. `forget()` asks the server to delete everything stored
about this install (events, feedback and replies), then starts over with a
new install id without counting a new install. Feedback keeps working after
`optOut()`: a user sends that on purpose.

## Debugging

```ts
hush.configure({ url, key, logLevel: __DEV__ ? 'debug' : 'silent', onFlush: (r) => console.log(r) });
const id = await hush.getInstallationId(); // show it in a debug screen, paste it into the dashboard
hush.pause(); hush.resume();               // hold sends (not events), e.g. on a metered connection
```

`onFlush` gets `{ status, accepted, duplicate, rejected, willRetry }` after
every send. The dashboard's Installs page shows one install's latest events
as they arrive.

## Support tickets

```ts
const r = await hush.createTicket({ kind: 'issue', message, email, subject });
// r.ok, r.id; r.error: 'offline' | 'too_many' | 'failed' | 'unavailable'

const tickets = await hush.listTickets();       // with replies and `unread`
await hush.replyToTicket(ticket.id, 'Thanks!'); // error 'closed' once closed
```

`kind` is `issue`, `feature` or `love`. A user can send five a day. Replies
you send from the dashboard show up in `listTickets()`, flagged `unread`
once.

## Options

| | |
|---|---|
| `url` | the hush server, no trailing slash |
| `key` | a write key; empty turns the SDK off |
| `storagePrefix` | AsyncStorage key prefix, default `hush`. Changing it gives every install a new id: an app moving from a copied SDK passes the prefix it used before. |
| `runInBackground` | wraps the flush that runs when the app goes to the background, e.g. in a native background task, so the request is not cut off by suspension |
| `channel` | where this build came from: `app_store`, `testflight`, `play`, `internal`... (snake_case, 24 chars). The dashboard filters by it, so TestFlight and dev-client builds on a prod key stop counting as store users. Pass it per EAS build profile, e.g. `process.env.EXPO_PUBLIC_HUSH_CHANNEL`. Default `dev` in `__DEV__` builds, otherwise not sent. |
| `logLevel` | `silent` (default), `error` (mistakes such as an invalid event name), `debug` (every send) |
| `onFlush` | called after every send with its result |

## Privacy

The SDK creates one random install id and stores it on the device; it reads
the app version and build, the OS, the device model and the phone's language,
and nothing else. It reads no advertising or device identifiers, so there is
nothing to declare for App Tracking Transparency, and it suits apps for
children as well. From a link it keeps only the campaign tags, never the URL.

SDK 2 talks to any hush server; an older server ignores the fields it does
not know (`channel`, `sdk`), and `forget()` needs a server with `/v1/forget`. See the privacy model in the main README.
