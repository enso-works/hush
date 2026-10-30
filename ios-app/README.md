# hush for iOS

The hush dashboard as an iPhone and iPad app: read and answer feedback,
and see each app's numbers, on any hush server. It adds servers (by the
dashboard's QR code, by hand, or the demo), shows the Overview and each
app's page with a screen for each closer look (funnels and a funnel
builder, campaigns by tagged link or referrer, Apple's attribution (ad
postbacks, App Store campaigns, conversion values), retention and cohorts,
engagement, audience, events and their props, and the websites that sell
it). A website is shown apart, in its own section of the Overview and on a
page of its own: visitors, visits, engaged visits and its goal (a store
click unless the catalog names another) with its rate, by source, campaign,
landing page and device, then its pages, countries, store clicks and links
out. Never as installs, and never in the apps' totals. It edits remote config (with a preview of what a device gets, the
history and a revert), lists and revokes the server's phones and signs in
another with a QR code, notifies the phone of new feedback and replies
(answered or closed from the notification), looks up an install by its id, and has a Feedback tab to read,
answer, close, reopen and delete feedback, with filters, a search and quick
replies.

| Path | What it is |
|---|---|
| `HushKit/` | A Swift package: the `/admin` API's models and `AdminClient`. Tested with `swift test`, no simulator. |
| `Hush/` | The app: SwiftUI, iOS 18 and later. |
| `project.yml` | The Xcode project, for [XcodeGen](https://github.com/yonaskolb/XcodeGen). `Hush.xcodeproj` is generated, not committed. |

```sh
brew install xcodegen
cd ios-app
(cd HushKit && swift test)                 # the models and the client
(cd HushKit && HUSH_LIVE=1 swift test)     # and against the live demo
xcodegen && open Hush.xcodeproj            # then run the Hush scheme
```

The UI tests (`HushUITests`) walk the first launch and the screens against
the live demo, so they need the network; CI only compiles them.
`InboxTests` answers and closes feedback, so it needs a writable server with
tickets of its own: give it a pairing link from that server's
`/admin/pairing` as `TEST_RUNNER_PAIR_LINK` (it skips without one).
A server without an APNs key pushes through bavrk's relay (`HUSH_PUSH_RELAY`
in `Config/App.xcconfig`): the app gets a pass for its token there and gives
each server it signs up with a sealing key of its own, kept in a keychain
group (`<team>.com.bavrk.hush.shared`) shared with `HushNotifications/`, the
notification service extension that opens a sealed push before it shows.
`simctl push` skips service extensions, so the opening is covered by
HushKit's tests (`PushSeal`), and on a phone by a test push with
`"via": "relay"`.

