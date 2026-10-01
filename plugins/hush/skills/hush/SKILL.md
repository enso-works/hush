---
name: hush
description: Installs, wires and uses hush, self-hosted in-app feedback and anonymous usage tracking, through the @bavrk/hush SDK in Expo, React Native and web apps. Covers the configure and init order, screens, events and props within the server's limits, once-events, entry() for links and notifications, identify() with RevenueCat, feedback tickets, opt-out and forget, the hush server and its catalog (events, highlight, funnels, breakdowns), and Apple ad attribution through @bavrk/hush-expo (SKAdNetwork and AdAttributionKit conversion values). Use when the user mentions hush or @bavrk/hush, or wants in-app feedback, anonymous analytics, funnels, retention or campaign attribution without IP addresses, advertising ids or a consent banner.
license: MIT
compatibility: Expo apps on React Native 0.73 or later (Expo SDK 52 or later for @bavrk/hush-expo), bare React Native 0.73 or later with Expo modules, or a web, PWA or Capacitor app. Needs the URL of a running hush server and a write key minted on it.
metadata:
  sdk: "@bavrk/hush"
  sdk-version: "2.2.2"
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
  `@bavrk/hush-expo`.

What it is not:

- **Not a hosted service.** There is no default server. The app needs the URL
  of a hush server someone runs, and a write key minted on it. Never invent
  either one.
- **Not user analytics.** Installs are known by a random id, plus RevenueCat's
  anonymous customer id when the app passes it. No user ids, emails or names go
  into events, and no IP address is stored.
- **Not an ad SDK.** No advertising id, no fingerprinting, no App Tracking
  Transparency prompt.
- **Not a crash reporter, session replay or A/B test tool.** A variant the app
  picked itself can ride along as a global prop.

## Which package

| App | Install | Import from |
|---|---|---|
| Expo (Expo Go or a dev build) | `npx expo install @bavrk/hush @react-native-async-storage/async-storage expo-constants expo-device expo-localization` | `@bavrk/hush` |
| Expo, plus iOS ad attribution, TestFlight detection and background time for the flush | also `npx expo install @bavrk/hush-expo`, then a dev or EAS build | `@bavrk/hush-expo` |
| Bare React Native 0.73+ | `npx install-expo-modules@latest`, the Expo line above, `npx pod-install`, rebuild | `@bavrk/hush` |
| Web page, PWA, Capacitor | `npm install @bavrk/hush` | `@bavrk/hush/web` |
| Anything else (Electron, a game runtime) | `npm install @bavrk/hush` | `@bavrk/hush/core` |

Never import `@bavrk/hush` outside React Native: it imports `react-native` and
three Expo modules at the top level. All five peers, `react-native` included,
are marked optional, so npm adds none of them; a React Native app needs the
four besides `react-native`.

## Usage rules

SDK 2.2.1 behaves as follows. Follow these rules exactly.

1. **Call `configure()` and then `init()` at startup, in one module, before any
   `track()`, `screen()` or `entry()`.** `init()` before `configure()` does
   nothing. An event tracked well before `init()` resolves can overwrite the
   previous launch's unsent events.
2. **Call `entry()` after `init()` has resolved, and within 2.5 s.** The SDK
   holds `session_started` for 2.5 s so that `entry()` can claim it. Called in
   the same tick as `init()`, or later than the window, the entry and the
   link's campaign tags are lost.
3. **Call `identify({ pro })` early, every launch.** Until it runs, every batch
   says `pro: false`, which marks a paying install unpaid. Call it with a
   cached value right after `configure()` if the app keeps one, and again when
   RevenueCat answers.
4. **`url` must be a string.** `configure()` throws on `undefined`, at import
   time, and crashes the app. Write `process.env.X ?? 'https://…'`, never
   `process.env.X` alone.
5. **Release builds carry the prod key in code.** Read a dev key from the
   environment in development only. `EXPO_PUBLIC_*` and `VITE_*` variables are
   inlined at build time, so a local `.env` can ship the dev key in a release
   build, and its data then shows only under the dashboard's dev switch.
6. **Never hardcode `channel`.** Use `hushExpo.channel()` on iOS where it is
   installed, and `EXPO_PUBLIC_HUSH_CHANNEL` set per platform in `eas.json`
   (`build.<profile>.android.env`, `build.<profile>.ios.env`), not in a
   profile's top-level `env`, which reaches both platforms. Development builds
   default to `dev`.
7. **Never change `storagePrefix` in a shipped app.** Every user becomes a new
   install, and their opt-out is forgotten.
8. **Name screens by route pattern (`item/[id]`), never by a concrete path.**
   Ids, codes and tokens never go into screen names or props.
9. **Do not call `listTickets()` at launch for a badge.** Fetching marks every
   reply read on the server. Keep a local seen-set instead.

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

