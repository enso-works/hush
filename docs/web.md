# Websites: design

A proposal, 2026-10-29, agreed the same day. Phases 1 and 2 are built, and
the iOS app's part of phase 5; the rest is not. It is written down first so
the model is settled before the SDK, the dashboard and the iOS app depend on
it.

## Why

hush counts installs. On the web every browser that loads a page is an
install, so a landing site that reports into its app's own slug inflates that
app's new installs, totals, retention and countries. Rallo's site
(`bavrk.com/rallo`) does exactly that: it reports to `tennis` with the
`landing` channel. And since `installs.channel` keeps the last channel it
saw, a player who later reads the site becomes a `landing` install.

Beyond the counts, a website needs what hush does not have yet: pageviews,
top and entry pages, referrers without utm tags, bot filtering, and a way to
follow a campaign from the site to the App Store.

Websites coming: Rallo (tennis), Braele's landing page, Amora's webshop.

## What does not change

- `/v1` and the write keys. A website posts the same batches to the same
  endpoints; `test/__snapshots__/v1-compat.json` stays as it is.
- Usage data is not linked. No click ids (gclid, fbclid) are kept, no
  fingerprint, nothing carries a web visitor's id into the app. The referrer
  is kept as a host, a page as its path, never a query or the user agent.
- An app's catalog entry without `kind` is an app, as today.

## The model

A website is its own hush app, with its own slug and keys, marked in the
catalog:

```json
{
  "rallo-site": { "kind": "website", "promotes": ["tennis"], "events": ["store_clicked"] },
  "tennis": { "app_store_id": "6740000000" }
}
```

- `kind`: `app` (default) or `website`. A website's installs are shown as
  visitors and its sessions as visits.
- `promotes`: the apps the website sells. The app's campaign view reads the
  website's numbers through it (phase 4).

Tables stay as they are: a visitor is an install row, a visit a session, a
page a `screen_viewed` with its path as the screen (so `private_screens` and
the screens views work for pages as they are). No migration.

