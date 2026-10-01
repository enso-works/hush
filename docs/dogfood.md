# Dogfood log

hush runs our own apps first. Everything awkward we hit while using it goes
here, newest first, with what was done about it. It is the fix list before
anything else, and later the evidence for what a hosted hush has to be.

Format: date, app, what happened, status (fixed in `<commit>`, open, app-side).

## 2026-10-01

- **Braele.** Braele declares its usage data "Not linked to you" on the App
  Store, but a ticket with an email also carried the install id and
  RevenueCat's id. The dashboard's install page, the alert mail and the
  `ticket_opened` event (same install, same moment) each joined the person who
  wrote to that install's events, so the answer was not true for anyone who
  wrote to support with an email. Braele 2.1.0 adds a "How did you find
  Braele?" answer to every event, which makes it matter more. Fixed in
  `3343a95` (server, migration 007), `1dc440c` (dashboard) and `d6d9912`
  (SDK 2.3.0): a ticket with an email carries neither id, the app holds a key
  for that ticket instead, and a ticket from an older app version loses the
  install id when it is closed or idle for 30 days.
- **Braele, app-template, open.** They move to SDK 2.3.0, and their App
  Privacy answers and the hush docs site follow, once 2.3.0 is published.

Wiring Braele to SDK 2.2.1 and hush-expo 0.1.2 meant following four timing
rules from the README, and an audit of the SDK against them found more. All
fixed in `b8b4df2` (SDK 2.2.2) unless marked otherwise.

- **Braele.** A link or widget that opened the app was lost when `entry()`
  ran before `init()` resolved, and a warm return's link arrives before
  `active`. The SDK now holds an early `entry()` for its session.
- **Braele.** A cold launch was spread over two session ids: events tracked
  before `init()` and `app_first_opened` carried one, `session_started`
  another. They share one now, and the start sorts first.
- **Braele.** An event tracked before `init()` could overwrite the last
  launch's unsent queue on disk. Nothing is written until `init()` has
  merged it.
- **Braele.** Batches said `pro: false` until `identify()` ran, which marked
  a paid install unpaid. The flag is left out until the app says.
- **Braele.** `configure({ url: undefined })` (an env variable unset in one
  build profile) threw at startup, and so did `track(name, null)`. A missing
  url now turns the SDK off and says so; null props count as none.
- **Braele.** Every ticket reply showed under unknown events:
  `ticket_replied` was not a built-in name. Fixed in `54e11a2`: it is one,
  and migration 006 marks the stored rows known.
- **hush SDK.** `forget()` did not wait for a send in flight, and a send
  removed events by position: the old install's events could land after the
  delete, and new ones were dropped. A privacy choice made before `init()`
  had read storage was lost. A circular prop (a press event) stopped every
  send for the rest of the launch. A delivered batch reached the disk a
  second late, so a process killed right after sent it again.
- **hush SDK, documented.** A cold relaunch always starts a new session, even
  minutes after the last one; only a live process continues one within 30
  minutes. The README now says so.
- **Braele.** `npx expo-doctor` reported `expo-modules-core` as a missing
  peer of hush-expo. Fixed in `62f9801` (hush-expo 0.1.3): its only peer is
  `expo`.
- **Braele, open.** The hush docs site (hush.bavrk.com/docs) still describes
  the 2.2.1 rules; it is updated with the 2.2.2 release.

## 2026-09-30

- **ops, operator.** The dashboard needed its own sign-in on ops, next to the
  cockpit's. Fixed: a trusted proxy header (`ADMIN_PROXY_HEADER`) and
  `/admin/session`, so ops opens it signed in; admin writes are same-origin
  JSON only.
- **ops, operator.** The cockpit hardcoded Braele's charts (pattern, intent,
  voice...). Fixed: catalog `breakdowns`, pinned per app from config.
- **ops, operator.** The Revenue panel read RevenueCat's metric list as an
  object, labelling tiles 0, 1, 2. Fixed, with RevenueCat's charts, a refresh
  button and freshness; revenue is on the overview cards.
- **Braele, app-side, open.** RevenueCat has $19 and 4 purchases in 28 days,
  hush saw no `purchase_started` or `purchase_result` at all. The purchase
  path does not track, or tracks under another name.
- **Braele, app-side, open.** `breathing_session_started.voice` has a `true`
  value next to voice names and `off`, and `.ambient` a `false`: an older
  build sent booleans. Harmless, but it splits the chart.
- **Braele, app-side, open.** `diagnostic_ping` arrives and is not in the
  catalog: add it, or stop sending it from release builds.
- **dashboard.** "1 installs". Fixed: counts are singular at one.
- **tennis game, open.** `listTickets()` marks every reply read on the server
  as it fetches, so an app cannot check for replies at launch (for a badge)
  without losing the unread state before anyone looked. Rallo keeps its own
  unseen set in localStorage. Wanted: a peek, or an explicit `markRead(id)`.
- **tennis game.** Picking event names meant writing the catalog first, then
  finding two more while wiring (`practice_finished`, `lesson_skipped`) that
  showed as unknown until the catalog caught up. The unknown-events warning did
  its job; a CLI `catalog:check <app>` against a code grep would catch it earlier.
- **tennis game.** No way to use hush from a web or Capacitor app: the npm
  package was React Native only and /v1 answered no CORS. Fixed:
  `@bavrk/hush/web` (2.1.0) and CORS on /v1.
