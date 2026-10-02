# @bavrk/hush 2.4.0: API reference

Checked against `sdk/src/core.ts`, `index.ts` and `web.ts` at 2.4.0, and
`@bavrk/hush-expo` 0.1.3. Where 2.2.1 and older behave differently, the entry
says so.

## Contents

1. [Entries and packages](#1-entries-and-packages)
2. [configure() options](#2-configure-options)
3. [Functions](#3-functions)
4. [Events the SDK sends itself](#4-events-the-sdk-sends-itself)
5. [Sessions and entry()](#5-sessions-and-entry)
6. [Delivery: queue, batches, retries](#6-delivery-queue-batches-retries)
7. [Limits the server enforces](#7-limits-the-server-enforces)
8. [The web entry](#8-the-web-entry)
9. [The core](#9-the-core)
10. [@bavrk/hush-expo](#10-bavrkhush-expo)
11. [Types](#11-types)
12. [Remote config](#12-remote-config)

## 1. Entries and packages

| Import | For | Needs |
|---|---|---|
| `@bavrk/hush` | React Native and Expo. Module functions over one instance. | `@react-native-async-storage/async-storage`, `expo-constants`, `expo-device`, `expo-localization`, `react-native` >= 0.73 (optional peers: npm does not add them) |
| `@bavrk/hush/web` | Web pages, PWAs, Capacitor. `createWebHush()` returns an instance. | nothing |
| `@bavrk/hush/core` | Any other runtime. `createHush(platform)` returns an instance. | nothing |
| `@bavrk/hush-expo` | iOS native companion for Expo: conversion values, distribution channel, background time. | `expo` >= 52 (its only peer from 0.1.3), a dev or EAS build, iOS deployment target 16.4 |

The package ships ESM and CommonJS builds. `/web` and `/core` resolve through
package `exports`: TypeScript needs `moduleResolution` `bundler`, `node16` or
`nodenext`.

The React Native entry reads the version from `Constants.expoConfig.version`,
the build from `expoConfig.ios.buildNumber` or `expoConfig.android.versionCode`,
the device from `expo-device`, and the locale from the phone's first language.
In bare React Native, keep those fields in `app.json`, or the dashboard shows an
empty version.

## 2. configure() options

`configure(config: HushConfig): void`. Call it once, before `init()`. Calling it
again replaces the configuration, except `runInBackground`, which stays until
another function is passed. It never throws: a config that is not an object,
or a `url` or `key` that is missing or not a string, turns the SDK off, and
`logLevel: 'error'` logs why (`url is missing or not a string: telemetry is
off`). 2.2.1 and older throw a TypeError on a non-string `url`.

| Option | Type | Default | Behaviour |
|---|---|---|---|
| `url` | `string` | required | The hush server. Surrounding spaces and trailing slashes are stripped. Missing, empty or not a string (such as an unset env var) turns the SDK off. |
| `key` | `string` | required | A write key from `keys:create`. Empty or missing turns the SDK off: no storage, no requests; `forget()` and `createTicket()` return `unavailable`, `listTickets()` returns `[]`. |
| `channel` | `string` | `'dev'` in a dev build, otherwise not sent | Where the build came from: `app_store`, `testflight`, `play`, `internal`, `dev`. Must match `^[a-z][a-z0-9_]{0,23}$`; anything else is not sent and is logged at `error`. The dashboard shows a missing channel as `unknown`. |
| `logLevel` | `'silent' \| 'error' \| 'debug'` | `'silent'` | `error` warns (`console.warn('[hush]', …)`) about mistakes: a missing url or key, bad event names, props that are not flat, more than 40 props, a bad channel, a failed native call, failed sends. `debug` also logs every send and state change. |
| `onFlush` | `(r: FlushResult) => void` | none | Called after every send to `/v1/events`. Exceptions it throws are swallowed. |
| `storagePrefix` | `string` | `'hush'` | Prefix for the stored keys `<p>.install.v1`, `.queue.v1`, `.first.v1`, `.once.v1`, `.optout.v1`, `.sessions.v1`, `.attribution.v1`, `.threads.v1`, `.config.v1`. Changing it gives every install a new id, a second `app_first_opened`, and loses opt-outs, once-keys, session counts, attribution state, the thread keys of tickets sent with an email (the app no longer lists those) and the config cache (`.config.v1`: getters return their fallbacks until the next fetch). |
| `runInBackground` | `(work: () => Promise<void>) => Promise<void>` | runs `work` directly | Wraps the flush that runs when the app backgrounds. `hushExpo.runInBackground` asks iOS for background time. |
| `attribution` | `AttributionBridge` | none | `{ update(v: ConversionValue): Promise<void> \| void }`. Turns on Apple conversion values; see [attribution.md](attribution.md). |
| `remoteConfig` | `boolean \| RemoteConfigOptions` | on | Remote config (2.4.0, section 12). `false`: no request, no cache, every getter returns its fallback. `{ refreshMinutes }`: how often to fetch again at most, on returning to the foreground and while in it (default 15; a finite number is clamped to 1..1440). `{ language: () => string }`: the language the app shows, for language rules, read at each evaluation (missing, throwing or empty: the phone's first locale); it never leaves the device. |

`FlushResult` is `{ status: number | 'offline'; accepted; duplicate; rejected; willRetry }`.

## 3. Functions

The default entry exports these as module functions. `createWebHush()` and
`createHush()` return an object with the same members.

| Function | Signature | Behaviour |
|---|---|---|
| `init` | `(): Promise<void>` | Reads storage; creates or loads the install id; drops the stored queue if opted out; merges the persisted queue (events older than 7 days dropped) with the events tracked before it, and saves the result; sends `app_first_opened` once; starts the launch's session and attribution; listens for app state; starts the 30 s timer; flushes. Safe to call again or concurrently: one run, and every caller resolves once the session exists (2.2.1 and older: a second call during a first launch could resolve before it). Never throws. Does nothing if the SDK is off or `configure()` has not run. |
| `track` | `(name: string, props?: Props \| null, options?: { once?: true \| string } \| null): void` | Queues an event. An invalid name, or a prop value that is not a string, number, boolean or null, drops the event on the device (logged at `error`). `null` props are no props (2.2.1 and older throw). `once: true` keys on `name`; `once: 'k'` keys on `name:k`. Tracked before `init()` resolves: queued under the launch's session id, merged with the stored queue at `init()`. |
| `screen` | `(name: string): void` | Queues `screen_viewed { screen: name }`. A name that is not a string is ignored; over 200 characters the server rejects it. |
| `entry` | `(source: Entry, options?: { url?: string } \| null): void` | Sets `entry` on the held `session_started`, adds the link's campaign tags, and commits it. With no session pending, it is held for the next one (section 5). |
| `identify` | `(next: { rcId?: string; pro?: boolean }): void` | Sets RevenueCat's customer id (only a non-empty string; it cannot be cleared) and the paid flag. Both ride in every batch (`rc_id`, `pro`) and on tickets. Until `pro` is set, it is left out, and the server keeps what it has (2.2.1 and older send `false`). |
| `setGlobalProps` | `(props: Props): void` | Merged into every event queued afterwards; the event's own props win. Memory only. They count toward the 40-key and 2 KB limits. A value that is not flat is not set (logged at `error`). |
| `removeGlobalProp` | `(key: string): void` | |
| `clearGlobalProps` | `(): void` | |
| `installationId` | `(): string` | `''` until `init()` has read it. |
| `getInstallationId` | `(timeoutMs = 3000): Promise<string>` | Waits for `init()` up to the timeout. `''` when the SDK is off. |
| `optOut` | `(): void` | Remembered. Drops the queue and the pending session. No usage data is queued or sent, and nothing is set for attribution, until `optIn()`; the app still asks `/v1/config` for its remote config, a request with no identifier. Tickets still work. |
| `optIn` | `(): void` | Clears the flag, starts a new session if ready, and starts attribution if it never started. |
| `isOptedOut` | `(): boolean` | `false` until `init()` has read storage, unless `optOut()` ran this launch. An `optOut()` or `optIn()` made before `init()` has read storage wins over the stored choice (2.2.1 and older: the stored one wins). |
| `forget` | `(): Promise<{ ok: boolean; error?: 'unavailable' \| 'offline' \| 'failed' }>` | `POST /v1/forget`. A batch already in flight lands first, and no new one is sent until the server answers. First the tickets sent with an email, by their thread keys (`{ threads }`, up to 50 a request, never with the install id); each key is dropped once its request succeeds. Then the install: the server deletes its events, tickets with replies, and install row under this app. The SDK then clears its queue (events tracked while the request was out included), once-keys and session count, mints a new install id and starts a new session. It keeps the first-open marker (no second `app_first_opened`), the opt-out flag, the attribution state and the config cache (without its stored paid flag; rollouts re-bucket for the new id). On `offline` or `failed` the install id and its data stay, but tickets with an email already deleted on the way stay deleted; calling it again finishes the rest. `failed` also when the stored thread keys cannot be read. It cannot reach a ticket with an email whose key is gone (reinstall, new `storagePrefix`), or one a build before 2.3.0 sent once the server has unlinked it: the operator deletes those. A second call while one is out gets its result. |
| `createTicket` | `(input: { kind: 'issue' \| 'feature' \| 'love'; message: string; email?: string; subject?: string }): Promise<{ ok: boolean; id?: string; error?: string }>` | Errors: `unavailable` (no key), `offline`, `too_many` (429), `failed` (any other non-2xx, validation included). Sends `diag { version, build, os, device, pro }`. Without an email: also the install id and `rc_id`, and on success it queues `ticket_opened { kind }`. With an email (2.3.0): no install id, no `rc_id`, no `ticket_opened`; the server answers with a thread key, stored as `<p>.threads.v1` (id to key). A server without migration 007 refuses that with a 400: `failed`, and the SDK does not resend with the install. The keys are read from storage on every use and merged before each save; when storage cannot be read, a new key is held in memory and saved by the next write that works. |
| `replyToTicket` | `(id: string, body: string): Promise<{ ok: boolean; error?: 'unavailable' \| 'offline' \| 'closed' \| 'too_many' \| 'failed' }>` | `closed` is a 409. With a stored thread key for `id` it sends `{ thread, body }` and queues nothing; otherwise `{ install, body }`, and on success it queues `ticket_replied`. |
| `listTickets` | `(): Promise<Ticket[]>` | Two requests: `POST /v1/tickets/list { install }` (on a server without that route, a 404, `GET /v1/tickets?install=` instead) and, when keys are stored, `POST /v1/tickets/threads` with the newest 50. Merged, newest first. Either failing leaves its half out; `[]` when both fail. Fetching marks every support reply read on the server; for tickets read by key the server records which reply was shown, not when. |
| `flushNow` | `(): Promise<void>` | Commits the pending session, waits for a send in flight, then sends one batch (up to 20). Returns early if the SDK is paused, opted out, not ready, forgetting or backing off. |
| `pause`, `resume` | `(): void` | Hold sends (events still queue); send again. Not remembered across launches. |
| `setEnabled` | `(next: boolean): void` | For development and tests. `false` clears the queue and stops everything; `true` works only with a url and a non-empty key. Not remembered. |
| `telemetryAvailable` | `(): boolean` | Whether the SDK is on. |
| `config` | `HushRemoteConfig` | Remote config: `bool`, `number`, `string`, `json`, `ready`, `onChange`, `refresh`, `revision`, `snapshot` (section 12). On every entry. |
| `useConfig` | `(): HushRemoteConfig` | React Native entry only. Returns `config` and re-renders the component when any value changes (`useSyncExternalStore`; `react` >= 18 is an optional peer). |
| `SDK_VERSION` | `'2.4.0'` | Sent as `sdk` with every batch. |
| `createHush` | `(platform: HushPlatform) => Hush` | Also exported from the default entry. |

## 4. Events the SDK sends itself

| Event | When | Props |
|---|---|---|
| `app_first_opened` | The first `init()` ever for this storage prefix | none |
| `session_started` | At `init()` (every cold launch), and on return after more than 30 minutes in the background. Held 2.5 s for `entry()`. | `entry` (default `'launch'`), `n` (this install's session number), `prev_fg_s` (the previous session's foreground seconds, when `n > 1`), the link's campaign tags when claimed with a URL, and the global props as they are when it commits |
| `screen_viewed` | When the app calls `screen()`. The server stores none for a screen in the catalog's `private_screens`, or under one. | `screen` |
| `ticket_opened` | After a successful `createTicket()` without an email | `kind` |
| `ticket_replied` | After a successful `replyToTicket()` on a ticket sent without an email | none |

The server knows these names for every app without a catalog:
`app_first_opened`, `session_started`, `screen_viewed`, `paywall_viewed`,
`purchase_started`, `purchase_result`, `restore_result`, `ticket_opened`,
`ticket_replied`. A server from before `ticket_replied` joined them (migration
`006_ticket_replied_known.sql` marks the replies it stored) lists it as
unknown: on such a server, add it to the catalog if the app lets users reply.

## 5. Sessions and entry()

- A session starts at every cold launch (`init()` in a new process, even
  seconds after iOS killed the last one), and again when the app returns
  after more than 30 minutes in the background to a process that is still
  alive. A return within 30 minutes continues the session.
- The launch's first session keeps the id that events tracked before `init()`
  carry, and its `session_started` is dated from when the SDK loaded, so it
  sorts before them. Later sessions get a new id.
- Its `session_started` is held for 2.5 s. `entry()` inside that window sets
  `entry` and commits it; otherwise it goes out as `'launch'`. Backgrounding
  commits it at once.
- `entry()` with no session pending is held for the next one. The launch's
  first session takes an entry made before `init()` resolved, however late
  that is. A session that starts within 2.5 s takes a later one: a link or a
  notification tap that brings the app back can arrive before AppState turns
  `active`. Otherwise the call was a tap inside a running session and is
  ignored. The first claim wins.
- 2.2.1 and older drop an `entry()` with no session pending: call it after
  `await init()`, and on a return hold the source and call it again on the
  next `active`.
- `entry()` with a URL keeps only `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term`, `utm_content` and `ref`. Keys are lowercased; values are
  URL-decoded, trimmed and cut to 64 characters; the first occurrence wins; the
  fragment is ignored. Everything else, click ids included, is dropped. The URL
  is never sent.
- The session's foreground time is reported with the next start, as
  `prev_fg_s`, because a "session ended" event dies with the process when iOS
  kills an app.

## 6. Delivery: queue, batches, retries

- The queue holds up to 500 events; the oldest go first. It is saved 1 s
  after a change, at once after a delivered batch, as the app leaves, and
  when `init()` has merged it with the stored one; never before that merge.
  On load, events older than 7 days are dropped. (2.2.1 and older: only 1 s
  after a change, also before `init()`, which can overwrite the last
  launch's unsent events, and a process killed within that second sends a
  delivered batch again.)
- A delivered batch leaves the queue by event id, so events queued while it
  was out stay queued.
- Flushes run 3 s after any event, at once when the queue reaches 20, every
  30 s, on backgrounding (through `runInBackground`), and after `init()` and
  `resume()`.
- Each send is one batch of up to 20 events to `POST /v1/events`, with
  `Authorization: Key <key>`.
- A 2xx drops the batch from the queue. **Any other 4xx except 429 also drops
  it**, including a 401 from a wrong or revoked key: those events are gone.
- A 429, a 5xx or a network failure keeps the batch and backs off
  5 s x 2^(n-1), up to 5 minutes.
- React Native: `AppState` `active` is foreground; `background` and `inactive`
  are background. Web: `visibilitychange` and `pagehide`; sends use
  `fetch(…, { keepalive: true })`.

## 7. Limits the server enforces

| What | Rule | On violation |
|---|---|---|
| Event name | `^[a-z][a-z0-9_]{1,63}$` | Dropped on the device; rejected by the server |
| Prop keys | `^[a-z][a-z0-9_]{0,39}$`, at most 40 | Whole event rejected |
| Prop values | string up to 200 characters, finite number, boolean, `null`; one flat level (a `Date` is sent as its ISO string) | Whole event rejected; a value that is not flat drops the event on the device |
| Props size | up to 2048 bytes as JSON | Whole event rejected |
| Event time | 30 days in the past to 1 day in the future | Event rejected |
| Batch | 1 to 100 events, body up to 64 KB | 400 or 413; the SDK drops the batch |
| Context | `version` 32, `build` 32, `platform` 16, `os` 32, `device` 64, `locale` 16, `rc_id` 128, `sdk` 24 characters | Over-long values become null |
| Channel | `^[a-z][a-z0-9_]{0,23}$` | Stored as null |
| `pro` | stored only if boolean; an explicit `false` downgrades. The SDK leaves it out until `identify({ pro })` | |
| Ticket | `message` 1 to 4000 characters, `subject` up to 120, `email` up to 160 and a plausible address, `kind` `issue`, `feature` or `love` | 400, `failed` in the SDK |
| Ticket rate | 5 tickets per install per app per day; with an email and no install, 5 per caller address per app per day (in memory); 20 user replies per ticket per day | 429, `too_many` |
| Request rate, per client address | `/v1/*` 120 a minute, `/v1/events` 60, tickets and replies 10, forget 10 | 429 |

Rejected events count in the response's `rejected` and in `onFlush`. A retried
batch is deduplicated by event id and counted as `duplicate`.

## 8. The web entry

`createWebHush(app?: { version?: string; build?: string; platform?: string; dev?: boolean }): Hush`

- One per page: it owns the lifecycle listeners.
- Storage is `localStorage`, falling back to memory when it is missing or
  refused (private mode, sandboxed frames). With memory, every page load is a
  new install. Safari may clear script-written storage after 7 days without a
  visit.
- Platform, OS and device come from the user agent, coarsely, through
  `fromUserAgent(ua)`: iPhone, iPad and iPod are `ios`; Android is `android`
  ("Android phone" or "Android tablet"); a Mac is `web`/macOS, or an iPad when
  it has touch; Windows, ChromeOS and Linux are `web`.
- `platform` overrides the detected one (Capacitor: `Capacitor.getPlatform()`).
- `version` and `build` default to `''`; pass them.
- `dev: true` makes the default channel `dev`.
- The server answers CORS on `/v1` for any origin, `capacitor://localhost`
  included.
- In server-side rendering, configure and `init()` in the browser only.
  Unconfigured, every call is a no-op.

Exports: `createWebHush`, `fromUserAgent`, `SDK_VERSION`, and the types
`WebApp`, `AttributionBridge`, `ConfigRefreshResult`, `ConfigSnapshotEntry`,
`ConfigType`, `ConversionValue`, `DeviceInfo`, `Entry`, `FlushResult`,
`Hush`, `HushConfig`, `HushRemoteConfig`, `Props`, `RemoteConfigOptions`,
`Ticket`, `TicketKind`. No `useConfig`: read `hush.config` and subscribe with
`config.onChange`.

For remote config the platform is the detected one, so an iPhone browser
matches `platform: ["ios"]` rules; a browser build sharing an app with the
native one passes `platform: 'web'`.

## 9. The core

`createHush(platform: HushPlatform): Hush` from `@bavrk/hush/core`:

```ts
import { createHush } from '@bavrk/hush/core';

const hush = createHush({
  storage: myStorage, // async getItem, setItem, removeItem
  onAppState: (fn) => myLifecycle.on('change', (active) => fn(active ? 'active' : 'background')),
  device: () => ({ version: '1.0.0', build: '1', platform: 'desktop', os: 'macOS 15', device: 'Mac', locale: 'en-US' }),
  isDev: () => false,
  // fetch: optional; the global fetch by default
});
```

`device()` is read at every send.

## 10. @bavrk/hush-expo

| Export | What it does |
|---|---|
| `distribution(): 'simulator' \| 'development' \| 'testflight' \| 'app_store' \| null` | How the build was distributed; `null` without the native module. An embedded provisioning profile (dev, ad hoc, enterprise, EAS internal) reports `development`. |
| `channel(): string \| undefined` | `testflight` or `app_store`; otherwise `undefined`, so pass a fallback. |
| `attribution` | The SDK's `attribution` bridge. Sets the SKAdNetwork value, and the AdAttributionKit value on iOS 17.4 and later; throws only when neither accepts it. |
| `runInBackground(work)` | Runs `work` inside an iOS background task; runs it anyway if iOS refuses. |

- Without the native module (Android, web, Expo Go, a JS update onto an older
  binary) every function is a quiet no-op, and `attribution.update` resolves
  without doing anything.
- Config plugin option `attributionEndpoint`: `https://` and a host, nothing
  after it. It writes `NSAdvertisingAttributionReportEndpoint` and
  `AdAttributionKit.AttributionCopyEndpoint` into `Info.plist`. Without the
  option the plugin does nothing.
- Podspec: iOS 16.4, Swift 5.9, `AdAttributionKit` weak-linked.

## 11. Types

Default entry type exports: `AttributionBridge`, `ConfigRefreshResult`,
`ConfigSnapshotEntry`, `ConfigType`, `ConversionValue`, `DeviceInfo`,
`Entry`, `FlushResult`, `Hush`, `HushConfig`, `HushPlatform`,
`HushRemoteConfig`, `HushStorage`, `LifecycleState`, `Props`,
`RemoteConfigOptions`, `Ticket`, `TicketKind`. `@bavrk/hush/core` also
exports the evaluator's `ConfigEntry`, `ConfigRule`, `ConfigWhen` and
`ConfigContext`.

```ts
type Props = Record<string, string | number | boolean | null>;
type Entry = 'launch' | 'widget' | 'quick_action' | 'siri' | 'notification' | 'link' | (string & {});
type ConversionValue = { fine: number; coarse: 'low' | 'medium' | 'high'; lock: boolean };
type Ticket = {
  id: string;
  kind: 'issue' | 'feature' | 'love';
  subject: string | null;
  message: string;
  status: 'open' | 'answered' | 'closed';
  created_at: string;
  unread: boolean;
  replies: { author: 'support' | 'user'; body: string; at: string }[];
};
type ConfigType = 'bool' | 'number' | 'string' | 'json';
type RemoteConfigOptions = { refreshMinutes?: number; language?: () => string };
type ConfigRefreshResult = { status: number | 'offline' | 'off'; changed: string[] };
type ConfigSnapshotEntry = { key: string; type: string; value?: unknown; rule: number; bucket: number | null };
```

## 12. Remote config

`config` (`HushRemoteConfig`), on every entry. Concepts, the catalog and
patterns: [remote-config.md](remote-config.md).

| Member | Signature | Behaviour |
|---|---|---|
| `bool`, `number`, `string` | `(key: string, fallback: T): T` | The value for this device when the key's type is the getter's and it has a usable value; otherwise the fallback. Never throws. With `logLevel: 'error'` logs once per key and reason: another type (`config "x" is a bool, read as string: using the fallback`), a type this SDK does not read, no usable value, or a key not in a loaded config. Nothing loaded yet, remote config off or an older server: the fallback, no log. |
| `json` | `<T = unknown>(key: string, fallback: T): T` | An object or an array, shape unchecked, deep-frozen; the same reference until the value changes (deep-equal, key order ignored, keeps it). In a development build a fallback object or array is deep-frozen too. |
| `ready` | `(timeoutMs = 3000): Promise<void>` | Calls `init()`. Resolves once a stored config has been loaded and evaluated, or on a first launch once the first fetch settles, or at the timeout (clamped 0..60000); at once when the SDK or remote config is off. Never rejects. Usable, not latest. |
| `onChange` | `(listener: (keys: string[]) => void): () => void` | Called synchronously after an evaluation with the sorted keys whose value appeared, disappeared or changed, the first load included. Evaluations: a stored config loads, a 200 brings one, `identify()` changes `pro`, `forget()` sets a new install id, `configure()` runs again. A listener that throws is ignored. |
| `refresh` | `(): Promise<ConfigRefreshResult>` | Waits for `init()`, then fetches now whatever `refreshMinutes` says, sharing a request in flight. `status` is the HTTP status, `'offline'` (failed or past 15 s) or `'off'`. Never rejects. |
| `revision` | `(): string \| null` | The revision in use; null before anything loads, against an older server, or off. |
| `snapshot` | `(): ConfigSnapshotEntry[]` | Every key, sorted, with `type`, `value` (missing when it has none), `rule` (-1 for the default) and `bucket` (0-99, null before `init()` has the install id). For a debug screen. `[]` when off. |

- **Requests.** `GET /v1/config` with `Authorization: Key <key>` and, when
  the device holds everything the answer would give it, `If-None-Match:
  "<revision>"`. At `init()` once storage is read, on `active` and in the 30 s
  timer while in the foreground when due, and on `refresh()`. One at a time,
  15 s each. Due `refreshMinutes` after a 200, a 304 or another status; after
  offline, a timeout, 429 or 5xx after 1, 2, 4 ... minutes, at most
  `refreshMinutes`. Not stopped by `optOut()`, `pause()` or a send in
  flight; stopped by `setEnabled(false)` (loaded values stay readable).
- **The answer.** A 200 with `config` is cached and evaluated. A 200 without
  it, from a server that never had config, caches an empty config; from one
  rolled back after serving config, keeps the cache. A 304, an error or a
  body that does not parse keeps everything.
- **Storage.** `<prefix>.config.v1`: the server's `config` plus the last
  `pro` that `identify()` gave, so pro rules apply at the next launch before
  `identify()` runs. Written after a 200 that brings config and when `pro`
  changes, never removed. `forget()` drops the stored `pro` and keeps the
  rest; `optOut()` keeps it all. Batches still carry `pro` only once
  `identify()` has given it in this process.
- **Context.** `platform`, `version` and `locale` from `device()`, the
  configured `channel`, `language` from `remoteConfig.language` or the
  locale, `pro` from `identify()` or the cache. A missing field never
  matches a condition on it.
- **Attribution.** With a bridge and remote config on, the one request at
  each `init()` and refresh brings both the milestones and the config. With
  `remoteConfig: false`, attribution fetches on its own, as in 2.3.