On one origin, a website and a web build of its app (Rallo's `/play/`) need
separate install ids: `installs.id` is the primary key, so one id cannot be in
two apps. The SDK's storage prefix gives the website its own; the opt-out is
shared on purpose (phase 2).

## Phases

**1. Websites in the catalog, bots out (server).** `kind` and `promotes` in
the catalog, on `/admin/apps` and `/admin/apps/:app`. A batch whose request
User-Agent is a crawler, a link preview or a headless browser is answered as
accepted and not stored. The agent string is read, never written down.

**2. The web SDK tracks a site by itself (`@bavrk/hush/web` 2.5.0).** Built.
- `createWebHush({ autoTrack: { pageviews: true, entry: true, links: true } })`:
  `screen(path)` on load and on client-side navigation;
  `store_clicked { store, campaign }` for App Store, Google Play and
  TestFlight links; `link_clicked { host }` for other outbound links.
- The first session of a visit keeps its `utm_*` and `ref` tags without the
  site calling `entry()`, and a new `referrer` prop: the referring host, never
  the site's own.
- `hush.storeLink(url)` adds `pt` and `ct` to an App Store link, `ct` being
  the visit's campaign cut to Apple's limit, so App Store Connect's campaign
  report counts the same campaign the site saw.
- No events from `navigator.webdriver` browsers; a prerendered page starts
  when it is shown.
- A page load within 30 minutes of the last carries on its session; a link
  with campaign tags starts a new one. Without this every page of a
  multi-page site was a session.
- Once the page is hidden, batches go by `sendBeacon` to
  `/v1/events?key=…`: Chromium drops a `keepalive` fetch that needs a CORS
  preflight as a page goes (checked in Chromium 153), so the last page's
  events, a store click above all, waited for a next visit. They stay
  queued and go again with the next page; the server drops the copies by id.
- The Campaigns panel splits by `referrer`.
- The app's opt-out on a site with its own storage prefix: `/hush.js` with
  `data-storage-prefix` sends nothing while the default prefix (the app's)
  is opted out (2.6.0). The bundled SDK leaves it to the page.
- `visit_engaged` (2.6.0): once a visit has had a page in view for ten
  seconds. A one-page landing site has no second page to tell a reader from
  a bounce.
- `/hush.js`, a script-tag build served by the server (outside `/v1`) for
  sites without a bundler, such as a hosted webshop: the same origin as the
  events, so a site's CSP needs one host.

**3. Website reports (server).** Built. `/admin/apps/:app/web`, `src/web.mjs`.

What matters for a site, in order, and so what the page leads with:
- Visitors and visits, new against returning, against the period before.
- Its goal, and the rate of visits that reach it. The goal is the catalog's
  `highlight` event, or `store_clicked` when it names none: a site that
  sells an app is there to send people to the store; a shop names
  `order_completed`. Visits, not visitors, are the base: a source or a page
  is judged per visit it brought.
- Engaged visits: a second page, any click or event of the site's own, or
  `visit_engaged`. The rest are bounces.
- Sources: `utm_source`, else the referring host, else direct. Campaigns:
  `utm_campaign`. Landing pages: a visit's first page. Each with visits,
  engaged and goal visits, so the rate says which is worth more of.
- Devices: phone, tablet or desktop, from the device the SDK read. A desktop
  visitor cannot install from a store link, so a campaign heavy on desktops
  shows a low rate for that reason; the split shows it.
- Then pages, countries (fewer than ten folded into other), store clicks,
  links out, and the site's own events.

Not counted: time on page as a figure (only the ten-second mark), scroll
depth, click maps, session replays: none says more about whether the site
works than the goal rate, and each needs more of the visitor.

The overview's summary carries a website's `goal` (`event`, `visits`).

**4. From the site to the App Store.** On the promoted app, one row per
campaign: site visits, store clicks (hush), App Store page views and installs
(App Store Connect, by `ct`), ad installs (SKAdNetwork, AdAttributionKit). A
link builder writes a URL with utm tags and the matching `ct`. URL parameter
templates for Google Ads, TikTok and Reddit beside Meta's.
- Built: `/admin/apps/:app/websites`, the websites that promote the app with
  their visitors, visits and store clicks, and App Store clicks by campaign
  beside App Store Connect's page views and first downloads for that `ct`.
- Not built: ad installs per campaign beside them, the link builder, the
  other networks' templates.

What it cannot show: in-app steps of a new install per web campaign. That
needs the visitor's id in the app, which the rule above forbids; Apple's
counts stay aggregate. A web build of the app on the site's origin keeps its
full funnel per install.

**5. Dashboard and iOS app.** Built. An app and a website never look alike:
- The overview: apps, then a Websites section with its own totals (visitors
  in the last day, visits, visits that reached the goal) and cards (a round
  mark with a globe, visitors per day, visits, new, goal and rate). The
  apps' install totals never count a visitor. The sidebar lists Apps and
  Websites apart; Remote config lists apps only.
- A website's page: the order in phase 3. No funnels, retention, versions,
  remote config, attribution or feedback: a site has none of them.
- An app a site promotes: a "From its websites" panel (the iOS app: a
  Websites card) with phase 4's table.
- The demo has `stillwater-site`, which sells Stillwater: search, a Meta ad
  and a newsletter, store clicks by campaign that match the demo's App Store
  campaign `meta_autumn`.

**6. Webshops (Amora).** Orders and revenue from the site: an `order_completed`
event with amount and currency, a cart funnel, revenue per campaign. Designed
when Amora's shop is chosen.

Each phase updates the README, `docs/site/docs.md` and the plugin.

## Later

- Consent: a banner-friendly mode, `persist: false`, keeping the id in memory
  for the page only (visits, not returning visitors), and `optIn()` to start
  storing it. The stored id is device storage under ePrivacy.
- Android: Google Play's install referrer, carried from the store link into
  the React Native SDK.
- Deleting the `tennis` installs that only ever sent `landing` events, once
  Rallo's site reports to `rallo-site` (counted first).
