---
name: hush
description: Installs, wires and uses hush, self-hosted in-app feedback and anonymous usage tracking, through the @bavrk/hush SDK in Expo, React Native, web and Capacitor apps, the Hush Swift package in native iOS apps, or the hush add-on in Godot games. Covers the configure and init order, screens, events and props within the server's limits, once-events, entry() for links and notifications, identify() with RevenueCat, feedback tickets, opt-out and forget, remote config (typed values with targeting and rollouts, overridden on the dashboard, evaluated on the device), the hush server and its catalog (events, highlight, funnels, breakdowns, private screens, config keys), and Apple ad attribution through @bavrk/hush-expo or @bavrk/hush-capacitor (SKAdNetwork and AdAttributionKit). Use when the user mentions hush or @bavrk/hush, or wants in-app feedback, anonymous analytics, funnels, retention, feature flags, remote config or campaign attribution without IP addresses, advertising ids or a consent banner.
license: MIT
compatibility: Expo apps on React Native 0.73 or later (Expo SDK 52 or later for @bavrk/hush-expo), bare React Native 0.73 or later with Expo modules, or a web, PWA or Capacitor app (iOS 15 or later for @bavrk/hush-capacitor). Needs the URL of a running hush server and a write key minted on it.
metadata:
  sdk: "@bavrk/hush"
  sdk-version: "2.4.0"
  homepage: "https://hush.bavrk.com"
---

# hush

hush is in-app feedback and anonymous usage tracking that the app's owner runs
themselves: one Node container, Postgres and a dashboard, plus an SDK on npm
(`@bavrk/hush`) that queues events on the device and sends them in batches.
Source: https://github.com/enso-works/hush. Docs: https://hush.bavrk.com/docs.

What it does:

- **Anonymous events.** Installs, sessions, screens, the app's own events with
  flat props, funnels, retention, and any event broken down by any prop.
- **Feedback.** Users write from the app (an issue, an idea, kind words). The
  operator answers on the dashboard, and the user reads the reply in the app.
- **Where installs come from.** Link tags, App Store campaign reports, and
  Apple's ad attribution (SKAdNetwork, AdAttributionKit) through
  `@bavrk/hush-expo` in Expo apps and `@bavrk/hush-capacitor` in Capacitor
  apps.
