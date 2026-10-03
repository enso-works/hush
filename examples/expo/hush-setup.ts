/**
 * Wiring hush into an Expo app: configuration, the calls a typical app makes,
 * and the ticket screen's three requests, with the SDK installed from npm
 * (npm install @bavrk/hush).
 */
import * as hush from '@bavrk/hush';
import type { HushRemoteConfig } from '@bavrk/hush';

// --- once, at startup (e.g. the root layout)

hush.configure({
  url: process.env.EXPO_PUBLIC_HUSH_URL ?? 'https://hush.example.com',
  // Release builds carry the prod key in code: an env var read at build time
  // can silently pick up a local .env and ship the dev key. Dev builds read
  // one from the environment, or stay off.
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : 'hush_myapp_prod_REPLACE_ME',
  // Which build this is, set per EAS build profile (production: app_store or
  // play, preview: internal). One iOS build goes to TestFlight and then the
  // App Store, so only @bavrk/hush-expo tells those apart:
  // channel: hushExpo.channel() ?? process.env.EXPO_PUBLIC_HUSH_CHANNEL,
  channel: process.env.EXPO_PUBLIC_HUSH_CHANNEL,
  logLevel: __DEV__ ? 'debug' : 'silent',
  // Optional: give the flush on backgrounding real runway, with whatever
  // background-task module the app already has.
  // runInBackground: (work) => withBackgroundTask(work),
  // Remote config is on by default. Pass the language the app shows when it
  // is not always the phone's first (the locale your i18n module resolved):
  // remoteConfig: { language: () => i18n.locale },
  // and on an in-app switch: hush.identify({ language: next }).
});
// Safe to call before or after anything else below (SDK 2.2.2 and later).
export const hushReady = hush.init();

// Context every event should carry, e.g. the paywall copy under test (pick it
// once per install and store it, so an install never switches arms).
export function onVariant(variant: 'a' | 'b') {
  hush.setGlobalProps({ paywall_variant: variant });
}

// --- remote config: values from the server's catalog, changed on its dashboard

// Hold the splash screen until values are usable: from the cache at once, on
// a first launch after the first fetch, and never longer than 3 s by default.
// SplashScreen.preventAutoHideAsync() at module load, then:
export const configReady = hush.config.ready(); // .then(() => SplashScreen.hideAsync())

// Getters never throw: the fallback when the key is missing, of another type,
// or not loaded yet. Outside React, read hush.config. In a component, pass
// what useConfig() returns: it re-renders on a change and is a new object
// after one, so the React Compiler's memoizing follows it; a compiled
// component calling homeScreen() on hush.config would keep its first answer.
//   const config = hush.useConfig();
//   return homeScreen(config) === 'new' ? <NewHome /> : <ClassicHome />;
export function homeScreen(config: HushRemoteConfig = hush.config): 'new' | 'classic' {
  return config.bool('new_home', false) ? 'new' : 'classic';
}
export function sessionPresets(config: HushRemoteConfig = hush.config): number[] {
  // Frozen: copy before sorting.
  return [...config.json<number[]>('session_presets', [3, 5, 10])].sort((a, b) => a - b);
}

// --- the root layout, for links and notification taps

export function onOpenedFromLink(url: string) {
  // Held for the session if it does not exist yet (2.2.1 and older: await hushReady first).
  hush.entry('link', { url }); // keeps utm_source / utm_campaign / ref, never the URL
}

// --- through the app

export function onScreenFocus(name: string) {
  hush.screen(name);
}

export function onWorkoutFinished(minutes: number, completed: boolean) {
  hush.track('workout_completed', { minutes, completed });
}

// After RevenueCat's customerInfo resolves, so purchases join installs
// without ever setting an app user id.
export function onCustomerInfo(info: { originalAppUserId: string; entitlements: { active: Record<string, unknown> } }) {
  hush.identify({ rcId: info.originalAppUserId, pro: Object.keys(info.entitlements.active).length > 0 });
}

export function onOnboardingDone() {
  hush.track('onboarding_completed', {}, { once: true });
}

export function onPaywallShown() {
  hush.track('paywall_viewed');
}

export function onPurchase(result: 'purchased' | 'cancelled' | 'failed', product: string) {
  hush.track('purchase_result', { result, product });
}

// --- Settings: the user's choices

export function setShareUsage(share: boolean) {
  if (share) hush.optIn();
  else hush.optOut();
}

export async function deleteMyData() {
  const r = await hush.forget();
  return r.ok ? 'Deleted.' : 'Could not reach the server; try again later.';
}

// --- the support screen

export async function sendFeedback(message: string, email?: string) {
  const r = await hush.createTicket({ kind: 'issue', message, email });
  if (!r.ok) {
    return r.error === 'too_many' ? 'You have sent a lot today; try again tomorrow.' : 'Could not send; check your connection.';
  }
  return 'Sent. We read everything.';
}

export async function inbox() {
  const tickets = await hush.listTickets();
  const unread = tickets.filter((t) => t.unread).length;
  return { tickets, unread };
}

export async function answer(ticketId: string, body: string) {
  const r = await hush.replyToTicket(ticketId, body);
  return r.ok ? 'Sent.' : r.error === 'closed' ? 'This conversation is closed; start a new one.' : 'Could not send.';
}
