# Installing hush in an app

The procedure an agent follows to add `@bavrk/hush` to the app in the current
directory. Each step says what to read, what to change, and when to stop and
ask. The rules in [../SKILL.md](../SKILL.md) apply throughout.

## Contents

1. [Ground rules](#1-ground-rules)
2. [Detect the project](#2-detect-the-project)
3. [Get the server URL and the keys](#3-get-the-server-url-and-the-keys)
4. [Install the packages](#4-install-the-packages)
5. [Create the hush module](#5-create-the-hush-module)
6. [Wire it at the root](#6-wire-it-at-the-root)
7. [Screens](#7-screens)
8. [How sessions begin: entry()](#8-how-sessions-begin-entry)
9. [identify() with RevenueCat (optional)](#9-identify-with-revenuecat-optional)
10. [Feedback and privacy settings (optional)](#10-feedback-and-privacy-settings-optional)
11. [@bavrk/hush-expo (optional)](#11-bavrkhush-expo-optional)
12. [The prod key in release builds](#12-the-prod-key-in-release-builds)
13. [Verify](#13-verify)
14. [Report](#14-report)

## 1. Ground rules

- Change the app in the current directory only. Never commit, push, stash or
  switch branches.
- Never print the contents of `.env` files. To learn whether a variable is set,
  count it: `grep -c '^EXPO_PUBLIC_HUSH_KEY=.' .env.local`.
- Never invent a server URL or a write key, and never write a key-shaped
  placeholder (`hush_myapp_prod_REPLACE_ME`) that could ship.
- Do not start dev servers, simulators or native builds unless the user asked.
- If the app already imports `@bavrk/hush`, check its wiring against these
  steps and fix what differs. Do not add a second module.
- An app moving off an older copied hush SDK keeps its install ids only if it
  passes the old `storagePrefix` (for example `'bavrk.telemetry'`). Find the
  old prefix in the code being replaced.

## 2. Detect the project

Read `package.json`, the lockfile, `app.json` or `app.config.*`,
`tsconfig.json`, and the root layout or entry file.

| Signal in `package.json` | Project | hush entry |
|---|---|---|
| `expo` | Expo | `@bavrk/hush` |
| `expo` and `expo-router` | Expo Router; the root layout is `app/_layout.tsx` or `src/app/_layout.tsx` | `@bavrk/hush` |
| `react-native` without `expo` | Bare React Native | `@bavrk/hush`, after Expo modules |
| `@capacitor/core` | Capacitor | `@bavrk/hush/web` |
| `vite`, `next`, `astro`, `@sveltejs/kit`, or plain HTML | Web | `@bavrk/hush/web` |
| none of these (Electron, Node, a game runtime) | Other | `@bavrk/hush/core` |

Note also:

- **Package manager**, from the lockfile: `bun.lock` or `bun.lockb` (bun),
  `pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `package-lock.json` (npm). No
  lockfile: npm, unless `packageManager` in `package.json` names another.
- **Expo SDK**, from the `expo` version (`~56.0.0` is SDK 56). hush-expo needs
  it (step 11).
- **Import alias**, from `tsconfig.json` `paths` (`@/*`), so the new module is
  imported the way the project imports its own files.
- **TypeScript `moduleResolution`** on the web: `@bavrk/hush/web` resolves
  through package `exports`, so it needs `bundler`, `node16` or `nodenext`.
  With `node` or `node10` the types are not found.
- **RevenueCat** (`react-native-purchases`, `@revenuecat/purchases-capacitor`,
  `@revenuecat/purchases-js`), `expo-notifications` and `expo-linking`: they
  decide steps 8 and 9.
- **Existing analytics**: note them in the report. Do not remove them unless
  asked.

## 3. Get the server URL and the keys

Needed:

- **The server's base URL**, for example `https://hush.example.com`: https, no
  trailing slash. A path prefix (`https://example.com/hush`) works if the proxy
  forwards `/v1/*` under it.
- **A prod write key** (`hush_<app>_prod_…`), for release builds.
- **A dev write key** (`hush_<app>_dev_…`), optional, for development builds.

Tell the keys apart by their env segment: `hush_<app>_prod_…` is the prod key,
`hush_<app>_dev_…` the dev key. A `_dev_` key never goes into `PROD_KEY`, even
when it was passed as the prod key. Keys minted under an older prefix may not
follow this pattern: ask which is which.

Look for them in this order: the task or the command's arguments; the project's
env files (count, never print); the user. If the URL or the prod key is still
missing, stop and ask for it before editing anything. The user may choose to go
ahead without them:

- **Only a dev key.** Write the dev key to `.env.local`, the real URL, and
  `PROD_KEY = ''`. Release builds stay off. The prod key goes on the to-do
  list.
- **No server yet.** Write `url: ''` and an empty prod key. With an empty key
  the SDK stays off and never uses the URL, so this is safe. Both go on the
  to-do list; never write a made-up URL instead.

The operator mints keys on the server with
`node src/cli.mjs keys:create <app> prod` (and `dev`); each is printed once. See
[server.md](server.md).

A write key is not a secret. It ships inside the app, identifies the app, and
can read nothing but the calling install's own feedback. The prod key goes in
source code. The dev key goes in a gitignored env file: `.env.local` in Expo
and Vite projects (Expo's default `.gitignore` covers `.env*.local`, Vite's
`*.local`). Check `.gitignore` before writing it, and never write it to a
committed `.env`.

## 4. Install the packages

| Project | Command |
|---|---|
| Expo | `npx expo install @bavrk/hush @react-native-async-storage/async-storage expo-constants expo-device expo-localization` |
| Bare React Native | `npx install-expo-modules@latest`, then the Expo command, then `npx pod-install` and a native rebuild |
| Web, PWA, Capacitor, other | `npm install @bavrk/hush` (or `pnpm add`, `yarn add`, `bun add`) |

- `npx expo install` picks the project's package manager and versions that
  match its Expo SDK.
- `npx install-expo-modules@latest` changes the native projects. If the bare
  app has no Expo modules yet, stop and ask before running it.
- Step 8's link lines apply to every Expo app: prebuild registers the bundle id
  as a URL scheme even without a `scheme` in `app.json`, so a link can open
  any app. Add `expo-linking` with `npx expo install expo-linking` when the app
  does not have it.

## 5. Create the hush module

One module configures and starts the SDK, and re-exports it. Put it where the
project keeps such modules (`src/lib/`, `lib/`, `src/services/`). The rest of
the app imports this module, never `@bavrk/hush` directly.

Expo or React Native, `src/lib/hush.ts`:

```ts
import * as hush from '@bavrk/hush';

// The prod key ships in code: an env var read at build time can pick up a
// local .env and ship the dev key. Dev builds read theirs from .env.local,
// or stay off.
const PROD_KEY = 'hush_myapp_prod_…';

hush.configure({
  url: 'https://hush.example.com',
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : PROD_KEY,
  // Set per platform in eas.json (play, internal...). __DEV__ builds default to dev.
  channel: process.env.EXPO_PUBLIC_HUSH_CHANNEL,
  logLevel: __DEV__ ? 'error' : 'silent',
});

// Right after configure(). Calls made before it resolves are kept for it.
export const hushReady = hush.init();

export * from '@bavrk/hush';
```

- Replace the URL and `PROD_KEY` with the real values from step 3. Write `''`
  for a missing prod key, and `''` for both when the server does not exist
  yet.
- Read `process.env.EXPO_PUBLIC_…` with dot notation, as above; Expo inlines
  only that form.
- If the URL must be overridable in development, keep a string fallback:
  `url: (__DEV__ && process.env.EXPO_PUBLIC_HUSH_URL) || 'https://hush.example.com'`.
- Set `EXPO_PUBLIC_HUSH_CHANNEL` per platform in `eas.json`, under
  `build.<profile>.android.env` and `build.<profile>.ios.env`. A profile's
  top-level `env` reaches both platforms, so `play` there labels iOS builds
  `play` too.
  - Android: `play` for the store profile, `internal` for internal
    distribution.
  - iOS: `internal` for internal distribution. For the store profile,
    `app_store` without hush-expo (TestFlight users then count as App Store
    users; one binary cannot tell them apart), and nothing with it: iOS
    reports `testflight` or `app_store` itself (step 11).

Web, `src/lib/hush.ts` (Vite shown; use the framework's own env prefix):

```ts
import { createWebHush } from '@bavrk/hush/web';

const PROD_KEY = 'hush_myapp_prod_…';
const browser = typeof window !== 'undefined';

// One client per page: it owns the page's lifecycle listeners.
export const hush = createWebHush({
  version: import.meta.env.VITE_APP_VERSION,
  build: import.meta.env.VITE_APP_BUILD,
  dev: import.meta.env.DEV,
});

// Server-side rendering: configure and start in the browser only. Unconfigured,
// every call is a no-op.
if (browser) {
  hush.configure({
    url: 'https://hush.example.com',
    key: import.meta.env.DEV ? (import.meta.env.VITE_HUSH_KEY ?? '') : PROD_KEY,
    channel: import.meta.env.VITE_HUSH_CHANNEL,
    logLevel: import.meta.env.DEV ? 'error' : 'silent',
  });
}

export const hushReady = browser ? hush.init() : Promise.resolve();

// How the session began (step 8): a link with campaign tags. Held until the
// session exists.
if (browser && /[?&](utm_[a-z]+|ref)=/.test(location.search)) hush.entry('link', { url: location.href });
```

- `version` comes from the build. Without it the dashboard shows version
  `unknown`. With Vite, define it from `package.json` in `vite.config.ts`
  (create the file if the project has none, or add `define` to the existing
  `defineConfig`):

  ```ts
  import { defineConfig } from 'vite';
  import pkg from './package.json' with { type: 'json' };

  export default defineConfig({
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  });
  ```

  To set `VITE_APP_VERSION` in the build script instead, put it right before
  `vite build`. In `tsc && vite build`, a variable written before `tsc`
  reaches `tsc` only.
- Capacitor: pass `platform: Capacitor.getPlatform()` to `createWebHush()`, and
  a channel per build (`testflight`, `app_store`, `play`).
- Next.js uses `NEXT_PUBLIC_` variables and `process.env.NODE_ENV` instead of
  `import.meta.env`.
- For another runtime, `createHush()` from `@bavrk/hush/core` takes a storage,
  lifecycle callbacks, device info and a dev flag. See [sdk-api.md](sdk-api.md).

## 6. Wire it at the root

The module must be evaluated before anything tracks.

- **Expo Router:** import it first in `app/_layout.tsx`:
  `import * as hush from '@/lib/hush';`.
- **Expo without Expo Router (the blank templates, React Navigation) or bare
  React Native:** import it first in the file `package.json` `main` names
  (`index.ts`, `index.js`) or at the top of `App.tsx`.
- **Web:** import it first in the entry (`src/main.ts` or `main.tsx`) before
  rendering: `import './lib/hush';` when the entry uses nothing from it (Vite's
  templates fail the typecheck on unused imports), or the names it uses, such
  as `import { hush, screenName } from './lib/hush';`. In Next.js, import it
  from a client component rendered by the root layout.

Global props the app knows at startup (an A/B variant it assigned itself) go
right after the import: `hush.setGlobalProps({ paywall_variant: 'b' })`. They
live in memory, so set them each launch.

## 7. Screens

Name screens by route pattern. A concrete path carries ids (`item/8f3a…`,
`redeem/SPRING24`), which then land on the server.

Leave the feedback and inbox screens out. A ticket sent with an email
carries no install id, but a `screen_viewed` for the feedback route a moment
before it points at the install all the same. List the app's routes for
them in `UNTRACKED` (or report them under a name other screens share).

Expo Router, in the root layout:

```tsx
// The app's feedback and inbox routes, as screen() would name them.
const UNTRACKED = new Set(['feedback', 'support', 'support/[id]']);

const pathname = usePathname();
const segments = useSegments(); // ["(tabs)", "item", "[id]"]: the file path, not the values

useEffect(() => {
  const name = segments.filter((s) => !s.startsWith('(')).join('/') || 'home';
  if (!UNTRACKED.has(name)) hush.screen(name);
}, [pathname]);
```

React Navigation, on the container:

```tsx
const UNTRACKED = new Set(['Feedback', 'Support', 'SupportThread']);
const navigationRef = useNavigationContainerRef();
const track = () => {
  const name = navigationRef.getCurrentRoute()?.name ?? 'unknown';
  if (!UNTRACKED.has(name)) hush.screen(name);
};

<NavigationContainer ref={navigationRef} onReady={track} onStateChange={track}>
```

Web: use the router's pattern (React Router's matched route `path`, the file
route in Next.js or SvelteKit). If only a concrete path is available, replace
id-like segments before calling `screen()`. This helper, exported from the hush
module, catches numbers, UUIDs and long tokens, not short codes:
`redeem/SPRING24` passes through unchanged, so a route that takes a code needs
its router pattern or a rule of its own.

```ts
export const screenName = (path: string) =>
  path.replace(/^\/+|\/+$/g, '').split('/')
    .map((s) => (/^\d+$|^[0-9a-f-]{16,}$|^[A-Za-z0-9_-]{20,}$/i.test(s) ? '[id]' : s))
    .join('/') || 'home';
```

No router (a single-screen app or a plain page): on the web, call
`hush.screen(screenName(location.pathname))` once after the import. In a
single-screen app, skip screens and say so under Skipped.

Do not send a second, manual `screen()` for a screen the router already
reports; it counts the view twice.

## 8. How sessions begin: entry()

`entry()` says how a session began, for sessions that began somewhere other
than the home screen. Call it as soon as the app learns it. It claims the
`session_started` the SDK holds for 2.5 s after a session starts. With no
session pending it is held: the launch's first session takes it however late
`init()` resolves, and a session that starts within 2.5 s takes a later one.
Anything else is a tap inside a running session, which is not how the
session began, and is ignored.

Links and notification taps, Expo, in the root layout. Drop the notification
lines if the app has no `expo-notifications`:

```tsx
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';

useEffect(() => {
  // The link or the tap that launched the app.
  void Linking.getInitialURL().then((url) => {
    if (url) hush.entry('link', { url });
    else if (Notifications.getLastNotificationResponse()) hush.entry('notification');
  });
  // Links and taps that bring the app back. One that arrives before AppState
  // turns 'active' is held for the session that starts then.
  const subs = [
    Linking.addEventListener('url', ({ url }) => hush.entry('link', { url })),
    Notifications.addNotificationResponseReceivedListener(() => hush.entry('notification')),
  ];
  return () => subs.forEach((sub) => sub.remove());
}, []);
```

- A response listener added in an effect can miss the tap that launched the
  app, so the launch reads the last notification response.
  `getLastNotificationResponse()` exists from Expo SDK 53, and SDK 54
  deprecates the async form. On SDK 52 and older, use
  `await Notifications.getLastNotificationResponseAsync()` instead.
- The URL is never sent. Only `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term`, `utm_content` and `ref` join the session.
- A widget, a quick action or Siri: if the deep link carries a marker such as
  `?src=widget`, call `hush.entry('widget')` instead of `'link'`. Read it with
  `Linking.parse(url).queryParams`; React Native's `URL` has no working
  `searchParams` on every version.
- Web: the module in step 5 already calls `entry('link', { url: location.href })`
  when the URL has campaign tags.
- **The app is on `@bavrk/hush` 2.2.1 or older** (check `package.json`):
  upgrade it with the install command in step 4. If it must stay, `entry()`
  with no session pending does nothing there, so read the launch after
  `await hushReady`, and for a return hold the source and call `entry()`
  again from an `AppState` `'active'` listener added after `hushReady` (it
  then runs after hush's own listener has started the session). Clear the
  held source on every AppState change.

## 9. identify() with RevenueCat (optional)

`identify({ rcId, pro })` joins purchases to installs without an app user id.
Until it runs, batches carry no paid flag and the server keeps what it has.
Call it whenever RevenueCat answers:

```ts
import Purchases, { type CustomerInfo } from 'react-native-purchases';

const ENTITLEMENT = 'pro'; // the app's entitlement id

function report(info: CustomerInfo) {
  hush.identify({ rcId: info.originalAppUserId, pro: info.entitlements.active[ENTITLEMENT] !== undefined });
}

// After Purchases.configure(): RevenueCat answers from its cache quickly.
Purchases.getCustomerInfo().then(report).catch(() => {});
Purchases.addCustomerInfoUpdateListener(report);
```

- On `@bavrk/hush` 2.2.1 or older, batches say `pro: false` until it runs,
  which marks a paying install unpaid: upgrade, or, if the app keeps its own
  cached "is pro" flag, call `hush.identify({ pro: cachedPro })` in the hush
  module right after `configure()`.
- Pass `rcId` only when the app uses RevenueCat's anonymous ids. If it gives
  RevenueCat its own user ids (`Purchases.logIn()`, or `appUserID` in
  `Purchases.configure()`), `originalAppUserId` is a personal identifier: send
  `{ pro }` alone. Grep for both before wiring it.

## 10. Feedback and privacy settings (optional)

Only when the user asks for them.

A feedback screen:

- A kind picker (`issue`, `feature`, `love`), a message (required, up to 4000
  characters), an optional email (up to 160) and subject (up to 120).
- `await hush.createTicket({ kind, message, email, subject })`. On `ok: false`,
  show `error`: `offline` (try again), `too_many` (five a day per install;
  with an email, five a day per caller address), `unavailable` (no key),
  `failed`.
- The email is optional. From SDK 2.3.0 a ticket with one carries no install
  id, so the app's usage data stays not linked to the person; it needs a hush
  server with migration 007, or `createTicket` returns `failed`.
- Hide the entry point when `hush.telemetryAvailable()` is false: with an empty
  key every call returns `unavailable`.

An inbox:

- `hush.listTickets()` when the inbox opens, never at launch. It marks every
  reply read. For a badge, keep a local set of reply timestamps the user has
  seen.
- `hush.replyToTicket(id, body)`. On `error: 'closed'`, offer a new message.
- The SDK tracks `ticket_replied` for a reply (not on a ticket sent with an
  email). A hush server from before it joined the built-in names lists it as
  unknown: add it to the catalog there.

Settings rows:

- "Share anonymous usage": a switch bound to `!hush.isOptedOut()` (read it after
  `hushReady`), calling `optOut()` or `optIn()`. Feedback keeps working.
- "Delete my data": `await hush.forget()`. On `ok: false` (`offline`,
  `failed`), the install's data is still there; offer to try again (tickets
  with an email it had already deleted stay deleted). Say in the row's text
  that messages sent with an email are deleted on request at the support
  address: `forget()` reaches them only while the device holds their keys,
  and a message from a build before 2.3.0 only until the server unlinks it.

## 11. @bavrk/hush-expo (optional)

Add it for iOS ad attribution, TestFlight versus App Store channels, or
background time for the last flush. It is Expo-only and needs a dev or EAS
build; in Expo Go, on Android and on the web every function is a no-op.

1. `npx expo install @bavrk/hush-expo`. Its only peer is `expo`.
   (0.1.2 also listed `expo-modules-core`, and `npx expo-doctor` reported it
   missing. Do not install it directly: it comes with `expo`. Upgrade to
   0.1.3 or later instead.)
2. **iOS deployment target 16.4.** Its podspec requires it.
   - Expo SDK 56 and later: the default is 16.4. Nothing to do.
   - Expo SDK 52 to 55: the default is 15.1, and pod install fails. Run
     `npx expo install expo-build-properties` and add to `plugins` in
     `app.json`, merging with an existing entry:
     `["expo-build-properties", { "ios": { "deploymentTarget": "16.4" } }]`.
3. **Config plugin, only for attribution.** `npx expo install` has already
   added a bare `"@bavrk/hush-expo"` entry to `plugins`. Without attribution,
   leave it; it does nothing. For attribution, ask the user for the domain (do
   not guess it) and replace the bare entry with the array form:
   `["@bavrk/hush-expo", { "attributionEndpoint": "https://example.com" }]`.
   The value is `https://` and a host, nothing after it; prebuild fails
   otherwise. iOS keeps only the registrable domain, and the operator must
   route two `.well-known` paths on it to hush. See
   [attribution.md](attribution.md).
4. **Pass it to the SDK** in the hush module:

   ```ts
   import * as hushExpo from '@bavrk/hush-expo';

   hush.configure({
     // ...url, key, logLevel as before
     channel: hushExpo.channel() ?? process.env.EXPO_PUBLIC_HUSH_CHANNEL,
     attribution: hushExpo.attribution,
     runInBackground: hushExpo.runInBackground,
   });
   ```

   `channel()` returns `testflight` or `app_store`, and `undefined` for
   development, ad hoc and internal builds and on Android. Keep the env
   fallback.
5. **Rebuild.** Changing a config plugin needs a new native build; a JS-only
   update onto an older binary gets the no-op.

Bare React Native: the native module autolinks, but the config plugin does not
run. Set `NSAdvertisingAttributionReportEndpoint` and
`AdAttributionKit` > `AttributionCopyEndpoint` in `Info.plist` by hand.

## 12. The prod key in release builds

- Release builds use the prod key from code. Only development builds read an
  env var for the key.
- The dev key never goes into source. The prod key never goes into a dev-only
  path.
- Before a release, check the bundle, and tell the user to:
  `grep -a -o -E 'hush_[a-z0-9-]+_(prod|dev)_' <bundle> | sort | uniq -c` must
  print only `_prod_`. The bundle is `main.jsbundle` inside the archived `.app`
  for iOS, or the built `dist/` for the web (`grep -rh -a -o -E … dist`). Android
  zips it into the artifact, so pipe it out:
  `unzip -p app.aab base/assets/index.android.bundle | grep -a -o -E 'hush_[a-z0-9-]+_(prod|dev)_' | sort | uniq -c`
  (`assets/index.android.bundle` in an APK).

## 13. Verify

1. **Typecheck**: the project's `typecheck` script, or `npx tsc --noEmit`. Run
   the linter if the project has one. Fix what the change broke.
2. **Expo config**: `npx expo config --type prebuild` evaluates the config
   plugins without writing native files, and fails on a bad
   `attributionEndpoint`. To see the keys the plugin writes, without prebuild:
   `npx expo config --type introspect --json`, and read
   `ios.infoPlist.NSAdvertisingAttributionReportEndpoint` and
   `ios.infoPlist.AdAttributionKit`. `npx expo install --check` reports
   mismatched versions.
3. **Runtime** (the user runs it, unless they asked you to): set
   `logLevel: 'debug'` in development, start the app, and look for
   `[hush] ready: install <uuid>, sdk 2.3.0, channel dev` and
   `[hush] sent N: { status: 200, …, rejected: 0 }`. Put `logLevel` back to
   `'error'` afterwards.
4. **Dashboard**: switch to dev, open Installs, and paste the id from
   `getInstallationId()`. No event received after the catalog edit and restart
   should be listed as unknown. Events stored before it keep their unknown
   flag until they age out of the selected period.

## 14. Report

End with:

- **Files changed**, one line each.
- **Packages installed**, with versions.
- **Keys**: where the prod key and the dev key are read. Show a key's prefix
  only (`hush_myapp_prod_…`).
- **What the user must still do**:
  - set the server URL and the prod key, if the wiring went in with `''`;
  - mint keys, if missing;
  - add the event names to the app's catalog entry (list them; on a server
    from before `ticket_replied` became a built-in name, include it if
    replies are wired) and restart the server;
  - with hush-expo: rebuild the native app, and for attribution add
    `app_store_id` and `conversion_values` to the catalog and route the
    `.well-known` paths ([attribution.md](attribution.md));
  - set `EXPO_PUBLIC_HUSH_CHANNEL` per platform in `eas.json`
    (`build.<profile>.android.env`, `build.<profile>.ios.env`), not in a
    profile's top-level `env`;
  - update the privacy policy and the store's privacy answers (SKILL.md, "App
    Privacy answers"): Usage Data (Product Interaction), not linked; when the
    feedback form asks for an email, Contact Info (Email Address) and User
    Content (Customer Support), linked; none of it used for tracking. Without
    an email field, Customer Support is not linked either.
- **Anything skipped**, and why.
