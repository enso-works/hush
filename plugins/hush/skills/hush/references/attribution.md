# Where installs come from

hush has three sources, all aggregated. None of them fingerprints anyone, reads
an advertising id, or needs an App Tracking Transparency prompt.

## Contents

1. [Link tags](#1-link-tags)
2. [App Store campaigns](#2-app-store-campaigns)
3. [SKAdNetwork and AdAttributionKit](#3-skadnetwork-and-adattributionkit)
4. [Designing conversion values](#4-designing-conversion-values)
5. [Testing attribution](#5-testing-attribution)
6. [What each source can and cannot prove](#6-what-each-source-can-and-cannot-prove)

## 1. Link tags

A link with `utm_*` tags opens the app or the page, and the app passes it to
`entry('link', { url })`.

- **App side.** As soon as the app has the link:
  `hush.entry('link', { url })`. Before the session exists it is held for it
  (SDK 2.2.1 and older: only after `init()` has resolved, within 2.5 s). On
  the web, only when the page URL has tags (see [install.md](install.md),
  step 8).
- **What is kept.** `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
  `utm_content` and `ref`, each cut to 64 characters, on that session's
  `session_started`. The URL itself, click ids and anything else are dropped.
- **Dashboard.** The Campaigns panel counts each install once, for its first
  tagged session, split by any of the six tags, and runs a catalog funnel from
  that session on.
- **A Meta ad's URL parameters:**
  `utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}`.
- **Scope.** On the web this covers the whole path from the ad. On iOS a link
  opens only an app that is already installed: the App Store does not pass the
  link into a new install. hush does not read Android's Play Install Referrer.

## 2. App Store campaigns

App Store Connect counts page views, first downloads, sessions and proceeds per
campaign link (`https://apps.apple.com/app/id<id>?pt=<provider token>&ct=<campaign>`).
hush imports those reports.

1. Set `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY` (the `.p8`
   contents inline, `\n` allowed) or `ASC_PRIVATE_KEY_FILE` (a path inside the
   container; mount the file there). Keep the `.p8` out of git.
2. Put the app's `app_store_id` in the catalog, and restart.
3. Run `node src/cli.mjs asc:request <app>` once, with a key that has the Admin
   role. After that the key needs only Sales and Reports.
4. The first data arrives a day or two later. The server syncs every 6 hours
   (the first run 2 minutes after boot); `asc:sync [app]` runs it by hand.

Apple hides anything under five users and adds noise.

## 3. SKAdNetwork and AdAttributionKit

When an ad network wins an install, Apple sends it a postback naming the
campaign and a conversion value the app set. With an endpoint in the app's
`Info.plist`, iOS sends the developer a copy. hush receives those copies,
verifies Apple's signature, and counts them. The SDK sets the conversion value
from milestones in the catalog.

End to end:

1. **Catalog.** Add `app_store_id` (required: postbacks are matched to an app
   only by it; without it they are stored under no app and never shown) and
   `conversion_values` (section 4). Restart the server.
2. **Proxy.** On the registrable domain named in `attributionEndpoint`, or
   in the two Info.plist keys without the config plugin (iOS keeps only the
   eTLD+1, so `https://www.example.com` posts to `example.com`), route these
   publicly to hush:
   - `POST /.well-known/skadnetwork/report-attribution/`
   - `POST /.well-known/appattribution/report-attribution/`

   They take no key: Apple's signature is the proof. A trailing slash is fine.
   Any JSON object gets a 200.
3. **App.** Install `@bavrk/hush-expo`, add its config plugin with
   `attributionEndpoint`, make sure the iOS deployment target is 16.4 or later,
   pass `attribution: hushExpo.attribution` to `configure()`, and make a new
   native build ([install.md](install.md), step 11). In a Capacitor app:
   install `@bavrk/hush-capacitor` and run `npx cap sync ios`, write
   `NSAdvertisingAttributionReportEndpoint` and `AdAttributionKit` >
   `AttributionCopyEndpoint` in `Info.plist` by hand (no config plugin; the
   same `https://` and host), pass `attribution: hushCapacitor.attribution`,
   and make a new native build; iOS 15 or later.
4. **Ad network.** Enter the same milestone table there (Meta: Events Manager,
   the app's SKAdNetwork settings), so it reads the values the way hush does.
5. **Dashboard.** The Attribution panel counts verified postbacks only, by
   campaign and by value. Apple's development and test postbacks show under the
   dev switch.

What the SDK does:

- At the first `init()` of a user who has not opted out, it registers the
  install with value 0 (coarse `low`), once.
- With remote config on (the default from SDK 2.4.0), the milestones come
  with the config request: at every `init()`, and at each config refresh (in
  the foreground, at most every `refreshMinutes`, 15 by default). A changed
  table reaches an app at its next launch or refresh. With
  `remoteConfig: false`, or SDK 2.2 and 2.3, it fetches `GET /v1/config` on
  its own and caches the milestones for 12 hours, so a changed table
  reaches installed apps up to 12 hours later.
- For 35 days from registration, each queued event that matches a milestone
  (the event name, and every `where` prop equal as text) raises the value to the
  highest matching milestone above the current one. **It never lowers the
  value.**
- Up to 50 events seen before the milestones arrive are checked once they do.
- A milestone with `lock: true` locks the current window.
- It sets the SKAdNetwork value and, on iOS 17.4 and later, the AdAttributionKit
  value. Nothing about this is sent to hush. `forget()` keeps the state;
  `optOut()` stops it.

How hush verifies:

- SKAdNetwork postbacks against Apple's P-256 key. A test postback with
  `source-app-id` 0 is marked development.
- AdAttributionKit postbacks are JWS, verified by `kid`:
  `apple-cas-identifier/0` is production;
  `apple-development-identifier/0` and `/1` are development. Only the JWS is
  signed: the conversion values sent beside it are not.
- Unverified postbacks are stored and never counted. Duplicates are merged by
  transaction or postback id.

## 4. Designing conversion values

A conversion value is 0 to 63 (fine) plus `low`, `medium` or `high` (coarse).
Apple reports it per install to the ad network, and in aggregate to you.

- **Values only rise.** The SDK skips any milestone at or below the current
  value. If a higher milestone can happen before a lower one, the lower one is
  never reported for that install. Example: "saw the paywall" at 16 and
  "finished a session" at 8. A user who taps a locked feature first reaches 16,
  and their finished session is never counted. Order milestones so each one can
  only follow the ones below it, or accept what the higher one hides.
- **Highest means most valuable.** Put a purchase or a subscription start at
  the top. Put early signs of a keeper (onboarded, first core action, came back
  another day) below it.
- **Coarse must mean something on its own.** Later postbacks, and first
  postbacks from small campaigns, carry only the coarse value. A useful split:
  `low` for opened or onboarded, `medium` for the core action done, `high` for
  paid. Coarse never goes down along the ladder.
- **Lock at the end.** `lock: true` on the milestone after which nothing more
  is worth waiting for (usually the purchase) makes the postback come sooner.
- **Leave gaps** (1, 2, 8, 16, 24, 63) so a milestone can be added later
  without renumbering. Never remap values after campaigns have started: the ad
  network's history would mean something else.
- **Use existing events.** A milestone is an event the app already tracks, with
  at most three `where` props. Up to 20 milestones. The table goes in the
  catalog and, unchanged, in the ad network.
- **35 days.** Milestones reached after day 35 are not reported.

```json
"conversion_values": [
  { "value": 1, "coarse": "low", "event": "onboarding_completed", "label": "Onboarded" },
  { "value": 2, "coarse": "low", "event": "workout_started", "label": "Started a workout" },
  { "value": 8, "coarse": "medium", "event": "workout_completed", "where": { "completed": true }, "label": "Finished a workout" },
  { "value": 24, "coarse": "medium", "event": "purchase_started", "label": "Started a purchase" },
  { "value": 63, "coarse": "high", "event": "purchase_result", "where": { "result": "purchased" }, "label": "Purchased", "lock": true }
]
```

## 5. Testing attribution

- `logLevel: 'debug'` on a device with a development build logs
  `conversion value N (coarse)` as milestones are reached. On the simulator
  SKAdNetwork refuses the call. Unless AdAttributionKit (iOS 17.4 and later)
  accepts it, the SDK logs `conversion value not set`, rolls back, and tries
  again at the next matching event. Test on a device.
- `GET /admin/apps/<app>/attribution` shows the `app_store_id` and the
  `conversion_values` the server read, and the postbacks it counted.
- `GET /v1/config` with the app's key returns the table the SDK uses.
- iOS can send development postbacks from its developer settings; they are
  signed with Apple's development keys and appear under the dev switch.
- Check the built app: `plutil -extract NSAdvertisingAttributionReportEndpoint raw <App>.app/Info.plist`
  prints the endpoint, and `AdAttributionKit` has `AttributionCopyEndpoint`.
- Check the proxy: `curl -X POST -H 'Content-Type: application/json' -d '{}' https://example.com/.well-known/skadnetwork/report-attribution/`
  must reach hush (a 200), not the website.

## 6. What each source can and cannot prove

| Source | Proves | Cannot prove |
|---|---|---|
| Link tags | A session began from a tagged link; which campaign, ad set or ad; what those installs did next, through any funnel. On the web, the whole path from the ad. | An App Store or Play Store install from an ad: the store drops the link. Anything about people who never opened the link in the app. |
| App Store campaigns | How many page views, first downloads, sessions and proceeds came through each campaign link, as Apple counts them. | Which hush installs those were, or what they did in the app. Counts under five users. Ads that do not use a campaign link. |
| SKAdNetwork and AdAttributionKit | That Apple attributed installs to an ad network's campaign, and how far those installs got on your ladder, in aggregate (verified postbacks only). | Which install, session or user a postback belongs to. Exact values for small campaigns (coarse only, or none). Anything after day 35. Organic installs (no postback). Results before Apple's delay, a day or more after each window closes. |

Treat the three as separate views. Do not add them together: the same install
can appear in more than one, and hush cannot tell.
