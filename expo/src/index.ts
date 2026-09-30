/**
 * The native side of @bavrk/hush for Expo apps, iOS: Apple's ad attribution
 * (SKAdNetwork and AdAttributionKit conversion values), where the build came
 * from (TestFlight or the App Store), and background runway for the flush as
 * the app leaves. Pass it to the SDK:
 *
 *   import * as hushExpo from '@bavrk/hush-expo';
 *   hush.configure({ url, key, attribution: hushExpo.attribution, channel: hushExpo.channel(), runInBackground: hushExpo.runInBackground });
 *
 * Anywhere the native module is missing (Android, web, Expo Go, a JS-only
 * update onto an older build) every function is a quiet no-op.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

type Native = {
  distribution: 'simulator' | 'development' | 'testflight' | 'app_store';
  updateConversionValue(fine: number, coarse: string, lockWindow: boolean): Promise<void>;
  beginBackgroundTask(): Promise<number>;
  endBackgroundTask(id: number): Promise<void>;
};

const native = requireOptionalNativeModule<Native>('HushExpo');

/** How the build was distributed, or null where the module is missing. */
export function distribution(): Native['distribution'] | null {
  return native?.distribution ?? null;
}

/**
 * The build channel for hush: `testflight` or `app_store` as iOS reports it;
 * undefined for development builds and the simulator, so the SDK's own
 * default (`dev` in __DEV__) applies.
 */
export function channel(): string | undefined {
  const d = distribution();
  return d === 'testflight' || d === 'app_store' ? d : undefined;
}

/** The SDK's `attribution` bridge: sets Apple's conversion value. */
export const attribution = {
  async update(value: { fine: number; coarse: 'low' | 'medium' | 'high'; lock: boolean }): Promise<void> {
    if (!native) return;
    await native.updateConversionValue(value.fine, value.coarse, value.lock);
  },
};

/** The SDK's `runInBackground`: asks iOS for time to finish the flush after the app backgrounds. */
export async function runInBackground(work: () => Promise<void>): Promise<void> {
  let id = -1;
  try {
    id = (await native?.beginBackgroundTask()) ?? -1;
  } catch {
    // Run without the extra time.
  }
  try {
    await work();
  } finally {
    if (id !== -1) await native?.endBackgroundTask(id).catch(() => {});
  }
}