export default function RootLayout() {
  const pathname = usePathname();
  const segments = useSegments();

  // How this session began: after init() resolves, within 2.5 s. Links and
  // notification taps that bring the app back: references/install.md step 8.
  useEffect(() => {
    void hush.hushReady.then(async () => {
      const url = await Linking.getInitialURL();
      if (url) hush.entry('link', { url });
    });
  }, []);

  // Screens by route pattern ("item/[id]"), groups such as "(tabs)" dropped.
  useEffect(() => {
    hush.screen(segments.filter((s) => !s.startsWith('(')).join('/') || 'home');
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

// How the session began: a link with campaign tags, after init() resolves.
export const hushReady = browser
  ? hush.init().then(() => {
      if (/[?&](utm_[a-z]+|ref)=/.test(location.search)) hush.entry('link', { url: location.href });
    })
  : Promise.resolve();
```

Pass `version`, or the dashboard shows version `unknown`;
[references/install.md](references/install.md#5-create-the-hush-module), step
5, shows how to define it with Vite. For Capacitor, pass
`platform: Capacitor.getPlatform()`.

## Events and props

- **Event names** match `^[a-z][a-z0-9_]{1,63}$`: lowercase snake_case, 2 to
  64 characters, starting with a letter. Write `<object>_<past verb>`:
  `workout_completed`, `reminder_set`. The SDK drops an invalid name on the
  device.
- **Props** are one flat object of strings (at most 200 characters), finite
  numbers, booleans or `null`. Keys match `^[a-z][a-z0-9_]{0,39}$`, so
  `durationMs` is invalid and `duration_ms` is right. At most 40 keys, global
  props included, and at most 2048 bytes as JSON.
- **Any prop violation makes the server reject the whole event.** The SDK only
  warns about nesting and more than 40 keys. Check that `onFlush` reports
  `rejected: 0`.
- Pass an object or nothing as props. `null` throws.
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
  dashboard lists it as unknown. Add `ticket_replied` too when the app lets
  users reply.
- **Never track** emails, names, phone numbers, account or backend ids, text a
  user typed, precise location, or URLs and paths that carry ids.

## API cheat sheet

| Call | What it does |
|---|---|
| `configure(config)` | Sets `url`, `key` and the options. Once, before `init()`. |
| `init()` | Reads storage, sends `app_first_opened` once, starts a session and the flush timer. Returns a promise, never throws. |
| `track(name, props?, { once? })` | Queues an event. |
| `screen(name)` | Queues `screen_viewed { screen }`. |
| `entry(source, { url? })` | How the session began: `'link'`, `'notification'`, `'widget'`, `'quick_action'`, `'siri'` or another label. A link keeps only its `utm_*` and `ref` tags. |
| `identify({ rcId?, pro? })` | RevenueCat's customer id and the paid flag, sent with every batch. |
| `setGlobalProps(props)`, `removeGlobalProp(key)`, `clearGlobalProps()` | Props merged into every later event. Memory only: set them each launch. |
| `createTicket({ kind, message, email?, subject? })` | Sends feedback. `kind` is `issue`, `feature` or `love`. Returns `{ ok, id?, error? }`. |
| `listTickets()` | This install's tickets, with replies and `unread`. Marks replies read. |
| `replyToTicket(id, body)` | The user's answer. `error: 'closed'` once the ticket is closed. |
| `optOut()`, `optIn()`, `isOptedOut()` | The user's choice, remembered. Feedback keeps working. |
| `forget()` | Deletes this install's data on the server and starts over with a new id. |
| `getInstallationId()` | The install id, for a debug screen and the dashboard's Installs page. |
| `flushNow()`, `pause()`, `resume()` | Send one batch now; hold sends; send again. |
| `telemetryAvailable()` | Whether the SDK is on (a non-empty key). |

Options: `url`, `key`, `channel`, `logLevel` (`silent`, `error`, `debug`),
`onFlush`, `storagePrefix`, `runInBackground`, `attribution`. Types, defaults
and edge cases are in [references/sdk-api.md](references/sdk-api.md).

## The server side

The app is half the work. On the hush server, the operator:

- registers the app (`APPS=myapp=My App`, or `node src/cli.mjs apps:add myapp "My App"`);
- mints the keys: `node src/cli.mjs keys:create myapp prod`, and `dev`. Each
  key is printed once;
- adds every event name, a highlight, funnels and breakdowns to the app's entry
  in `CATALOG_FILE`, then restarts the server. The catalog is read at boot, and
  a bad one stops the boot.

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
- [references/attribution.md](references/attribution.md): link tags, App Store
  campaigns, SKAdNetwork and AdAttributionKit end to end, and what each can
  prove.
- [references/troubleshooting.md](references/troubleshooting.md): symptom,
  cause and fix.