- **Remote config** (SDK 2.4.0). Typed values (a flag, a kill switch, a
  number, copy) declared in the catalog, overridden on the dashboard without
  a release, with rules by platform, version, channel, language and paid
  flag, and staged rollouts, all worked out on the device. The request
  carries nothing the SDK adds about the user (like any request, it has the
  device's IP address and User-Agent).

What it is not:

- **Not a hosted service.** There is no default server. The app needs the URL
  of a hush server someone runs, and a write key minted on it. Never invent
  either one.
- **Not user analytics.** Installs are known by a random id, plus RevenueCat's
  anonymous customer id when the app passes it. No user ids, emails or names go
  into events, and no IP address is stored.
- **Not an ad SDK.** No advertising id, no fingerprinting, no App Tracking
  Transparency prompt.
- **Not a crash reporter, session replay or A/B test tool.** Remote config
  gives values and targeting, rollouts included, but no experiments: no
  exposure events, no variant statistics. The value a device got can ride
  along as a global prop, and the funnels compare by it.

## Which package

| App | Install | Import from |
|---|---|---|
| Expo (Expo Go or a dev build) | `npx expo install @bavrk/hush @react-native-async-storage/async-storage expo-constants expo-device expo-localization` | `@bavrk/hush` |
| Expo, plus iOS ad attribution, TestFlight detection and background time for the flush | also `npx expo install @bavrk/hush-expo`, then a dev or EAS build | `@bavrk/hush-expo` |
| Bare React Native 0.73+ | `npx install-expo-modules@latest`, the Expo line above, `npx pod-install`, rebuild | `@bavrk/hush` |
| Web page, PWA, Capacitor | `npm install @bavrk/hush` | `@bavrk/hush/web` |
| Capacitor, plus iOS ad attribution, TestFlight detection and background time for the flush | also `npm i @bavrk/hush-capacitor && npx cap sync ios`, then a native build | `@bavrk/hush-capacitor` |
| Anything else (Electron, a JavaScript game runtime) | `npm install @bavrk/hush` | `@bavrk/hush/core` |
| Native Swift app (SwiftUI or UIKit, iOS 15+) | Swift Package Manager: `https://github.com/enso-works/hush`, from `0.1.0` | `import Hush` |
| Godot 4 game (`project.godot`) | the add-on at `res://addons/hush/`, from the release zip; enable the plugin | the `Hush` autoload |

A native Swift app calls `Hush.configure(url:key:)` and `Hush.start()` at
launch, then `Hush.screen(_:)`, `Hush.track(_:_:once:)`, `Hush.identify(pro:rcId:)`,
`Hush.entry(.link, url:)` in `onOpenURL`, and `await Hush.createTicket(…)` /
`listTickets()` / `replyToTicket(_:body:)` for feedback, with the same rules
as below; it has no remote config or ad attribution yet
([guide](https://github.com/enso-works/hush/blob/main/swift/README.md)).

A Godot game calls `Hush.configure({"url": …, "key": …})` once, then
`Hush.screen()`, `Hush.track(name, props, once)`, and
`await Hush.send_feedback({…})` or the ready `feedback_panel.tscn`, with the
same rules as below; no remote config, ad attribution or `entry()`. Install
and wire it with [references/godot.md](references/godot.md), not install.md.

Never import `@bavrk/hush` outside React Native: it imports `react-native` and
three Expo modules at the top level. All five peers, `react-native` included,
are marked optional, so npm adds none of them; a React Native app needs the
four besides `react-native`.

## Usage rules

These rules are for SDK 2.2.2 and later. Install 2.3.0 or later, which also
keeps a ticket with an email apart from the install ([App Privacy
answers](#app-privacy-answers)); for an app on 2.2.1 or older, see the note
after the list.

1. **Call `configure()` and then `init()` at startup, in one module.** Nothing
   is tracked before `configure()`. After it the order is free: events tracked
   before `init()` resolves belong to the launch's session and join the queue
   the last launch saved.
2. **Call `entry()` as soon as the app knows how the session began**: the URL
   from `getInitialURL()` or the `url` event, a notification response, a
   widget marker. Made before the session exists, it is held for it. It claims
   a session for 2.5 s after the session starts; a tap inside a running
   session is not its entry and is ignored.
3. **Call `identify({ pro })` whenever RevenueCat answers.** Until then batches
   carry no paid flag, and the server keeps the one it has.
4. **Give an env-provided `url` a string fallback**:
   `process.env.X ?? 'https://…'`. A missing or non-string `url` or `key`
   turns the SDK off (`logLevel: 'error'` says why); it never throws.
5. **Release builds carry the prod key in code.** Read a dev key from the
   environment in development only. `EXPO_PUBLIC_*` and `VITE_*` variables are
   inlined at build time, so a local `.env` can ship the dev key in a release
   build, and its data then shows only under the dashboard's dev switch.
6. **Never hardcode `channel`.** Use `hushExpo.channel()` on iOS where it is
   installed (in Capacitor, `await hushCapacitor.channel()`: a promise), and
   `EXPO_PUBLIC_HUSH_CHANNEL` set per platform in `eas.json`
   (`build.<profile>.android.env`, `build.<profile>.ios.env`), not in a
   profile's top-level `env`, which reaches both platforms. Development builds
   default to `dev`.
7. **Never change `storagePrefix` in a shipped app.** Every user becomes a new
   install, and their opt-out is forgotten.
8. **Name screens by route pattern (`item/[id]`), never by a concrete path.**
   Ids, codes and tokens never go into screen names or props. Leave the
   feedback and inbox screens out (or give them a name other screens share):
   next to a ticket sent with an email, their timing points at the install.
   List the same names in the catalog's `private_screens`, so the server
   drops a view of them from any build, older ones included.
9. **Do not call `listTickets()` at launch for a badge.** Fetching marks every
   reply read on the server. Keep a local seen-set instead.

On 2.2.1 and older, upgrade. Until then these workarounds apply: call
`init()` right after `configure()` and before any `track()` (an event tracked
about a second before `init()` resolves overwrites the last launch's unsent
queue); call `entry()` only after `init()` has resolved and within 2.5 s, and
for a link that brings the app back, hold it and call `entry()` again on the
next AppState `active`; call `identify({ pro })` early with a cached value
(until it runs, batches say `pro: false`, which marks a paying install
unpaid); never pass `undefined` as `url` (`configure()` throws at import time)
or `null` as props (`track()` throws).

## Minimal wiring: Expo

The URL and the key in these snippets, here and in the web section, are
placeholders. Use the real ones
([references/install.md](references/install.md#3-get-the-server-url-and-the-keys),
step 3), or `''` for both before the server exists. Never ship these. To
install, follow [references/install.md](references/install.md).

One module configures and starts the SDK. The rest of the app imports it, never
`@bavrk/hush` directly. `src/lib/hush.ts`:

```ts
import * as hush from '@bavrk/hush';

hush.configure({
  url: 'https://hush.example.com',
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : 'hush_myapp_prod_…',
  channel: process.env.EXPO_PUBLIC_HUSH_CHANNEL,
  logLevel: __DEV__ ? 'error' : 'silent',
});

export const hushReady = hush.init();
export * from '@bavrk/hush';
```

With `@bavrk/hush-expo` installed (a dev or EAS build), the same module:

```ts
import * as hush from '@bavrk/hush';
import * as hushExpo from '@bavrk/hush-expo';

hush.configure({
  url: 'https://hush.example.com',
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : 'hush_myapp_prod_…',
  channel: hushExpo.channel() ?? process.env.EXPO_PUBLIC_HUSH_CHANNEL,
  attribution: hushExpo.attribution,
  runInBackground: hushExpo.runInBackground,
  logLevel: __DEV__ ? 'error' : 'silent',
});

export const hushReady = hush.init();
export * from '@bavrk/hush';
```

Root layout (`app/_layout.tsx` with Expo Router). Importing the module runs
`configure()` and `init()` before any screen renders:

```tsx
import * as Linking from 'expo-linking';
import { usePathname, useSegments } from 'expo-router';
import { useEffect } from 'react';

import * as hush from '@/lib/hush';

// The app's feedback and inbox routes, as screen() would name them. The
// catalog's private_screens lists them too: ["feedback", "support"].
const UNTRACKED = new Set(['feedback', 'support', 'support/[id]']);

export default function RootLayout() {
  const pathname = usePathname();
  const segments = useSegments();

  // How this session began. Held for the session if init() has not resolved
  // yet. Links and notification taps that bring the app back:
  // references/install.md step 8.
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url) hush.entry('link', { url });
    });
  }, []);

  // Screens by route pattern ("item/[id]"), groups such as "(tabs)" dropped,
  // except the feedback and inbox routes (rule 8).
  useEffect(() => {
    const name = segments.filter((s) => !s.startsWith('(')).join('/') || 'home';
    if (!UNTRACKED.has(name)) hush.screen(name);
  }, [pathname]);

  // ...the app's navigator
}
```

## Minimal wiring: web

`src/lib/hush.ts`, with Vite. One client per page:

```ts
import { createWebHush } from '@bavrk/hush/web';

const PROD_KEY = 'hush_myapp_prod_…';
const browser = typeof window !== 'undefined';

export const hush = createWebHush({
  version: import.meta.env.VITE_APP_VERSION,
  build: import.meta.env.VITE_APP_BUILD,
  dev: import.meta.env.DEV,
});

// Configure and start in the browser only; unconfigured, every call is a no-op.
if (browser) {
  hush.configure({
    url: 'https://hush.example.com',
    key: import.meta.env.DEV ? (import.meta.env.VITE_HUSH_KEY ?? '') : PROD_KEY,
    channel: import.meta.env.VITE_HUSH_CHANNEL,
    logLevel: import.meta.env.DEV ? 'error' : 'silent',
  });
}

export const hushReady = browser ? hush.init() : Promise.resolve();

// How the session began: a link with campaign tags. Held until the session exists.
if (browser && /[?&](utm_[a-z]+|ref)=/.test(location.search)) hush.entry('link', { url: location.href });
```

Pass `version`, or the dashboard shows version `unknown`;
[references/install.md](references/install.md#5-create-the-hush-module), step
5, shows how to define it with Vite. For Capacitor, pass
`platform: Capacitor.getPlatform()`.

With `@bavrk/hush-capacitor` installed in a Capacitor app (then
`npx cap sync ios` and a native build), the same configure call takes its
channel, bridge and background task. Its `channel()` crosses Capacitor's
bridge, so it is a promise; where the module cannot await, call
`configure()` with the fallback first and again with the result, before
`init()` (each call replaces the whole configuration):

```ts
import * as hushCapacitor from '@bavrk/hush-capacitor';

hush.configure({
  // ...url, key, logLevel as before
  channel: (await hushCapacitor.channel()) ?? import.meta.env.VITE_HUSH_CHANNEL,
  attribution: hushCapacitor.attribution,
  runInBackground: hushCapacitor.runInBackground,
});
```

## Events and props

- **Event names** match `^[a-z][a-z0-9_]{1,63}$`: lowercase snake_case, 2 to
  64 characters, starting with a letter. Write `<object>_<past verb>`:
  `workout_completed`, `reminder_set`. The SDK drops an invalid name on the
  device.
- **Props** are one flat object of strings (at most 200 characters), finite
  numbers, booleans or `null`. Keys match `^[a-z][a-z0-9_]{0,39}$`, so
  `durationMs` is invalid and `duration_ms` is right. At most 40 keys, global
  props included, and at most 2048 bytes as JSON.
- **Any prop violation makes the server reject the whole event.** The SDK
  drops an event with a value that is not flat (an object, an array, a press
  event) on the device, and warns about more than 40 keys; the server rejects
  bad keys, long strings and oversize props. Check that `onFlush` reports
  `rejected: 0`.
- Pass an object, `null` or nothing as props.
- Prefer a prop on an existing event to a new name:
  `feature_used { feature: 'share' }`.
- A milestone that code might fire twice: `track(name, props, { once: true })`,
  or `{ once: 'key' }` for once per key.
- The SDK sends `app_first_opened`, `session_started`, `screen_viewed`,
  `ticket_opened` and `ticket_replied` itself. Never track these names.
- The paywall card and the default funnel expect `paywall_viewed`,
  `purchase_started` and `purchase_result { result: 'purchased' }` (or
  `'cancelled'`, `'failed'`), plus `restore_result { result }`.
- Every event name the app sends goes into the server's catalog, or the
  dashboard lists it as unknown. The server knows the SDK's own names without
  it; a server from before `ticket_replied` joined them needs it in the
  catalog when the app lets users reply.
- **Never track** emails, names, phone numbers, account or backend ids, text a
  user typed, precise location, or URLs and paths that carry ids.

## API cheat sheet

| Call | What it does |
|---|---|
| `configure(config)` | Sets `url`, `key` and the options. Once, before `init()`. |
| `init()` | Reads storage, sends `app_first_opened` once, starts a session and the flush timer. Returns a promise, never throws. |
| `track(name, props?, { once? })` | Queues an event. |
| `screen(name)` | Queues `screen_viewed { screen }`. |
| `entry(source, { url? })` | How the session began: `'link'`, `'notification'`, `'widget'`, `'quick_action'`, `'siri'` or another label. A link keeps only its `utm_*` and `ref` tags. Held until the session exists. |
| `identify({ rcId?, pro?, language? })` | RevenueCat's customer id and the paid flag, sent with every batch once set. `language`: the language the app shows, for remote config rules only, never sent; call it on an in-app language switch and values follow at once. |
| `setGlobalProps(props)`, `removeGlobalProp(key)`, `clearGlobalProps()` | Props merged into every later event. Memory only: set them each launch. |
| `createTicket({ kind, message, email?, subject? })` | Sends feedback. `kind` is `issue`, `feature` or `love`. Returns `{ ok, id?, error? }`. With an email it sends no install id and keeps a thread key for the ticket instead (2.3.0). |
| `listTickets()` | This install's tickets and the ones it sent with an email, with replies and `unread`. Marks replies read. |
| `replyToTicket(id, body)` | The user's answer. `error: 'closed'` once the ticket is closed. |
| `optOut()`, `optIn()`, `isOptedOut()` | The user's choice, remembered. Feedback and remote config keep working. |
| `forget()` | Deletes this install's data, and the tickets sent with an email whose keys are on the device, on the server; starts over with a new id. A failure after the keyed tickets went leaves them deleted; call it again. It cannot reach a ticket a build before 2.3.0 sent with an email once the server has unlinked it. |
| `getInstallationId()` | The install id, for a debug screen and the dashboard's Installs page. |
| `flushNow()`, `pause()`, `resume()` | Send one batch now (after one in flight); hold sends; send again. |
| `telemetryAvailable()` | Whether the SDK is on (a url and a non-empty key). |
| `config.bool(key, fallback)`, `.number`, `.string`, `.json` | A remote config value for this device, or the fallback (nothing loaded yet, not in the catalog, another type). Never throws. `json()` is frozen. |
| `config.ready(timeoutMs?)` | Resolves once values are usable: from the cache, or the first fetch on a first launch. Hold the splash screen on it. Never rejects; 3 s by default. |
| `useConfig()` | React Native: re-renders when a value changes, and returns a frozen copy of `config` that is new after each change, so the React Compiler's memoizing follows it. In components read from it, not from `hush.config`. |
| `config.onChange(fn)`, `config.refresh()`, `config.revision()`, `config.snapshot()` | Changed keys when values are worked out again (a new revision, `identify()` changing `pro` or the language, `forget()`, `configure()`; never a 304); fetch now; the revision in use; every key with its value, rule and bucket for a debug screen. |

Options: `url`, `key`, `channel`, `logLevel` (`silent`, `error`, `debug`),
`onFlush`, `storagePrefix`, `runInBackground`, `attribution`, `remoteConfig`
(on by default; `false`, or `{ refreshMinutes, language }`). Types, defaults
and edge cases are in [references/sdk-api.md](references/sdk-api.md); remote
config end to end in [references/remote-config.md](references/remote-config.md).

## App Privacy answers

What an app on hush and `@bavrk/hush-expo` or `@bavrk/hush-capacitor` can
declare in App Store Connect's App Privacy section, with SDK 2.3.0 or later
and a hush server with migration 008 (`private_screens`; an older server
ignores the key). Every row is Tracking: No. A row applies when its "When"
does; leave out the rows the app does not collect.

| Data type | When | Linked to the user | Purposes |
|---|---|---|---|
| Usage Data: Product Interaction | Always: events, sessions, screens | No | Analytics; Developer's Advertising or Marketing when hush-expo or hush-capacitor reports conversion values |
| Usage Data: Other Usage Data | When the app sends an answer about its use as a prop, such as where the user heard of the app | No | Analytics |
| Usage Data: Advertising Data | With hush-expo's or hush-capacitor's ad attribution: hush stores Apple's postback copies | No | Developer's Advertising or Marketing; Analytics |
| Purchases: Purchase History | When the app sends purchase events (`purchase_started`, `purchase_result`, `restore_result`) | No | Analytics; Developer's Advertising or Marketing when a conversion value marks a purchase |
| Diagnostics: Other Diagnostic Data | Always: app version, build, OS, device model, language, channel, paid flag | No | Analytics |
| Location: Coarse Location | When the server sets `COUNTRY_HEADER` | No | Analytics |
| Contact Info: Email Address | When the feedback form asks for one | Yes, only for people who write in with an email | App Functionality |
| User Content: Customer Support | When the app takes feedback | Yes, only for people who write in with an email; No without an email field | App Functionality |

Why usage data is not linked: the install id is a random UUID made on the
device, and a ticket with an email carries neither it nor RevenueCat's id.
hush stores no id or key that joins such a ticket to an install, the
dashboard offers no way to do it, and the SDK tracks no `ticket_opened` or
`ticket_replied` for it. A ticket without an email carries the install id,
which is how the answer gets back, and nothing that says who wrote it. So
Contact Info and Customer Support are linked only for people who write in
with an email. A postback copy names no install.

- The ticket's time and diagnostics (version, build, OS, device, paid flag)
  are also on the install's row and events, so someone with the database
  could still narrow a ticket down to one install on a small app. Apple
  counts data as not linked only while nobody tries to link it back: never
  do, leave the feedback and inbox screens out of `screen()` (usage rule 8)
  and list them in the catalog's `private_screens`, and put nothing about a
  ticket in an event.
- Other SDKs in the app answer in the same rows: RevenueCat adds App
  Functionality to Purchase History. Braele's answers, which this table
  follows, have no Identifiers row for the install id or RevenueCat's
  anonymous id.
- Versions already in users' hands on 2.2.x or older still send the install
  id with an email, and track `ticket_opened` and `ticket_replied` with it.
  The server drops RevenueCat's id at once. It clears the install id, and
  deletes that install's ticket events since the ticket was opened, once the
  ticket is closed and that app has fetched it since (or 7 days after it
  closed), or after 30 idle days; until then that one ticket is linked to
  that install. A version that named a screen by its URL put the ticket id
  in it: `private_screens` drops those views, stored ones included (a
  backup taken before keeps them until it expires). The answers above hold
  in full for builds on 2.3.0 or later.
- Retention for the privacy policy: raw events go after `RETENTION_DAYS`
  (180), and an install's row once it has sent nothing for
  `INSTALL_RETENTION_DAYS` (the same by default; set shorter, the row goes
  before its events), so everything about an install's use of the app is
  gone from the live database 180 days after it last sends anything. The
  server's database backups keep it until they expire: the policy names
  that retention too. Feedback threads stay until they are deleted.
- Remote config adds no row and changes none: its request carries the write
  key and a revision, and the device never reports which value it got. Like
  any request it arrives with the device's IP address and the platform's
  User-Agent; hush keeps neither (the address is only hashed, salted, for
  in-memory rate limits), but a TLS proxy's access log may. It goes on after
  an opt-out: a policy that promises nothing leaves the device then says
  so, or the app sets `remoteConfig: false`
  ([references/remote-config.md](references/remote-config.md#7-privacy)).
- "Delete my data" (`forget()`) reaches the tickets sent with an email only
  while the device holds their keys, and a 2.2.x ticket only until the server
  unlinks it. Give the support address in that setting for messages sent
  with an email; the operator deletes those with Delete on the ticket.

## The server side

The app is half the work. On the hush server, the operator:

- registers the app (`APPS=myapp=My App`, or `node src/cli.mjs apps:add myapp "My App"`);
- mints the keys: `node src/cli.mjs keys:create myapp prod`, and `dev`. Each
  key is printed once;
- adds every event name, a highlight, funnels and breakdowns to the app's entry
  in `CATALOG_FILE`, and the feedback and inbox screens to its
  `private_screens`, then restarts the server. The catalog is read at boot,
  and a bad one stops the boot;
- declares the app's remote config keys in the same entry (`config`), and
  changes their defaults and rules later on the dashboard's Remote config
  page, which needs a server with migration 009.

## References

Read the one the task needs:

- [references/install.md](references/install.md): the install procedure, step by
  step, from detecting the project to the report.
- [references/sdk-api.md](references/sdk-api.md): every option, function and
  type, the events the SDK sends itself, delivery and limits.
- [references/tracking-plan.md](references/tracking-plan.md): choosing events,
  props, once-events, the highlight, funnels, breakdowns and conversion values,
  with a template catalog entry.
- [references/server.md](references/server.md): running the server, environment,
  apps and keys, what to expose, the catalog schema and its validation.
- [references/remote-config.md](references/remote-config.md): the `config`
  catalog schema, how rules and rollouts are evaluated, the SDK patterns (a
  flag, a kill switch, a staged rollout, copy by language, measuring a
  variant), the dashboard, privacy and troubleshooting.
- [references/attribution.md](references/attribution.md): link tags, App Store
  campaigns, SKAdNetwork and AdAttributionKit end to end, and what each can
  prove.
- [references/godot.md](references/godot.md): the Godot add-on, its install,
  options and API.
- [references/troubleshooting.md](references/troubleshooting.md): symptom,
  cause and fix.
