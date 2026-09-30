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
npx expo install @bavrk/hush @bavrk/hush-expo
```

```json
// app.json: where iOS sends copies of the attribution postbacks
"plugins": [["@bavrk/hush-expo", { "attributionEndpoint": "https://example.com" }]]
```

```ts
import * as hush from '@bavrk/hush';
import * as hushExpo from '@bavrk/hush-expo';

hush.configure({
  url: 'https://hush.example.com',
  key: 'hush_myapp_prod_…',
  channel: hushExpo.channel(),
  attribution: hushExpo.attribution,
  runInBackground: hushExpo.runInBackground,
});
```

iOS keeps only the registrable domain of `attributionEndpoint` and posts to
`/.well-known/skadnetwork/report-attribution/` and
`/.well-known/appattribution/report-attribution/` on it; forward both to the
hush server, which verifies Apple's signature and shows them on the dashboard.

Needs a development build (not Expo Go). iOS 16.4+; elsewhere every function
is a no-op.
