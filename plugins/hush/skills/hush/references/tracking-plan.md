# Planning what an app tracks

How to choose an app's events, props, once-events, highlight, funnels,
breakdowns and conversion values, and how to hand the plan back as a catalog
entry. The naming rules and limits are in [../SKILL.md](../SKILL.md).

## Contents

1. [Start from the questions](#1-start-from-the-questions)
2. [Read the app](#2-read-the-app)
3. [Events](#3-events)
4. [Props](#4-props)
5. [Once-events and global props](#5-once-events-and-global-props)
6. [The highlight](#6-the-highlight)
7. [Funnels](#7-funnels)
8. [Breakdowns](#8-breakdowns)
9. [Conversion values](#9-conversion-values)
10. [What never to track](#10-what-never-to-track)
11. [The plan to hand back](#11-the-plan-to-hand-back)
12. [Template catalog entry](#12-template-catalog-entry)

## 1. Start from the questions

Every event answers a question the owner will ask. The usual ones:

- Do new installs reach the thing the app is for? (activation)
- Where do they drop off on the way? (funnels)
- Do they come back? (retention)
- What do they pick when they have a choice? (breakdowns)
- Does the paywall sell, and from where? (the paywall funnel)
- Which campaigns bring installs that stay and pay? (campaigns, conversion
  values)

hush already answers some without any app event: installs, sessions and their
number per install, foreground time, screens (once `screen()` is wired),
retention cohorts, versions, channels, countries, and how sessions began
(`entry`). Do not re-track those.

Aim for 5 to 15 app events. A small set that covers the core loop end to end is
worth more than a long list with holes.

## 2. Read the app

- **Navigation**: the route tree (`app/` with Expo Router), tabs, modals.
- **The core loop**: the thing users come for (a workout, a breath, a match, a
  note), where it starts, and every way it ends: finished, cancelled, closed,
  interrupted.
- **Onboarding**: its steps and the choices it asks for.
- **Money**: the paywall, where it opens from, the purchase and restore code
  (RevenueCat), and any way to unlock without the paywall (offer codes,
  promotions).
- **Habits**: reminders, streaks, widgets, notifications.
- **Entry points**: deep links, widgets, quick actions, notification taps.
- **Existing tracking**: every current call and its name. Keep names that work;
  a rename splits the dashboard's history.

## 3. Events

- **Name what happened**, as `<object>_<past verb>`: `onboarding_completed`,
  `workout_started`, `reminder_set`, `export_failed`.
- **One event per outcome, not per tap.** A tap is an event only when the tap
  is the outcome (share, export).
- **Pair the core action**: `<core>_started` and `<core>_completed`, with a
  `completed` boolean and, when it ended early, an `ended` reason
  (`'cancel'`, `'close'`, `'interrupted'`). Every exit path sends the second
  event, or starts look abandoned.
- **One name, a discriminating prop**, for many small things:
  `feature_used { feature: 'share' }`, `setting_changed { setting: 'sound' }`.
- **The paywall** uses the names hush expects: `paywall_viewed { placement }`,
  `purchase_started { product }`,
  `purchase_result { result: 'purchased' | 'cancelled' | 'failed', product }`,
  `restore_result { result }`. Track the paths that bypass it too: no products
  loaded (`purchase_unavailable`), an unlock by offer code (`pro_unlocked { via }`).
- **Failures the user feels**, with a short code: `sync_failed { reason: 'offline' }`.
  Never the error message text.
- **Never** track `app_first_opened`, `session_started`, `screen_viewed`,
  `ticket_opened` or `ticket_replied`: the SDK sends them.

## 4. Props

- Props answer "which" and "how much": `kind`, `source`, `placement`,
  `product`, `count`, `duration_s`, `completed`.
- Keys are snake_case and carry the unit: `duration_s`, `size_kb`.
- A choice from a fixed set is a short string; a quantity is a number; a
  yes or no is a boolean. Keep one type per prop across builds: a prop that is
  `true` in one build and `'calm'` in the next splits every chart.
- `source` tells apart the places one event happens:
  `intent_selected { source: 'onboarding' | 'settings' }`.
- A number used as a breakdown gives one row per value; the dashboard shows the
  top 20. Send a bucket (`'1-5'`, `'6-10'`) as well when the split matters.
- At most 40 keys including global props, 2 KB, strings up to 200 characters.
  One violation rejects the whole event.

## 5. Once-events and global props

- `track(name, props, { once: true })` for a per-install milestone that code
  might fire twice: `onboarding_completed`, `tutorial_finished`.
- `{ once: 'key' }` for once per key: `tip_seen { tip: 'streaks' }` with
  `{ once: 'streaks' }`.
- The SDK remembers the last 200 keys across launches. `forget()` resets them.
- Repeated actions (every workout) are not once-events. "First workout" is a
  funnel over the repeated event, not a separate event.
- Global props carry context to slice everything by: an A/B variant the app
  assigned itself, an onboarding flow version. Set them each launch, right
  after the hush module loads.

## 6. The highlight

One event the dashboard counts per period: the core action.
`done_prop` names its boolean prop that marks it finished, which gives a
completion rate:

```json
"highlight": { "event": "workout_completed", "done_prop": "completed" }
```

## 7. Funnels

- Up to 10 funnels, 2 to 8 steps each. Steps are ordered, and each must happen
  within `window_days` (1 to 90, default 7) of the first.
- A step is an event name, or `{ event, where, label }` with 1 to 3 props
  compared as text.
- Useful shapes:
  - **First run**: `app_first_opened` → `onboarding_completed` →
    `<core>_started` → `<core>_completed { completed: true }`, window 1.
  - **Paywall**: `paywall_viewed` → `purchase_started` →
    `purchase_result { result: 'purchased' }`, window 3.
  - **Habit**: `<core>_completed` → `reminder_set`, window 7.
- A `funnels` list replaces the default Paywall funnel. Include a Paywall
  funnel in it when the app has a paywall.
- The Campaigns panel runs a catalog funnel from each install's first tagged
  session, dropping a leading `app_first_opened` or `session_started`.
- Omit `funnels` rather than writing `[]`.

## 8. Breakdowns

- Up to 12. One event split by one prop, pinned to the app's page.
- `count: 'installs'` for an answer that belongs to the install and can change
  later (a goal chosen in onboarding, a plan). `count: 'events'` (the default)
  for volumes.
- Pick the splits the owner will look at every week: the core action by kind,
  the paywall by placement, purchases by product, `session_started` by
  `entry`, how the core action ended.

## 9. Conversion values

Only for iOS apps that run ads on networks using SKAdNetwork or
AdAttributionKit, with `@bavrk/hush-expo` installed and the App Store id known.

- Build the ladder from events already in the plan, highest value for the most
  valuable milestone (the purchase), coarse `low` to `high` never going down,
  `lock: true` on the last.
- Values only rise. A milestone that can happen before a lower one hides it.
  Check the order against the app's real flow.
- The rules and an example are in
  [attribution.md](attribution.md#4-designing-conversion-values).

## 10. What never to track

- Personal data: email, name, phone, address, birthday, photos.
- Account, backend or user ids; RevenueCat ids set through `Purchases.logIn()`.
- Text a user typed: search queries, notes, messages, titles of things they
  made. Feedback goes through `createTicket()`, never through events.
- Precise location. The server adds a country when the operator configures it.
- URLs, paths or screen names that carry ids, codes, tokens or emails.
- Raw values from sensitive categories (health measurements, finances).
  Track that an action happened, not the measurement.
- Anything the app's privacy policy does not cover.

## 11. The plan to hand back

1. **Questions** the plan answers, in one line each.
2. **Events**, one row each:

   | Event | Sent when (file) | Props | Once | Status |
   |---|---|---|---|---|
   | `onboarding_completed` | last onboarding step (`app/onboarding.tsx`) | `goal: 'strength' \| 'cardio'` | yes | new |
   | `workout_completed` | every end of a workout (`app/workout.tsx`) | `kind`, `duration_s`, `completed: boolean`, `ended?` | no | exists, add `ended` |

3. **Global props**, if any.
4. **The catalog entry** (section 12), ready to paste into `CATALOG_FILE`.
5. **Changes to existing tracking**, with the reason for each rename.
6. **Open questions** for the owner.

Wire `track()` calls only when asked. Then call them through the app's hush
module, and list every new name for the catalog.

## 12. Template catalog entry

Replace `myapp` with the app's slug on the hush server (the `<app>` in its write
keys, `hush_<app>_prod_…`, or its `APPS` entry; it need not match the Expo
slug) and the names with the plan's. Common names
(`app_first_opened`, `session_started`, `screen_viewed`, `paywall_viewed`,
`purchase_started`, `purchase_result`, `restore_result`, `ticket_opened`,
`ticket_replied`) need not be listed. A server from before `ticket_replied`
joined them needs it listed when users can reply.

```json
{
  "myapp": {
    "events": [
      "onboarding_completed",
      "workout_started",
      "workout_completed",
      "reminder_set",
      "feature_used",
      "purchase_unavailable"
    ],
    "highlight": { "event": "workout_completed", "done_prop": "completed" },
    "funnels": [
      { "name": "First workout", "window_days": 1, "steps": [
        "app_first_opened", "onboarding_completed", "workout_started",
        { "event": "workout_completed", "where": { "completed": true }, "label": "Finished a workout" }
      ] },
      { "name": "Paywall", "window_days": 3, "steps": [
        "paywall_viewed", "purchase_started",
        { "event": "purchase_result", "where": { "result": "purchased" }, "label": "Purchased" }
      ] },
      { "name": "Habit", "steps": [
        { "event": "workout_completed", "where": { "completed": true }, "label": "Finished a workout" },
        "reminder_set"
      ] }
    ],
    "breakdowns": [
      { "event": "workout_completed", "prop": "kind", "title": "Workouts by kind" },
      { "event": "workout_completed", "prop": "ended", "title": "How workouts end" },
      { "event": "onboarding_completed", "prop": "goal", "title": "Goals", "count": "installs" },
      { "event": "paywall_viewed", "prop": "placement", "title": "Where the paywall opens" },
      { "event": "purchase_result", "prop": "product", "title": "Purchases by product" },
      { "event": "session_started", "prop": "entry", "title": "How sessions begin" }
    ],
    "private_screens": ["feedback", "support"]
  }
}
```

`private_screens` names the app's feedback and inbox screens as `screen()`
reports them: the server stores no view of them, or of a screen under one.
Leave it out for an app without feedback.

Once the App Store record exists, add `app_store_id` and `conversion_values`
([attribution.md](attribution.md)). Validate the file before deploying it
([server.md](server.md#6-validate-a-catalog)), and restart the server.