`PushTests` (the same link) turns notifications on with a stand-in token,
then waits for two pushes sent from outside with `xcrun simctl push <sim>
com.bavrk.hush <payload.apns>`, a payload as the server sends it with the
`server` label the app signed up with: it opens the first and answers the
second from the notification. `ConfigTests` (the same link, on a server whose catalog gives Stillwater
`paywall_variant`, as the demo's does) overrides and reverts a key and
opens Phones. `HeaderTests` checks the headers while scrolling (titles
stay, pinned filters stay in reach, the title's menu changes the filters);
`ScrollShots` saves every screen's header at rest and mid-scroll, to check
by eye. Run both on iOS 18 and iOS 26: their bars differ. `AppTests` walks an app's screens;
`WebsiteTests` the demo's website (`stillwater-site`, which sells Stillwater)
and Stillwater's Websites screen; `TEST_RUNNER_HUSH_DEMO_URL` points it at a
local `DEMO=1` server in place of the live demo; `TEST_RUNNER_INSTALL_ID`, an install id
from one of the demo's tickets, adds a look at a real install. With
`TEST_RUNNER_SCREENSHOTS_DIR=<dir>` on the `xcodebuild test` line they save
what each screen shows there.

## App Store screenshots

Made with [store-shots](https://github.com/enso-works/appstore-management-tool) from
`store/`: the copy in `store/content/en-US.json`, the captures in `store/raw/` (iPhone 17 Pro
Max and iPad Pro 13", `ScrollShots`' frames at rest, against the live demo) and the look in
`store-shots.config.json` (the Paper theme in the app's accent colour).

```sh
TEST_RUNNER_SCREENSHOTS_DIR=/tmp/shots xcodebuild test -project Hush.xcodeproj -scheme Hush \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -only-testing:HushUITests/ScrollShots
store-shots generate      # fastlane/screenshots/en-US/, not committed
```

The five screens take `01-overview`, `02-app`, `03-funnels`, `04-retention` and `10-inbox`.

## App Store listing

The listing's text is in `fastlane/metadata/` (subtitle, description, keywords,
promotional text, URLs, copyright, category). `fastlane ios metadata` uploads it
to the version being prepared (`MARKETING_VERSION` in `project.yml`), with the
same API key as TestFlight; it never uploads a build and never submits. The
screenshots go up with `store-shots asc push default`. The version is submitted
by hand in App Store Connect, after the age rating, App Privacy, price and the
review contact are filled in there.

```sh
export ASC_KEY_ID=… ASC_ISSUER_ID=…
fastlane ios metadata
```

## App Privacy

The answers in App Store Connect, which `Hush/PrivacyInfo.xcprivacy` and the
SDK's own manifest (`swift/Sources/Hush/PrivacyInfo.xcprivacy`) mirror. Change
them together. Every row is Tracking: No.

| Data type | What | Purpose | Linked |
|---|---|---|---|
| Usage Data > Product Interaction | the app's own screens and actions, sent to bavrk's hush | Analytics | No |
| Diagnostics > Other Diagnostic Data | app version, build, iOS version, device model, language | Analytics | No |
| Location > Coarse Location | the country, from the connection; no IP kept | Analytics | No |
| Contact Info > Email Address | only if typed into feedback | App Functionality | Yes |
| User Content > Customer Support | the feedback message | App Functionality | Yes |

Not linked holds because a message with an email never carries the install
id (`swift/Sources/Hush/Tickets.swift`). The user's own servers, tokens and
anything read from them are not collected: they never leave the device
except to those servers.

## TestFlight

```sh
export ASC_KEY_ID=… ASC_ISSUER_ID=…   # the team's App Store Connect API key; the .p8 in ~/.appstoreconnect/private_keys
scripts/testflight.sh                 # archive, sign and upload; --no-upload exports build/export/Hush.ipa only
```

Signing is automatic for bavrk's team (`HUSH_TEAM` for another). The build
number is the date and time, so every run uploads a new build. The app record
(bundle ID `com.bavrk.hush`) is made by hand in App Store Connect: Apple's API
cannot create apps.

## Its own hush

The app reports its own anonymous usage (screens, servers added and removed,
pairing failures; never a server, an app on it, or anything read from one)
and takes feedback to the hush team, to bavrk's hush as the app `hush-ios`,
with the Swift SDK from this repository. Settings has Feedback, Share
anonymous usage, and Delete my usage data. The server address is in
`Config/App.xcconfig`; the write key is not in the repository: a gitignored
`Config/Local.xcconfig` (`HUSH_KEY = <the dev key>`) for runs from Xcode,
and `scripts/testflight.sh` passes the prod key, from `HUSH_KEY` or
`~/.config/hush/hush-ios.env`. Without a key the app sends nothing and hides
those screens. UI tests send nothing either; `testFeedbackRoundTrip` runs
against a local hush (`HUSH_URL`, `HUSH_KEY` on the `xcodebuild` line and
`TEST_RUNNER_FEEDBACK_SERVER=1`).

## Servers

The app talks to a server's `/admin` API as the web dashboard does. The
easy way in is the dashboard's Phones page: its QR code, scanned with the
iPhone's camera or Scan QR code in the app, gives the phone a token of its
own (`hush://pair?url=…&code=…`, single use, ten minutes), listed there and
revocable; removing the server in the app revokes it too. Add server takes
the `ADMIN_TOKEN` instead. The Simulator has no camera: paste the link, or
`xcrun simctl openurl booted '<link>'`. `testPairingWithACode` pairs with a
real server when `TEST_RUNNER_PAIR_LINK` holds a fresh link. A server whose `/admin` is behind a VPN needs the phone
on that VPN.

Two rules carry over from the dashboard. A ticket with an email is not
linked to an install, so nothing shows an install id next to an email. And
the token stays on the device.
