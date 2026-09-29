/**
 * Wiring hush into an Expo app: configuration, the calls a typical app makes,
 * and the ticket screen's three requests. Copy the SDK (sdk/src/index.ts)
 * to src/lib/hush.ts first.
 */
import * as hush from '@/lib/hush';

// --- once, at startup (e.g. the root layout)

hush.configure({
  url: process.env.EXPO_PUBLIC_HUSH_URL ?? 'https://hush.example.com',
  // Release builds carry the prod key in code: an env var read at build time
  // can silently pick up a local .env and ship the dev key. Dev builds read
  // one from the environment, or stay off.
  key: __DEV__ ? (process.env.EXPO_PUBLIC_HUSH_KEY ?? '') : 'hush_myapp_prod_REPLACE_ME',
  // Optional: give the flush on backgrounding real runway, with whatever
  // background-task module the app already has.
  // runInBackground: (work) => withBackgroundTask(work),
});
void hush.init();

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

export function onPaywallShown() {
  hush.track('paywall_viewed');
}

export function onPurchase(result: 'purchased' | 'cancelled' | 'failed', product: string) {
  hush.track('purchase_result', { result, product });
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
