# @bavrk/hush-expo

The native side of [`@bavrk/hush`](https://www.npmjs.com/package/@bavrk/hush)
for Expo apps on iOS: what JavaScript cannot do.

- **Apple's ad attribution.** Sets the SKAdNetwork and AdAttributionKit
  conversion value. The SDK registers the install and raises the value as the
  milestones in your hush catalog (`conversion_values`) happen; the value goes
  to Apple and the ad network, aggregated. No App Tracking Transparency
  prompt, no advertising id.
- **Where the build came from.** `testflight` or `app_store`, so the dashboard
  can leave TestFlight out of the store numbers.
- **Time for the last flush.** Asks iOS for background time as the app leaves.

```sh
npx expo install @bavrk/hush @bavrk/hush-expo @react-native-async-storage/async-storage expo-constants expo-device expo-localization
```

In app.json, where iOS sends copies of the attribution postbacks:

```json
{ "expo": { "plugins": [["@bavrk/hush-expo", { "attributionEndpoint": "https://example.com" }]] } }
```

`attributionEndpoint` is `https://` and a host only (no path, port or
trailing slash); anything else fails `expo prebuild`. It writes
`NSAdvertisingAttributionReportEndpoint` and
`AdAttributionKit.AttributionCopyEndpoint` to Info.plist; rebuild the app
after changing it. Without Expo prebuild (bare React Native), set those two
keys yourself. Without the option the plugin does nothing; the native module
links either way.

```ts
import * as hush from '@bavrk/hush';
import * as hushExpo from '@bavrk/hush-expo';

hush.configure({
  url: 'https://hush.example.com',
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : 'hush_myapp_prod_…',
  channel: hushExpo.channel() ?? process.env.EXPO_PUBLIC_HUSH_CHANNEL, // iOS store/TestFlight; Android and internal builds from the EAS profile
  attribution: hushExpo.attribution,
  runInBackground: hushExpo.runInBackground,
});
hush.init(); // right after configure, before any track(); see the SDK's timing rules
```

`distribution()` returns `simulator`, `development` (dev, ad hoc and internal
builds), `testflight` or `app_store`, or null without the native module;
`channel()` passes on only `testflight` and `app_store`.

iOS keeps only the registrable domain of `attributionEndpoint` and posts to
`/.well-known/skadnetwork/report-attribution/` and
`/.well-known/appattribution/report-attribution/` on it; forward both to the
hush server, which verifies Apple's signature and shows them on the dashboard.

On the server, the app's catalog entry needs `app_store_id` (postbacks are
matched to the app by it) and `conversion_values` (the milestones the SDK
raises the value to; without them only 0 is set). Restart hush after editing
it, and enter the same table in the ad network (Meta: Events Manager).

Needs a development build (in Expo Go every function is a quiet no-op). The
pod needs an iOS deployment target of 16.4: Expo SDK 56 has it by default; on
SDK 52-55 run `npx expo install expo-build-properties` and add
`["expo-build-properties", { "ios": { "deploymentTarget": "16.4" } }]` to
plugins. Bare React Native needs Expo SDK 52 or later (React Native 0.76+)
and `platform :ios, '16.4'` in the Podfile instead. The value is set through SKAdNetwork, and from iOS 17.4 through
AdAttributionKit as well. On Android and the web every function is a no-op.

Full setup: [hush.bavrk.com/docs](https://hush.bavrk.com/docs) · server:
[github.com/enso-works/hush](https://github.com/enso-works/hush).
