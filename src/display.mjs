// What a screen on a wall may read: hush's numbers, and never anything a person
// wrote or anything about one install. /display is reachable from the internet
// when a deployment chooses, so it holds a token of its own that opens nothing
// else, answers GET only, and is served from a short cache so a screen, or a
// leaked token, costs the database one query set a minute.
import { appDetail, summary } from './admin.mjs';
import { log } from './config.mjs';
import { ensureFresh, revenue } from './revenuecat.mjs';

const TTL_MS = 60_000;
// The dashboard refreshes RevenueCat when someone opens it. A screen is open
// all day, and a full pull is a dozen requests per app.
const REVENUE_REFRESH_MS = 60 * 60_000;
const DAYS = new Set([1, 7, 30, 90]);
const DEFAULT_DAYS = 7;

// Named one by one: a field later added to a dashboard query stays off this
// route until someone decides it belongs here.
const OVERVIEW_FIELDS = ['app', 'name', 'kind', 'new_installs', 'total_installs', 'dau', 'wau', 'mau', 'sessions', 'events', 'open_tickets', 'ad_installs', 'last_event', 'goal', 'trend'];
const DETAIL_FIELDS = ['app', 'name', 'kind', 'current', 'prior', 'retention', 'engagement', 'channels', 'todayActive', 'daily', 'versions', 'events', 'funnel', 'countries', 'tickets', 'lastEvent'];
const REVENUE_FIELDS = ['app', 'name', 'currency', 'metrics', 'fetched_at'];
const SERIES_FIELDS = ['name', 'unit', 'points'];

const pick = (row, fields) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));

/** Only the periods a screen shows, so the cache has a fixed number of entries. */
export function displayDays(url) {
  const n = Number(url.searchParams.get('days'));
  return DAYS.has(n) ? n : DEFAULT_DAYS;
}

const cache = new Map();

function cached(key, load) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = load();
  cache.set(key, { until: Date.now() + TTL_MS, value });
  // A failed query is not worth remembering for a minute.
  value.catch(() => cache.delete(key));
  return value;
}

let lastRefresh = 0;

// Not awaited: the screen shows what is stored, and a slow RevenueCat must not
// hold up the numbers that come from hush's own database.
function refreshRevenue() {
  if (Date.now() - lastRefresh < REVENUE_REFRESH_MS) return;
  lastRefresh = Date.now();
  ensureFresh().catch((err) => log.warn('display: revenue refresh failed', { err: String(err?.message ?? err) }));
}

/** Every app's numbers for the period, and the revenue cards. */
export function displayOverview(days) {
  refreshRevenue();
  return cached(`overview:${days}`, async () => {
    const [apps, money] = await Promise.all([summary({ days, env: 'prod' }), revenue({ days })]);
    return {
      generated_at: new Date().toISOString(),
      days,
      open_tickets: apps.reduce((sum, app) => sum + app.open_tickets, 0),
      apps: apps.map((app) => pick(app, OVERVIEW_FIELDS)),
      revenue: money.apps.map((card) => pick(card, REVENUE_FIELDS)),
    };
  });
}

/** One app's charts for the period, or null for a slug hush does not have. */
export async function displayApp(app, days) {
  // Checked against the known apps first, so a made-up slug is never a cache entry.
  const { apps } = await displayOverview(days);
  if (!apps.some((known) => known.app === app)) return null;
  return cached(`app:${app}:${days}`, async () => {
    const [detail, money] = await Promise.all([appDetail({ app, days, env: 'prod', channel: null }), revenue({ app, days })]);
    const card = money.apps.find((row) => row.app === app);
    return {
      generated_at: new Date().toISOString(),
      days,
      ...pick(detail, DETAIL_FIELDS),
      revenue: card ? { ...pick(card, REVENUE_FIELDS), series: money.series.map((series) => pick(series, SERIES_FIELDS)) } : null,
    };
  });
}
