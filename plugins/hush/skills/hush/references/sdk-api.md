# @bavrk/hush 2.2.1: API reference

Checked against `sdk/src/core.ts`, `index.ts` and `web.ts` at 2.2.1, and
`@bavrk/hush-expo` 0.1.2.

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

## 1. Entries and packages

| Import | For | Needs |
|---|---|---|
| `@bavrk/hush` | React Native and Expo. Module functions over one instance. | `@react-native-async-storage/async-storage`, `expo-constants`, `expo-device`, `expo-localization`, `react-native` >= 0.73 (optional peers: npm does not add them) |
| `@bavrk/hush/web` | Web pages, PWAs, Capacitor. `createWebHush()` returns an instance. | nothing |
| `@bavrk/hush/core` | Any other runtime. `createHush(platform)` returns an instance. | nothing |
| `@bavrk/hush-expo` | iOS native companion for Expo: conversion values, distribution channel, background time. | `expo` >= 52, a dev or EAS build, iOS deployment target 16.4 |

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
another function is passed.

| Option | Type | Default | Behaviour |
|---|---|---|---|
| `url` | `string` | required | The hush server. Trailing slashes are stripped. A non-string (such as an unset env var) throws a TypeError inside `configure()`. |
| `key` | `string` | `''` | A write key from `keys:create`. Empty turns the SDK off: no storage, no requests; `forget()` and `createTicket()` return `unavailable`, `listTickets()` returns `[]`. |
| `channel` | `string` | `'dev'` in a dev build, otherwise not sent | Where the build came from: `app_store`, `testflight`, `play`, `internal`, `dev`. Must match `^[a-z][a-z0-9_]{0,23}$`; anything else is not sent and is logged at `error`. The dashboard shows a missing channel as `unknown`. |
| `logLevel` | `'silent' \| 'error' \| 'debug'` | `'silent'` | `error` warns (`console.warn('[hush]', …)`) about mistakes: bad event names, nested props, more than 40 props, a bad channel, a failed native call, failed sends. `debug` also logs every send and state change. |
| `onFlush` | `(r: FlushResult) => void` | none | Called after every send to `/v1/events`. Exceptions it throws are swallowed. |
| `storagePrefix` | `string` | `'hush'` | Prefix for the stored keys `<p>.install.v1`, `.queue.v1`, `.first.v1`, `.once.v1`, `.optout.v1`, `.sessions.v1`, `.attribution.v1`. Changing it gives every install a new id, a second `app_first_opened`, and loses opt-outs, once-keys, session counts and attribution state. |
| `runInBackground` | `(work: () => Promise<void>) => Promise<void>` | runs `work` directly | Wraps the flush that runs when the app backgrounds. `hushExpo.runInBackground` asks iOS for background time. |
| `attribution` | `AttributionBridge` | none | `{ update(v: ConversionValue): Promise<void> \| void }`. Turns on Apple conversion values; see [attribution.md](attribution.md). |

`FlushResult` is `{ status: number | 'offline'; accepted; duplicate; rejected; willRetry }`.

## 3. Functions

The default entry exports these as module functions. `createWebHush()` and
`createHush()` return an object with the same members.

| Function | Signature | Behaviour |
|---|---|---|
| `init` | `(): Promise<void>` | Reads storage; creates or loads the install id; drops the stored queue if opted out; merges the persisted queue (events older than 7 days dropped); sends `app_first_opened` once; starts a session and attribution; listens for app state; starts the 30 s timer; flushes. Safe to call again or concurrently (one run). Never throws. Does nothing if `key` is empty or `configure()` has not run. |
| `track` | `(name: string, props?: Props, options?: { once?: true \| string }): void` | Queues an event. An invalid name is dropped on the device. `props` must be an object or omitted: `null` throws. `once: true` keys on `name`; `once: 'k'` keys on `name:k`. |
| `screen` | `(name: string): void` | Queues `screen_viewed { screen: name }`. Not validated on the device; over 200 characters the server rejects it. |
| `entry` | `(source: Entry, options?: { url?: string }): void` | Sets `entry` on the held `session_started`, adds the link's campaign tags, and commits it. A no-op unless a session is pending (section 5). |
| `identify` | `(next: { rcId?: string; pro?: boolean }): void` | Sets RevenueCat's customer id (only if truthy; it cannot be cleared) and the paid flag. Both ride in every batch (`rc_id`, `pro`) and on tickets. `pro` is `false` until set. |
| `setGlobalProps` | `(props: Props): void` | Merged into every event queued afterwards; the event's own props win. Memory only. They count toward the 40-key and 2 KB limits. |
| `removeGlobalProp` | `(key: string): void` | |
| `clearGlobalProps` | `(): void` | |
| `installationId` | `(): string` | `''` until `init()` has read it. |
| `getInstallationId` | `(timeoutMs = 3000): Promise<string>` | Waits for `init()` up to the timeout. `''` when the SDK is off. |
| `optOut` | `(): void` | Remembered. Drops the queue and the pending session. Nothing is queued, sent or set for attribution until `optIn()`. Tickets still work. |
| `optIn` | `(): void` | Clears the flag, starts a new session if ready, and starts attribution if it never started. |
| `isOptedOut` | `(): boolean` | `false` until `init()` has read storage, unless `optOut()` ran this launch. |
| `forget` | `(): Promise<{ ok: boolean; error?: 'unavailable' \| 'offline' \| 'failed' }>` | `POST /v1/forget`. The server deletes this install's events, tickets with replies, and install row under this app. The SDK then clears its queue, once-keys and session count, mints a new install id and starts a new session. It keeps the first-open marker (no second `app_first_opened`), the opt-out flag and the attribution state. On `offline` or `failed` nothing changes. |
| `createTicket` | `(input: { kind: 'issue' \| 'feature' \| 'love'; message: string; email?: string; subject?: string }): Promise<{ ok: boolean; id?: string; error?: string }>` | Errors: `unavailable` (no key), `offline`, `too_many` (429), `failed` (any other non-2xx, validation included). Sends `rc_id` and `diag { version, build, os, device, pro }`. On success it queues `ticket_opened { kind }`. |
| `replyToTicket` | `(id: string, body: string): Promise<{ ok: boolean; error?: 'unavailable' \| 'offline' \| 'closed' \| 'too_many' \| 'failed' }>` | `closed` is a 409. On success it queues `ticket_replied`. |
| `listTickets` | `(): Promise<Ticket[]>` | Up to 50, newest first. `[]` on any failure. Fetching marks every support reply read on the server. |
| `flushNow` | `(): Promise<void>` | Commits the pending session, then sends one batch (up to 20). Returns early if a send is in flight, or the SDK is paused, opted out, not ready or backing off. |
| `pause`, `resume` | `(): void` | Hold sends (events still queue); send again. Not remembered across launches. |
| `setEnabled` | `(next: boolean): void` | For development and tests. `false` clears the queue and stops everything; `true` works only with a non-empty key. Not remembered. |
| `telemetryAvailable` | `(): boolean` | Whether the SDK is on. |
| `SDK_VERSION` | `'2.2.1'` | Sent as `sdk` with every batch. |
| `createHush` | `(platform: HushPlatform) => Hush` | Also exported from the default entry. |

