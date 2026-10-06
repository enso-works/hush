# hush for iOS

The hush dashboard as an iPhone and iPad app: read and answer feedback,
and see each app's numbers, on any hush server. It adds servers (by the
dashboard's QR code, by hand, or the demo), shows the Overview and each
app's page with a screen for each closer look (funnels and a funnel
builder, retention and cohorts, engagement, audience, events and their
props), looks up an install by its id, and has a Feedback tab to read,
answer, close, reopen and delete feedback, with filters, a search and quick
replies. Push notifications come next.

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
`AppTests` walks an app's screens; `TEST_RUNNER_INSTALL_ID`, an install id
from one of the demo's tickets, adds a look at a real install. With
`TEST_RUNNER_SCREENSHOTS_DIR=<dir>` on the `xcodebuild test` line they save
what each screen shows there.

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
