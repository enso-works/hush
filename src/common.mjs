// Every app gets the generic lifecycle names even before it has a catalog of
// its own, so a newly wired app does not light up the "unknown events" list.
// Every name the SDK sends by itself is here (test/sdk.test.mjs checks).
// A module of its own, with no imports, so the SDK's tests can read it
// without the server's dependencies installed (the publish workflow has none).
export const COMMON = ['app_first_opened', 'session_started', 'screen_viewed', 'paywall_viewed', 'purchase_started', 'purchase_result', 'restore_result', 'ticket_opened', 'ticket_replied'];
