// RevenueCat, read-only and pulled when someone is looking.
//
// SPEC section 8 keeps money out of the events pipeline: nothing here is
// recomputed from what phones report, it is what RevenueCat says, cached.
// There is no timer: one person reads this dashboard, so a poller would spend
// 96 pulls a day to be ready for the two that get read. Opening the Apps page
// refreshes a cache older than RC_STALE_MINUTES, the refresh button forces
// one, and everything else is served from Postgres.
//
// It is still the service that calls RevenueCat and never the browser: the v2
// key is a real secret (it can read customers), and Charts & Metrics allows 25
// requests a minute, which a page that fetched directly on every render would
// spend on one impatient afternoon.
import { cfg, log } from './config.mjs';
import { q } from './db.mjs';

const API = 'https://api.revenuecat.com/v2';

// Counts, so no unit ambiguity. Money is handled separately (see `pullApp`).
const COUNT_CHARTS = ['new_customers', 'active_subscriptions', 'active_trials'];
const WINDOW_DAYS = 90;

export const rcConfigured = () => Boolean(cfg.rcApiKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10);

async function rc(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.rcApiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(`revenuecat ${path}: ${detail}`), { status: res.status });
  }
  // Serialised calls with a small gap: five requests per app per poll stays
  // an order of magnitude under the limit, and a burst never starts.
  await sleep(200);
  return body;
}

/** `RC_PROJECTS="braele=projabc,invoit=projdef"` — a pinned map for when project names and app slugs diverge. */
function pinned() {
  const out = new Map();
  for (const pair of (cfg.rcProjects || '').split(',')) {
    const [app, id] = pair.split('=').map((s) => s?.trim());
    if (app && id) out.set(app, id);
  }
  return out;
}

export async function listProjects() {
  const body = await rc('/projects');
  return (Array.isArray(body?.items) ? body.items : []).map((p) => ({ id: p.id, name: p.name ?? '' }));
}

export async function link(app, projectId, name) {
  await q(
    `INSERT INTO rc_projects (app, project_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (app) DO UPDATE SET project_id = EXCLUDED.project_id, name = EXCLUDED.name, linked_at = now()`,
    [app, projectId, name ?? null],
  );
}

/**
 * Match RevenueCat projects to apps: the pinned map wins, otherwise a project
 * whose name is the app's slug or its display name (case-insensitively). An
 * unmatched project is left alone rather than guessed at — a wrong link would
 * put another app's revenue on this app's page.
 */
export async function syncProjects() {
  const [projects, apps] = [await listProjects(), (await q('SELECT slug, name FROM apps')).rows];
  const map = pinned();
  const linked = [];
  for (const app of apps) {
    const want = map.get(app.slug);
    const project = want
      ? projects.find((p) => p.id === want)
      : projects.find((p) => [app.slug, app.name].some((n) => n && n.toLowerCase() === p.name.trim().toLowerCase()));
    if (!project) continue;
    await link(app.slug, project.id, project.name);
    linked.push({ app: app.slug, project: project.name, id: project.id });
  }
  return { projects, linked };
}

/**
 * A chart's `values` shape depends on the chart, and the API reference says so
 * rather than pinning one. Both documented shapes are read here — rows of
 * `[period, …numbers]` and objects keyed by period and value — and anything
 * else is logged with a sample instead of being silently charted wrong.
 */
export function normalizeChart(values, chart) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const out = [];
  let complained = false;
  for (const entry of values) {
    let period;
    let value;
    if (Array.isArray(entry)) {
      period = entry[0];
      // The last finite number in the row: single-series charts put it at [1],
      // and a total column, where one exists, is the rightmost.
      for (const v of entry.slice(1)) if (Number.isFinite(Number(v))) value = Number(v);
    } else if (entry && typeof entry === 'object') {
      period = entry.period ?? entry.date ?? entry.start_date ?? entry.time ?? entry.x;
      for (const key of ['value', 'total', 'amount', 'y']) {
        if (Number.isFinite(Number(entry[key]))) { value = Number(entry[key]); break; }
      }
    }
    const day = toDay(period);
    if (day === null || value === undefined) {
      if (!complained) {
        complained = true;
        log.warn('rc chart shape unrecognised', { chart, sample: JSON.stringify(entry).slice(0, 200) });
      }
      continue;
    }
    out.push({ day, value });
  }
  return out;
}

