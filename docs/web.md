# Websites: design

A proposal, 2026-10-29, agreed the same day. Phases 1 and 2 are built; the
rest is not. It is written down first so the model is settled before the SDK,
the dashboard and the iOS app depend on it.

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
- Not done: reading the app's opt-out from a site with its own
  `storagePrefix`. For later, with consent.
- `/hush.js`, a script-tag build served by the server (outside `/v1`) for
  sites without a bundler, such as a hosted webshop: the same origin as the
  events, so a site's CSP needs one host.

**3. Website reports (server).** `/admin/apps/:app/web`: visitors, visits,
pageviews, bounce (visits with one page), top pages, entry pages, referrers,
utm splits, devices, countries (fewer than ten folded into other), store
clicks.

**4. From the site to the App Store.** On the promoted app, one row per
campaign: site visits, store clicks (hush), App Store page views and installs
(App Store Connect, by `ct`), ad installs (SKAdNetwork, AdAttributionKit). A
link builder writes a URL with utm tags and the matching `ct`. URL parameter
templates for Google Ads, TikTok and Reddit beside Meta's.

What it cannot show: in-app steps of a new install per web campaign. That
needs the visitor's id in the app, which the rule above forbids; Apple's
counts stay aggregate. A web build of the app on the site's origin keeps its
full funnel per install.

**5. Dashboard and iOS app.** A Website page for website apps, visitors in
the overview, the campaign table and the link builder. The iOS app: HushKit
models, Website, Campaigns and Attribution screens, a website mark in the app
list.

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
- Moving Rallo's site from `tennis` to its own slug, and deleting the
  `tennis` installs that only ever sent `landing` events (counted first).
