# Troubleshooting

Symptom, cause, fix. Start with `logLevel: 'debug'` in a development build: the
SDK logs `[hush] ready: …` once, and `[hush] sent N: { status, accepted,
duplicate, rejected, willRetry }` after every send.

## Contents

1. [Nothing arrives](#1-nothing-arrives)
2. [Data lands in the wrong place](#2-data-lands-in-the-wrong-place)
3. [Events rejected or unknown](#3-events-rejected-or-unknown)
4. [Sessions, entries and pro](#4-sessions-entries-and-pro)
5. [Feedback](#5-feedback)
6. [Attribution](#6-attribution)
7. [Install and build errors](#7-install-and-build-errors)
8. [The server](#8-the-server)

## 1. Nothing arrives

| Symptom | Cause | Fix |
|---|---|---|
| No `[hush] ready` log | `init()` never ran, ran before `configure()`, or the url or key is empty or missing (the SDK is off). `logLevel: 'error'` names a missing url or key; an empty-string key, the deliberate off switch, is logged only at `debug`. | Call `configure()` and then `init()` in one module that the root imports. Check `telemetryAvailable()`. |
| Nothing sent from release builds, `[hush] url is missing or not a string` | `url` came from an env variable that build profile does not set. | Give it a string fallback: `process.env.X ?? 'https://…'`. |
| App crashes at startup with a TypeError in `configure` | SDK 2.2.1 or older, and `url` is `undefined` (an unset env var). | Upgrade to 2.2.2, which turns the SDK off instead; and pass a string. |
| `sent N: { status: 401 }` | Wrong or revoked key. The SDK drops the batch; those events are lost. | Mint a new key (`keys:create`) and ship it. A revoked key keeps working for up to a minute. |
| `sent N: { status: 'offline', willRetry: true }` | The device cannot reach the URL: a typo, `http://` from a device, a LAN address, or a proxy that does not forward `/v1/*`. | `curl https://<server>/healthz` from outside. Route `/v1/*` publicly. |
| Works in development, nothing from release builds | The prod key is empty in code, or the release reads an env var that was not set. | Put the prod key in code for release builds. Check the bundle (section 2). |
| Web: nothing at all | The site's Content-Security-Policy `connect-src` does not allow the hush origin (the console shows a CSP violation). Or `configure()` and `init()` ran only during server rendering. | Add the hush URL to `connect-src`. Call `configure()` and `init()` in the browser. |
| Web: nothing from some browsers | A content or ad blocker blocks the hush host. | Expected. Those visitors are not counted. |
| Web: installs inflated, many one-visit installs | `localStorage` refused (private mode, a sandboxed frame): the SDK keeps its id in memory, so every load is a new install. Events are still sent. | Expected in private modes. |
| Events tracked at launch are missing, or a previous launch's events vanish | SDK 2.2.1 or older: events tracked more than about a second before `init()` resolved overwrote the stored queue. | Upgrade to 2.2.2. Until then, call `init()` right after `configure()`, before any tracking. |
| About twice as many session ids as `session_started` events | SDK 2.2.1 or older: events tracked before `init()` resolved, and `app_first_opened`, carried an id of their own. | Upgrade to 2.2.2. Count sessions by `session_started` for data sent before it. |

## 2. Data lands in the wrong place

| Symptom | Cause | Fix |
|---|---|---|
| Prod dashboard empty; the data is under the dev switch | A release build shipped the dev key: `EXPO_PUBLIC_*` or `VITE_*` inlined a local `.env`. | Prod key in code for release; env only in development. Check the bundle: `grep -a -o -E 'hush_[a-z0-9-]+_(prod\|dev)_' <bundle> \| sort \| uniq -c` must show only `_prod_`. Data cannot be moved between prod and dev. |
| TestFlight or dev builds count as store users | `channel` hardcoded to `app_store`, or a dev build on the prod key. | `hushExpo.channel() ?? process.env.EXPO_PUBLIC_HUSH_CHANNEL`. Filter the dashboard by channel. |
| Channel `unknown` | No channel sent: no hush-expo, Android without `EXPO_PUBLIC_HUSH_CHANNEL`, an iOS ad hoc or internal build, or an app on an SDK older than 2.0. | Set the env var per platform in `eas.json` (`build.<profile>.android.env`, `build.<profile>.ios.env`). |
| Channel logged as "not a short snake_case label" | The value does not match `^[a-z][a-z0-9_]{0,23}$`. | Use `app_store`, `testflight`, `play`, `internal`. |
| Every user became a new install after an update | `storagePrefix` changed, or the app moved off a copied SDK without passing its old prefix. | Restore the old prefix. Installs counted in between stay counted. |
| Version shows `unknown` or empty | Web: `version` not passed to `createWebHush()`. Bare React Native: `expo.version` and build numbers missing from `app.json`. | Pass the version; keep `app.json` in step with the native project. |

## 3. Events rejected or unknown

| Symptom | Cause | Fix |
|---|---|---|
| `onFlush` reports `rejected > 0` | A prop key is not snake_case (`durationMs`), a string is over 200 characters, more than 40 keys (globals included), over 2 KB, or `screen()` got a name over 200 characters. The whole event is dropped. | Fix the props. The key count is warned about on the device. |
| An event never arrives, `[hush] event "x" prop "y" is not a string, number, boolean or null` | A prop value is an object or an array (a press event, a navigation object). The SDK drops the event on the device; the server would reject it. A global prop like that is not set. | Pass flat values. SDK 2.2.1 and older send it, and a circular one stops every send for the rest of the launch. |
| An event never appears; `logLevel: 'error'` says "is not snake_case" | The name breaks `^[a-z][a-z0-9_]{1,63}$` (`'Purchase Completed'`, `'x'`). Dropped on the device. | Rename. |
| An event is listed as unknown | Its name is not in the app's catalog entry, or is misspelled; or the server was not restarted after the edit. The flag is stored with each event as it arrives. | Add it to `events`, validate, restart. Only events received after the restart count as known; those already stored keep the flag until they age out of the selected period. `ticket_replied` is a built-in name; a server from before that lists it as unknown: update it (its migration marks the stored replies known) or add it to the catalog. |
| `track(name, null)` throws | SDK 2.2.1 or older: props must be an object or omitted. | Upgrade to 2.2.2, or call `track(name)`. |
| One prop splits into two sets of values | Different builds send different types (`true` and `'calm'`). | Keep one type per prop. |

## 4. Sessions, entries and pro

| Symptom | Cause | Fix |
|---|---|---|
| Every session has `entry: 'launch'`, no campaign tags | `entry()` is never called, or more than 2.5 s after the session began. With SDK 2.2.1 or older, also when it ran before `init()` resolved. | Call `entry()` as soon as the app has the link ([install.md](install.md#8-how-sessions-begin-entry)). On 2.2.1 or older, upgrade, or `await hushReady` first. |
| A link that brings the app back does not tag the session | Back within 30 minutes is the same session; `entry()` is ignored. | Expected. |
| A link or notification tap that brings the app back after 30 minutes does not tag the new session | SDK 2.2.1 or older: the listener called `entry()` before AppState turned `active`, when hush starts the session, and it was dropped. | Upgrade to 2.2.2, which holds it for the session. Until then, hold the source and call `entry()` again on the next `active` ([install.md](install.md#8-how-sessions-begin-entry)). |
| Paying installs show as unpaid | SDK 2.2.1 or older: batches before `identify({ pro })` say `pro: false`. With 2.2.2, `identify()` never runs. | Upgrade to 2.2.2, which leaves the flag out until `identify()`. Call `identify()` when RevenueCat answers. |
| `isOptedOut()` returns `false` for a user who opted out | Read before `init()` loaded storage. | Read it after `hushReady`. |
| A user's opt-in or opt-out at startup is undone | SDK 2.2.1 or older: a choice made before `init()` read storage lost to the stored one. | Upgrade to 2.2.2, where the newer choice wins. |
| Events of a forgotten install reappear on the server | SDK 2.2.1 or older: a batch in flight during `forget()` landed after the delete. | Upgrade to 2.2.2, where `forget()` waits for it. |
| `rc_id` looks like the app's own user id | The app calls `Purchases.logIn()` with its ids. | Send `identify({ pro })` without `rcId`. |

## 5. Feedback

| Symptom | Cause | Fix |
|---|---|---|
| `createTicket` returns `unavailable` | Empty key (development without a dev key). | Mint a dev key and put it in the gitignored `.env.local`. |
| `createTicket` returns `failed` | Validation: empty message, over 4000 characters, subject over 120, a malformed email, or an install id that belongs to another app. With an email on SDK 2.3.0: a server without migration 007, which wants an install on every ticket. | Validate in the form. Update the server; the SDK never resends a ticket with an email with the install id. |
| A ticket sent with an email is missing from `listTickets()` | Its thread key is gone from the device: the app was reinstalled, `storagePrefix` changed, or `forget()` ran. On an app before 2.3.0: the ticket was closed or idle for 30 days, which unlinks it from the install. | Nothing to fix: the reply still reaches the person by email. |
| `too_many` | Five tickets per install per day, or 20 replies per ticket per day, or the per-address rate limit. | Tell the user to try tomorrow. |
| Unread badge never shows, or clears on its own | `listTickets()` marks every reply read as it fetches; calling it at launch clears `unread` before anyone looked. | Fetch when the inbox opens. For a badge, keep a local seen-set. |
| `replyToTicket` returns `closed` | The operator closed the ticket. | Offer a new message. |
| No alert mail for new feedback | `RESEND_API_KEY`, `MAIL_FROM` or `ALERT_EMAIL` unset, or more than 30 alerts this hour. | Tickets are stored regardless; check the dashboard. |

## 6. Attribution

| Symptom | Cause | Fix |
|---|---|---|
| No conversion values set | `attribution` not passed to `configure()`; the user opted out; Expo Go or Android (no-op); the milestones are cached for 12 hours; `/v1/config` returns an empty list. | Pass `hushExpo.attribution`; check `GET /v1/config`. |
| `conversion value not set` in the log | Neither SKAdNetwork nor AdAttributionKit took the value. On the simulator SKAdNetwork refuses; the message appears unless AdAttributionKit (iOS 17.4 and later) accepts. | Test on a device. The SDK retries at the next matching milestone. |
| A lower milestone is never reported | A higher one was reached first: values only rise. | Reorder the ladder ([attribution.md](attribution.md#4-designing-conversion-values)). |
| No postbacks on the dashboard | No `app_store_id` in the catalog (postbacks are stored under no app); the `.well-known` routes are not public or point at the website; `attributionEndpoint` is not on the registrable domain; the build has no endpoint in `Info.plist`; or they are Apple's test postbacks, shown only under dev. | Check each; `curl -X POST -d '{}'` to the route must reach hush. |
| Unverified postbacks counted as zero | They are stored and never counted, by design. | Nothing to fix unless every postback is unverified; then check the proxy is not rewriting bodies. |
| App Store campaigns empty | `ASC_*` unset, or `ASC_PRIVATE_KEY_FILE` not mounted into the container; `asc:request` never ran; no `app_store_id`; the first data takes a day or two; under five users are hidden. | Set, request, wait; `asc:sync <app>` by hand. |

## 7. Install and build errors

| Symptom | Cause | Fix |
|---|---|---|
| Metro cannot resolve `@react-native-async-storage/async-storage` or `expo-*` | The optional peers were not installed. | `npx expo install @react-native-async-storage/async-storage expo-constants expo-device expo-localization`. |
| A web build fails on `react-native` imports | The app imports `@bavrk/hush` instead of `@bavrk/hush/web`. | Import from `@bavrk/hush/web`. |
| TypeScript cannot find `@bavrk/hush/web` types | `moduleResolution` is `node` or `node10`. | Use `bundler`, `node16` or `nodenext`. |
| `pod install` fails: hush-expo needs a higher deployment target | Expo SDK 52 to 55 defaults to iOS 15.1; hush-expo needs 16.4. | `expo-build-properties` with `ios.deploymentTarget: '16.4'`, then prebuild. |
| Prebuild fails: `attributionEndpoint is https://<domain>, nothing after it` | A path, port or trailing slash in the option. | `https://example.com` exactly. |
| `npx expo-doctor`: missing peer dependency `expo-modules-core`, required by `@bavrk/hush-expo` | hush-expo 0.1.2 or older lists `expo-modules-core` as a peer. It ships inside `expo`. | Upgrade to `@bavrk/hush-expo` 0.1.3 or later. Do not install `expo-modules-core` directly: doctor then fails because it is installed directly. |
| hush-expo does nothing | Expo Go, Android, web, or a JS update onto a binary built before it was added. | Make a new dev or EAS build. |
| Bare React Native: crash on import of `expo-constants` | No Expo modules in the project. | `npx install-expo-modules@latest`, `npx pod-install`, rebuild. |

## 8. The server

| Symptom | Cause | Fix |
|---|---|---|
| The server does not start after a catalog edit | The catalog failed to parse; the log names the path. | Validate it ([server.md](server.md#6-validate-a-catalog)) and fix. |
| The server does not start: `APPS: "…" is not slug=Name` | A malformed `APPS` entry. | Slugs match `^[a-z][a-z0-9-]{0,39}$`. |
| The Campaigns panel errors (500) | `"funnels": []` in the catalog. | Omit the key. |
| `keys:create` says unknown app | The app is not registered. | `apps:add` or `APPS`, then create the key. |
| A variable set in `examples/.env` has no effect | `PORT` is not passed through: the container listens on 3000. `TELEMETRY_ADMIN_TOKEN` is not either. Or the compose file in use lacks the variable in its `environment:` block. | Set `HUSH_PORT` for the host port, and `ADMIN_TOKEN` for the token. Add the missing variable to `environment:`. |
| `/healthz` returns 503 | Postgres is down or unreachable. | Check `DATABASE_URL` and the database. |
| `/v1` returns 403 `demo instance` | The server runs with `DEMO=1`. | Point apps at a server without it. |
