# hush for Swift

Anonymous usage tracking and in-app feedback for native iOS apps, sent to
your own [hush](https://github.com/enso-works/hush) server. The same events,
sessions and tickets as the JavaScript SDK (`@bavrk/hush`), so the dashboard
reads both alike. iOS 15 and later, no dependencies.

```swift
// Package.swift, or File > Add Package Dependencies in Xcode
.package(url: "https://github.com/enso-works/hush", from: "0.1.0")
```

Once, as the app starts (an `App`'s `init`, or `application(_:didFinishLaunchingWithOptions:)`):

```swift
import Hush

Hush.configure(url: "https://hush.example.com", key: "hush_myapp_prod_…")
Hush.start()
```

The write key ships inside the app, so it is not a secret: it identifies the
app, can be revoked, and can read nothing but this install's own feedback.
Use the `dev` key in debug builds (their data shows under the dashboard's dev
switch), and an empty key to keep hush off. Every call returns at once, never
throws, and never breaks the app.

## Events

```swift
Hush.screen("Settings")
Hush.track("workout_completed", ["minutes": 20, "kind": "run", "completed": true])
Hush.track("onboarding_completed", once: true)        // at most once per install
Hush.setGlobalProps(["paywall_variant": "b"])          // joins every event; an event's own props win
Hush.identify(pro: true, rcId: customerInfo.originalAppUserId)
```

- Event names are snake_case, 2 to 64 characters; props are one flat level
  of strings, numbers, booleans or `nil`, up to 40. An invalid name is
  dropped on the device, with a line in the log at `logLevel: .error`.
- `app_first_opened` and `session_started` are sent for you. A session ends
  after 30 minutes away; each `session_started` carries its number `n` and the
  last session's seconds in the foreground, `prev_fg_s`.
- Events queue on the device (500, up to 7 days) and go out in batches of 20,
  every 30 seconds, a few seconds after something happens, and as the app
  leaves the foreground, with background time to finish.
- Leave out of `screen()` the screens the app's catalog lists in
  `private_screens`, such as feedback and support.

### How a session began

```swift
.onOpenURL { url in Hush.entry(.link, url: url) }   // keeps utm_* and ref, never the URL
Hush.entry(.notification)                           // the notification that opened the app
```

It claims the session that has just started, within 2.5 seconds; made
before the session exists, it waits for it.

## Feedback

```swift
switch await Hush.createTicket(kind: .issue, message: text, email: email, subject: subject) {
case .success(let id): …
case .failure(let error): …   // .offline, .tooMany, .failed, .unavailable
}
let tickets = await Hush.listTickets()                 // newest first, with replies and `unread`
_ = await Hush.replyToTicket(ticket.id, body: "Thanks!")  // .closed once support closed it
```

A user can send five a day. Your replies from the dashboard show in
`listTickets()`, and by email when they left an address. A ticket sent with
an email is kept apart from the install: it goes without the install id, and
the server answers with a key to that one ticket, kept on the device (in
UserDefaults, so it goes with the app). No request carries the install id and
a key together.

## The user's choices

```swift
Hush.optOut()                     // remembered: nothing is queued or sent until optIn(); feedback still works
let result = await Hush.forget()  // "delete my data": the email tickets by key, then the install; a new install id after
```

`Hush.installationId` gives the id to paste into the dashboard's Installs page,
for a debug screen.

## Options

| `configure(…)` | |
|---|---|
| `url`, `key` | the server and a write key; either empty leaves hush off |
| `channel` | where this build came from, snake_case. Default: `dev` in a debug build; otherwise `testflight` or `app_store` as iOS reports it, and none for development and ad hoc builds |
| `storagePrefix` | UserDefaults key prefix, default `hush`. Changing it gives every install a new id |
| `logLevel` | `.silent` (default), `.error` (mistakes), `.debug` (every send), in the `com.bavrk.hush.sdk` log |
| `onFlush` | called after every send with its result |

Not yet in this version, and in the JavaScript SDK: remote config, and
Apple's ad attribution (conversion values).

## Versions

The package is versioned by the plain semver tags of this repository
(`0.1.0`); every batch carries `sdk: "swift-<version>"`, stored on the install.
Releasing: bump `sdkVersion` in `Sources/Hush/Client.swift`, commit, then tag
the version and push the tag (`.github/workflows/publish-swift.yml`).

## Tests

```sh
swift test                      # from the repository root
HUSH_E2E_URL=http://127.0.0.1:3000 HUSH_E2E_KEY=hush_… HUSH_E2E_ADMIN=… swift test --filter Live
```

The live test runs against a real server and checks what it stored.
