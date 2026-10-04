# @bavrk/hush-capacitor

The native side of [`@bavrk/hush`](https://www.npmjs.com/package/@bavrk/hush)
for Capacitor apps on iOS: what a web view cannot do. It does the same for
Capacitor as [`@bavrk/hush-expo`](https://www.npmjs.com/package/@bavrk/hush-expo)
does for Expo.

- **Apple's ad attribution.** Sets the SKAdNetwork and AdAttributionKit
  conversion value. The SDK registers the install and raises the value as the
  milestones in your hush catalog (`conversion_values`) happen; the value goes
  to Apple and the ad network, aggregated. No App Tracking Transparency
  prompt, no advertising id.
- **Where the build came from.** `testflight` or `app_store`, so the dashboard
  can leave TestFlight out of the store numbers.
- **Time for the last flush.** Asks iOS for background time as the app leaves.

```sh
npm i @bavrk/hush @bavrk/hush-capacitor && npx cap sync ios
```

`npx cap sync ios` adds the plugin to the app's native project: to
`ios/App/CapApp-SPM/Package.swift` with Swift Package Manager (Capacitor 8's
default), or to the Podfile (`pod 'BavrkHushCapacitor'`) with CocoaPods.
Run it again after updating the package.

```ts
import { Capacitor } from '@capacitor/core';
import { createWebHush } from '@bavrk/hush/web';
import * as hushCapacitor from '@bavrk/hush-capacitor';

export const hush = createWebHush({ version: '1.2.0', build: '42', platform: Capacitor.getPlatform() });

hush.configure({
  url: 'https://hush.example.com',
  key: 'hush_myapp_prod_…',
  channel: (await hushCapacitor.channel()) ?? import.meta.env.VITE_HUSH_CHANNEL, // iOS store/TestFlight; Android and the web from the build
  attribution: hushCapacitor.attribution,
  runInBackground: hushCapacitor.runInBackground,
});
hush.init();
```

The calls cross Capacitor's bridge, so `channel()` and `distribution()`
return promises, unlike hush-expo's. The first call reads the value from iOS;
later ones reuse it.

An app that cannot await before `configure()` (top-level `await` needs an
ES2022 build target) can call it twice: once at startup with a fallback
channel, then again with the one iOS reports, before `init()`. Each call
replaces the whole configuration, so the second one passes every option
again. Events tracked in between are kept, and every batch carries the
channel the second call set, as the SDK reads it when it sends.

```ts
const config = { url, key, attribution: hushCapacitor.attribution, runInBackground: hushCapacitor.runInBackground };
hush.configure({ ...config, channel: fallback });
hushCapacitor.channel().then((channel) => {
  hush.configure({ ...config, channel: channel ?? fallback });
  hush.init();
});
```

`distribution()` returns `simulator`, `development` (dev, ad hoc and internal
builds), `testflight` or `app_store`, or null off iOS and without the native
plugin; `channel()` passes on only `testflight` and `app_store`.

## Info.plist

There is no config plugin: add the two keys where iOS sends copies of the
attribution postbacks to `ios/App/App/Info.plist` by hand.

```xml
<key>NSAdvertisingAttributionReportEndpoint</key>
<string>https://example.com</string>
<key>AdAttributionKit</key>
<dict>
  <key>AttributionCopyEndpoint</key>
  <string>https://example.com</string>
</dict>
```

Both are `https://` and a host only: no path, port or trailing slash. iOS
keeps only the registrable domain and posts to
`/.well-known/skadnetwork/report-attribution/` and
`/.well-known/appattribution/report-attribution/` on it; forward both to the
hush server, which verifies Apple's signature and shows them on the
dashboard. Without the keys the conversion value is still set; hush just
gets no copies.

## The catalog

On the server, the app's catalog entry needs `app_store_id` (postbacks are
matched to the app by it) and `conversion_values` (the milestones the SDK
raises the value to; without them only 0 is set). Restart hush after editing
it, and enter the same table in the ad network (Meta: Events Manager).

## Requirements

iOS 15 or later: Capacitor 8's default deployment target. The value is set
through SKAdNetwork, and from iOS 17.4 through AdAttributionKit as well.
SKAdNetwork takes the fine value, the coarse value and the lock from
iOS 16.1, the fine value alone on 15.4 to 16.0, and on 15.0 to 15.3 the fine
value through the older `updateConversionValue`, which reports no errors.

`@capacitor/core` 6 or later is the peer. On Capacitor 6 and 7, whose apps
target iOS 13 and 14, raise the deployment target to 15.0 in the Podfile and
the Xcode project, or `pod install` refuses the plugin.

On Android and the web every function is a quiet no-op, and so is a web
build running on a binary made before the plugin was added: make a new
native build.

Full setup: [hush.bavrk.com/docs](https://hush.bavrk.com/docs) · server:
[github.com/enso-works/hush](https://github.com/enso-works/hush).