/** A chart period as a UTC calendar day: ISO string, epoch seconds or epoch milliseconds. */
function toDay(period) {
  if (typeof period === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(period)) return period.slice(0, 10);
    const t = Date.parse(period);
    return Number.isNaN(t) ? null : ymd(new Date(t));
  }
  if (Number.isFinite(period)) return ymd(new Date(period < 1e12 ? period * 1000 : period));
  return null;
}

/**
 * Whether a money chart came back in units or in cents. RevenueCat's chart
 * schema does not state the scale and the overview does, so the chart is
 * calibrated against `/metrics/revenue` for the same window instead of
 * assuming — the difference between $18 and $1,800 on the dashboard.
 */
export function scaleFor(sum, authoritative) {
  if (!(sum > 0) || !(authoritative > 0)) return 1;
  return Math.abs(sum / 100 - authoritative) < Math.abs(sum - authoritative) ? 0.01 : 1;
}

async function writeSeries(app, chart, points) {
  if (points.length === 0) return;
  await q(
    `INSERT INTO rc_series (app, chart, day, value)
     SELECT $1, $2, d::date, v FROM unnest($3::text[], $4::numeric[]) AS t(d, v)
     ON CONFLICT (app, chart, day) DO UPDATE SET value = EXCLUDED.value`,
    [app, chart, points.map((p) => p.day), points.map((p) => p.value)],
  );
}

async function writeOverview(app, currency, metrics) {
  // One row per change, not per poll: the numbers move a few times a day, and
  // a snapshot every quarter hour would be 35k near-identical rows a year.
  // The comparison is jsonb's, not JavaScript's — jsonb stores keys in its own
  // order, so comparing serialised strings would call every poll a change.
  const { rowCount } = await q(
    `INSERT INTO rc_overview (app, currency, metrics)
     SELECT $1, $2, $3::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM rc_overview o
       WHERE o.app = $1 AND o.currency = $2 AND o.metrics = $3::jsonb
         AND o.fetched_at = (SELECT max(fetched_at) FROM rc_overview WHERE app = $1)
     )`,
    [app, currency, JSON.stringify(metrics)],
  );
  return rowCount > 0;
}

async function pullApp({ app, project_id: projectId }) {
  const end = new Date();
  const start = new Date(end.getTime() - (WINDOW_DAYS - 1) * 86400_000);
  const currency = cfg.rcCurrency;

  const overview = await rc(`/projects/${projectId}/metrics/overview`, { currency });
  const metrics = (Array.isArray(overview?.metrics) ? overview.metrics : []).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    unit: m.unit,
    period: m.period,
    value: m.value,
    last_updated_at: m.last_updated_at_iso8601 ?? null,
  }));
  if (metrics.length === 0) throw new Error('overview returned no metrics');
  await writeOverview(app, overview?.currency ?? currency, metrics);

  for (const chart of COUNT_CHARTS) {
    try {
      const data = await rc(`/projects/${projectId}/charts/${chart}`, { resolution: 'day', start_date: ymd(start), end_date: ymd(end), currency });
      await writeSeries(app, chart, normalizeChart(data?.values, chart));
    } catch (err) {
      // A chart the project does not have is a 404, not a broken poll.
      log.warn('rc chart skipped', { app, chart, err: String(err?.message ?? err) });
    }
  }

  // Revenue last: its scale is decided by the authoritative total for the
  // same window, so the two calls belong together.
  try {
    const total = await rc(`/projects/${projectId}/metrics/revenue`, { start_date: ymd(start), end_date: ymd(end), currency });
    const data = await rc(`/projects/${projectId}/charts/revenue`, { resolution: 'day', start_date: ymd(start), end_date: ymd(end), currency });
    const points = normalizeChart(data?.values, 'revenue');
    const scale = scaleFor(points.reduce((a, p) => a + p.value, 0), Number(total?.value));
    if (scale !== 1) log.info('rc revenue chart is in minor units', { app, scale });
    await writeSeries(app, 'revenue', points.map((p) => ({ day: p.day, value: p.value * scale })));
  } catch (err) {
    log.warn('rc revenue skipped', { app, err: String(err?.message ?? err) });
  }
}

