# Dogfood log

hush runs our own apps first. Everything awkward we hit while using it goes
here, newest first, with what was done about it. It is the fix list before
anything else, and later the evidence for what a hosted hush has to be.

Format: date, app, what happened, status (fixed in `<commit>`, open, app-side).

## 2026-09-30

- **ops, operator.** The dashboard needed its own sign-in on ops, next to the
  cockpit's. Fixed: a trusted proxy header (`ADMIN_PROXY_HEADER`) and
  `/admin/session`, so ops opens it signed in; admin writes are same-origin
  JSON only.
- **ops, operator.** The cockpit hardcoded Braele's charts (pattern, intent,
  voice...). Fixed: catalog `breakdowns`, pinned per app from config.
- **ops, operator.** The Revenue panel read RevenueCat's metric list as an
  object, labelling tiles 0, 1, 2. Fixed, with RevenueCat's charts, a refresh
  button and freshness; revenue is on the overview cards.
- **Braele, app-side, open.** RevenueCat has $19 and 4 purchases in 28 days,
  hush saw no `purchase_started` or `purchase_result` at all. The purchase
  path does not track, or tracks under another name.
- **Braele, app-side, open.** `breathing_session_started.voice` has a `true`
  value next to voice names and `off`, and `.ambient` a `false`: an older
  build sent booleans. Harmless, but it splits the chart.
- **Braele, app-side, open.** `diagnostic_ping` arrives and is not in the
  catalog: add it, or stop sending it from release builds.
- **dashboard.** "1 installs". Fixed: counts are singular at one.
- **tennis game.** No way to use hush from a web or Capacitor app: the npm
  package was React Native only and /v1 answered no CORS. Fixed:
  `@bavrk/hush/web` (2.1.0) and CORS on /v1.