## 4. Events the SDK sends itself

| Event | When | Props |
|---|---|---|
| `app_first_opened` | The first `init()` ever for this storage prefix | none |
| `session_started` | At `init()`, and on return after more than 30 minutes in the background. Held 2.5 s for `entry()`. | `entry` (default `'launch'`), `n` (this install's session number), `prev_fg_s` (the previous session's foreground seconds, when `n > 1`), the link's campaign tags when claimed with a URL, and the global props as they are when it commits |
| `screen_viewed` | When the app calls `screen()` | `screen` |
| `ticket_opened` | After a successful `createTicket()` | `kind` |
| `ticket_replied` | After a successful `replyToTicket()` | none |

The server knows these names for every app without a catalog:
`app_first_opened`, `session_started`, `screen_viewed`, `paywall_viewed`,
`purchase_started`, `purchase_result`, `restore_result`, `ticket_opened`.
`ticket_replied` is not among them: add it to the catalog if the app lets users
reply.

## 5. Sessions and entry()

- A session starts at `init()`, and again when the app returns after more than
  30 minutes in the background.
- Its `session_started` is held for 2.5 s. `entry()` inside that window sets
  `entry` and commits it; otherwise it goes out as `'launch'`. Backgrounding
  commits it at once.
- `entry()` in the same tick as `init()` is lost: the session does not exist
  yet. `await init()` first.
- `entry()` with a URL keeps only `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term`, `utm_content` and `ref`. Keys are lowercased; values are
  URL-decoded, trimmed and cut to 64 characters; the first occurrence wins; the
  fragment is ignored. Everything else, click ids included, is dropped. The URL
  is never sent.
- The session's foreground time is reported with the next start, as
  `prev_fg_s`, because a "session ended" event dies with the process when iOS
  kills an app.

## 6. Delivery: queue, batches, retries

- The queue holds up to 500 events; the oldest go first. It is persisted 1 s
  after a change. On load, events older than 7 days are dropped.
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
| Prop values | string up to 200 characters, finite number, boolean, `null`; one flat level | Whole event rejected |
| Props size | up to 2048 bytes as JSON | Whole event rejected |
| Event time | 30 days in the past to 1 day in the future | Event rejected |
| Batch | 1 to 100 events, body up to 64 KB | 400 or 413; the SDK drops the batch |
| Context | `version` 32, `build` 32, `platform` 16, `os` 32, `device` 64, `locale` 16, `rc_id` 128, `sdk` 24 characters | Over-long values become null |
| Channel | `^[a-z][a-z0-9_]{0,23}$` | Stored as null |
| `pro` | stored only if boolean; an explicit `false` downgrades | |
| Ticket | `message` 1 to 4000 characters, `subject` up to 120, `email` up to 160 and a plausible address, `kind` `issue`, `feature` or `love` | 400, `failed` in the SDK |
| Ticket rate | 5 tickets per install per app per day; 20 user replies per ticket per day | 429, `too_many` |
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
`WebApp`, `AttributionBridge`, `ConversionValue`, `DeviceInfo`, `Entry`,
`FlushResult`, `Hush`, `HushConfig`, `Props`, `Ticket`, `TicketKind`.

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

Default entry type exports: `AttributionBridge`, `ConversionValue`,
`DeviceInfo`, `Entry`, `FlushResult`, `Hush`, `HushConfig`, `HushPlatform`,
`HushStorage`, `LifecycleState`, `Props`, `Ticket`, `TicketKind`.

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
```
