/**
 * The native side of @bavrk/hush for Capacitor apps, iOS: Apple's ad
 * attribution (SKAdNetwork and AdAttributionKit conversion values), where the
 * build came from (TestFlight or the App Store), and background runway for
 * the flush as the app leaves. Pass it to the SDK:
 *
 *   import * as hushCapacitor from '@bavrk/hush-capacitor';
 *   hush.configure({ url, key, channel: await hushCapacitor.channel(), attribution: hushCapacitor.attribution, runInBackground: hushCapacitor.runInBackground });
 *
 * The calls cross Capacitor's bridge, so distribution() and channel() are
 * async, unlike @bavrk/hush-expo's. Off iOS (the web, Android) and wherever
 * the native plugin is missing (a web build onto an older binary) every
 * function is a quiet no-op.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

type Distribution = 'simulator' | 'development' | 'testflight' | 'app_store';

type Native = {
  distribution(): Promise<{ value: Distribution }>;
  updateConversionValue(options: { fine: number; coarse: string; lock: boolean }): Promise<void>;
  beginBackgroundTask(): Promise<{ id: number }>;
  endBackgroundTask(options: { id: number }): Promise<void>;
};

const NAME = 'HushCapacitor';
const native = registerPlugin<Native>(NAME);
const DISTRIBUTIONS: readonly string[] = ['simulator', 'development', 'testflight', 'app_store'];

// Asked on each call, not at import: cheap, and never wrong about a bridge
// that was not ready when this module loaded.
function available(): boolean {
  try {
    return Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable(NAME);
  } catch {
    return false;
  }
}

// It cannot change while the app runs: one bridge call per launch.
let distributionRead: Promise<Distribution | null> | undefined;

/** How the build was distributed, or null off iOS and where the plugin is missing. */
export function distribution(): Promise<Distribution | null> {
  distributionRead ??= available()
    ? native.distribution().then(
        (r) => (typeof r?.value === 'string' && DISTRIBUTIONS.includes(r.value) ? r.value : null),
        () => null,
      )
    : Promise.resolve(null);
  return distributionRead;
}

/**
 * The build channel for hush: `testflight` or `app_store` as iOS reports it;
 * undefined for development builds, the simulator and off iOS, so the app's
 * own fallback (or the SDK's `dev` in a dev build) applies.
 */
export async function channel(): Promise<string | undefined> {
  const d = await distribution();
  return d === 'testflight' || d === 'app_store' ? d : undefined;
}

/** The SDK's `attribution` bridge: sets Apple's conversion value. */
export const attribution = {
  async update(value: { fine: number; coarse: 'low' | 'medium' | 'high'; lock: boolean }): Promise<void> {
    if (!available()) return;
    await native.updateConversionValue({ fine: value.fine, coarse: value.coarse, lock: value.lock });
  },
};

/** The SDK's `runInBackground`: asks iOS for time to finish the flush after the app backgrounds. */
export async function runInBackground(work: () => Promise<void>): Promise<void> {
  let id = -1;
  if (available()) {
    try {
      const r = await native.beginBackgroundTask();
      id = typeof r?.id === 'number' ? r.id : -1;
    } catch {
      // Run without the extra time.
    }
  }
  try {
    await work();
  } finally {
    if (id !== -1) await native.endBackgroundTask({ id }).catch(() => {});
  }
}
