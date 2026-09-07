// The event names each app is expected to send. An unknown name is still
// stored (a shipped app must never lose data because the backoffice is
// behind), just flagged `known = false` so the dashboard can show it as
// either a typo to fix or a name to add here.
export const CATALOG = {
  braele: [
    'app_first_opened',
    'session_started',
    'screen_viewed',
    'onboarding_completed',
    'intent_selected',
    'breathing_session_started',
    'breathing_session_completed',
    'paywall_viewed',
    'purchase_started',
    'purchase_result',
    'restore_result',
    'reminder_set',
    'feature_used',
    'ticket_opened',
  ],
};

// Every app gets the generic lifecycle names even before it has a catalog of
// its own, so a newly wired app does not light up the "unknown events" list.
const COMMON = ['app_first_opened', 'session_started', 'screen_viewed', 'paywall_viewed', 'purchase_started', 'purchase_result', 'restore_result', 'ticket_opened'];

const known = new Map();
export function isKnown(app, name) {
  let set = known.get(app);
  if (!set) {
    set = new Set([...COMMON, ...(CATALOG[app] ?? [])]);
    known.set(app, set);
  }
  return set.has(name);
}

// The paywall funnel every app shares, in order. The dashboard renders it as
// counts of distinct installs at each step.
export const FUNNEL = ['paywall_viewed', 'purchase_started', 'purchase_result'];
