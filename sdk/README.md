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
await hush.flushNow();                                // e.g. before a purchase sheet
```

- Names are `snake_case`, props are one flat level of strings, numbers,
  booleans or null (at most 40 keys, 2 KB). Anything else is dropped by the
  server rather than stored.
- `app_first_opened` and `session_started` are sent for you. A session ends
  after 30 minutes in the background.
- `identify({ pro })` is tri-state on the server: a batch that does not know
  yet never downgrades a paid install; only an explicit `false` does.
- Events are sent after a few seconds, every 30 s, in batches of 20, and on
  backgrounding. The queue keeps 500 events for up to 7 days.

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

## Privacy

The SDK creates one random install id and stores it on the device; it reads
the app version and build, the OS, the device model and the phone's language,
and nothing else. See the privacy model in the main README.
