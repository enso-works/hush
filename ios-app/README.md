# hush for iOS

The hush dashboard as an iPhone and iPad app: read and answer feedback,
and see each app's numbers, on any hush server. Work in progress: it shows
the public demo's apps so far.

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

The app talks to a server's `/admin` API with its `ADMIN_TOKEN`, as the
web dashboard does. A server whose `/admin` is behind a VPN needs the phone
on that VPN.

Two rules carry over from the dashboard. A ticket with an email is not
linked to an install, so nothing shows an install id next to an email. And
the token stays on the device.