// One pull per app at a time. Two people opening the page, or one opening it
// twice, must not double the calls RevenueCat counts.
const inflight = new Map();

function once(key, fn) {
  const running = inflight.get(key);
  if (running) return running;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function pullOne(row) {
  return once(row.app, async () => {
    try {
      await pullApp(row);
      await q('UPDATE rc_projects SET last_polled_at = now(), last_error = NULL WHERE app = $1', [row.app]);
    } catch (err) {
      const message = String(err?.message ?? err);
      await q('UPDATE rc_projects SET last_polled_at = now(), last_error = $2 WHERE app = $1', [row.app, message.slice(0, 300)]);
      log.warn('rc pull failed', { app: row.app, err: message });
    }
  });
}

/** One pass over every linked project, unconditionally. The CLI's `rc:poll`. */
export async function poll() {
  if (!rcConfigured()) return;
  try {
    await syncProjects();
  } catch (err) {
    log.warn('rc project sync failed', { err: String(err?.message ?? err) });
  }
  const { rows } = await q('SELECT app, project_id FROM rc_projects ORDER BY app');
  for (const row of rows) await pullOne(row);
}

/**
 * Bring the cache up to date before answering a page. Skips apps refreshed
 * within RC_STALE_MINUTES (or RC_FLOOR_SECONDS when the reader pressed
 * refresh), so an open tab and a heavy finger cost the same as one visit.
 *
 * The wait is bounded: past `budgetMs` the caller is answered from the cache
 * and the pull carries on writing to the database, because a dashboard that
 * hangs on a slow upstream is worse than one showing numbers from an hour ago
 * next to when they were fetched.
 */
export async function ensureFresh({ app = null, force = false, budgetMs = 12_000 } = {}) {
  if (!rcConfigured()) return;

  const linked = async () =>
    (await q(`SELECT app, project_id, last_polled_at FROM rc_projects${app ? ' WHERE app = $1' : ''} ORDER BY app`, app ? [app] : [])).rows;

  let rows = await linked();
  // Nothing linked yet is the first-run case, and a forced fleet-wide refresh
  // is how a project added in RevenueCat later gets picked up.
  if (rows.length === 0 || (force && !app)) {
    try {
      await once('__sync', () => syncProjects());
      rows = await linked();
    } catch (err) {
      log.warn('rc project sync failed', { err: String(err?.message ?? err) });
    }
  }

  const floor = (force ? cfg.rcFloorSeconds : cfg.rcStaleMinutes * 60) * 1000;
  const due = rows.filter((r) => !r.last_polled_at || Date.now() - Date.parse(r.last_polled_at) > floor);
  if (due.length === 0) return;

  await Promise.race([Promise.allSettled(due.map(pullOne)), sleep(budgetMs)]);
}

/** Read side for Cockpit: the cards for every linked app, and one app's daily series. */
export async function revenue({ app = null, days = 30 }) {
  const projects = (await q(
    `SELECT p.app, p.name, p.project_id, p.last_polled_at, p.last_error,
            o.currency, o.metrics, o.fetched_at
     FROM rc_projects p
     LEFT JOIN LATERAL (
       SELECT currency, metrics, fetched_at FROM rc_overview o
       WHERE o.app = p.app ORDER BY fetched_at DESC LIMIT 1
     ) o ON true
     ORDER BY p.app`,
  )).rows;

  let series = {};
  if (app) {
    const { rows } = await q(
      `SELECT chart, to_char(day, 'YYYY-MM-DD') AS day, value::float8 AS value
       FROM rc_series WHERE app = $1 AND day >= (current_date - make_interval(days => $2 - 1))
       ORDER BY chart, day`,
      [app, days],
    );
    // The date is formatted in SQL for the same reason the events queries do
    // it: a `date` comes back through node-postgres as local midnight and
    // shifts a day when it crosses JSON.
    for (const r of rows) (series[r.chart] ??= []).push({ day: r.day, value: r.value });
  }

  return { configured: rcConfigured(), apps: projects, series };
}
