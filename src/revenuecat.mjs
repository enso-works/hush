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
import { q, tx } from './db.mjs';

const API = 'https://api.revenuecat.com/v2';

// Chart names as the API spells them, which is neither what the dashboard
// calls them nor, in one case, what the docs say: `customers_new`, not
// `new_customers`; `non-subscription_purchases` with a hyphen. Asking for a
// name outside the enum is a 400 whose message lists every valid one, which is
// where this list was checked against.
//
// These are the ones that describe customers and money over time. Left out on
// purpose: the *_movement charts and subscription_status (stacked states, not
// a bar), cohort_explorer / prediction_explorer / subscription_retention
// (cohort grids), the ad_* family, and arr / ltv_per_paying_customer /
// trial_conversion_rate (each a restatement of one already here).
// `revenue` is first because the money scale is learned from it.
const CHARTS = [
  'revenue',
  'customers_active',
  'customers_new',
  'non-subscription_purchases',
  'actives',
  'trials',
  'mrr',
  'churn',
  'initial_conversion',
  'conversion_to_paying',
  'ltv_per_customer',
  'refund_rate',
];

// A chart RevenueCat does not have for this project is remembered as absent,
// and asked about again a week later in case the plan changed.
const RECHECK_DAYS = 7;
const WINDOW_DAYS = 90;

// Charts & Metrics allows 25 requests a minute per key. Staying under it is
// this module's job, not the caller's: a full pull is a dozen requests, and
// two apps refreshing at once must queue rather than earn a 429. Waiting here
// is safe because every caller has a budget (see `ensureFresh`).
const RATE_WINDOW = 60_000;
const recent = [];

async function slot() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > RATE_WINDOW) recent.shift();
    if (recent.length < cfg.rcRatePerMinute) return void recent.push(now);
    await sleep(RATE_WINDOW - (now - recent[0]) + 50);
  }
}

export const rcConfigured = () => Boolean(cfg.rcApiKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10);

async function rc(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  await slot();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.rcApiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(`revenuecat ${path}: ${detail}`), { status: res.status });
  }
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

/**
 * Point an app at a RevenueCat project.
 *
 * Pointing it at a *different* project throws the cache away in the same
 * transaction. Everything cached — the overview snapshot, the daily series,
 * which charts exist, the money scale — belongs to the project it came from,
 * and a later pull only upserts what it fetches, so a measure the new project
 * does not have would sit there under the new name indefinitely. Between the
 * two, the dashboard would show one project's money labelled as another's.
 * Relinking to the same project keeps everything.
 */
export async function link(app, projectId, name) {
  await tx(async (client) => {
    const prev = (await client.query('SELECT project_id FROM rc_projects WHERE app = $1', [app])).rows[0];
    if (prev && prev.project_id !== projectId) {
      for (const table of ['rc_overview', 'rc_series', 'rc_charts']) {
        await client.query(`DELETE FROM ${table} WHERE app = $1`, [app]);
      }
      log.info('rc project changed, cache dropped', { app, from: prev.project_id, to: projectId });
    }
    await client.query(
      `INSERT INTO rc_projects (app, project_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (app) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         name = EXCLUDED.name,
         linked_at = now(),
         money_scale     = CASE WHEN rc_projects.project_id = EXCLUDED.project_id THEN rc_projects.money_scale ELSE 1 END,
         last_polled_at  = CASE WHEN rc_projects.project_id = EXCLUDED.project_id THEN rc_projects.last_polled_at ELSE NULL END,
         last_success_at = CASE WHEN rc_projects.project_id = EXCLUDED.project_id THEN rc_projects.last_success_at ELSE NULL END,
         last_error      = CASE WHEN rc_projects.project_id = EXCLUDED.project_id THEN rc_projects.last_error ELSE NULL END`,
      [app, projectId, name ?? null],
    );
  });
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
 * A chart's points, flattened into one row per measure and day.
 *
 * RevenueCat returns `{cohort, measure, value, incomplete}` — the cohort is the
 * period start in epoch seconds, the measure is an index into the chart's
 * `measures` array, and every measure of every period is its own entry. So a
 * 30-day revenue chart is 90 entries: Revenue, Transactions and Ad Impressions
 * for each day. `incomplete` marks the period still being filled in (today),
 * whose value is kept and corrected by the next pull.
 *
 * Anything that is not that shape is logged with a sample rather than charted
 * as something it isn't.
 */
export function normalizeChart(values, measures, chart) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const out = [];
  let complained = false;
  for (const entry of values) {
    const measure = measures?.[entry?.measure]?.display_name;
    const value = Number(entry?.value);
    const day = Number.isFinite(entry?.cohort) ? ymd(new Date(entry.cohort * 1000)) : null;
    if (day === null || !measure || !Number.isFinite(value)) {
      if (!complained) {
        complained = true;
        log.warn('rc chart shape unrecognised', { chart, sample: JSON.stringify(entry).slice(0, 200) });
      }
      continue;
    }
    out.push({ measure, day, value });
  }
  return out;
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
    `INSERT INTO rc_series (app, chart, measure, day, value)
     SELECT $1, $2, m, d::date, v FROM unnest($3::text[], $4::text[], $5::numeric[]) AS t(m, d, v)
     ON CONFLICT (app, chart, measure, day) DO UPDATE SET value = EXCLUDED.value`,
    [app, chart, points.map((p) => p.measure), points.map((p) => p.day), points.map((p) => p.value)],
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

async function markChart(app, chart, { supported, displayName = null, measures = [], note = null }) {
  await q(
    `INSERT INTO rc_charts (app, chart, supported, display_name, measures, checked_at, note)
     VALUES ($1, $2, $3, $4, $5::jsonb, now(), $6)
     ON CONFLICT (app, chart) DO UPDATE
       SET supported = EXCLUDED.supported, display_name = COALESCE(EXCLUDED.display_name, rc_charts.display_name),
           measures = CASE WHEN EXCLUDED.measures = '[]'::jsonb THEN rc_charts.measures ELSE EXCLUDED.measures END,
           checked_at = now(), note = EXCLUDED.note`,
    [app, chart, supported, displayName, JSON.stringify(measures), note],
  );
}

/** The charts worth asking for this time: everything known to work, plus anything not asked about in the last week. */
async function chartsToPull(app) {
  const known = new Map((await q('SELECT chart, supported, checked_at FROM rc_charts WHERE app = $1', [app])).rows.map((r) => [r.chart, r]));
  return CHARTS.filter((chart) => {
    const row = known.get(chart);
    if (!row) return true;
    return row.supported || Date.now() - Date.parse(row.checked_at) > RECHECK_DAYS * 86400_000;
  });
}

async function pullApp({ app, project_id: projectId }) {
  const end = new Date();
  const start = new Date(end.getTime() - (WINDOW_DAYS - 1) * 86400_000);
  const currency = cfg.rcCurrency;
  const range = { resolution: 'day', start_date: ymd(start), end_date: ymd(end), currency };

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

  // The authoritative 28-day total, which is what the revenue chart is
  // calibrated against; also the only money number that is certain.
  let authoritative = null;
  try {
    const total = await rc(`/projects/${projectId}/metrics/revenue`, { start_date: ymd(start), end_date: ymd(end), currency });
    authoritative = Number(total?.value);
  } catch (err) {
    log.warn('rc revenue total skipped', { app, err: String(err?.message ?? err) });
  }

  let scale = Number((await q('SELECT money_scale FROM rc_projects WHERE app = $1', [app])).rows[0]?.money_scale ?? 1);

  // Charts that answered with something other than "I do not exist". Those are
  // the ones whose absence from the page would otherwise be invisible.
  const failed = [];

  const pullChart = async (chart) => {
    try {
      const data = await rc(`/projects/${projectId}/charts/${chart}`, range);
      const measures = Array.isArray(data?.measures) ? data.measures : [];
      const points = normalizeChart(data?.values, measures, chart);
      // Whether a measure is money is the measure's own `unit`, not a guess
      // from the chart's name: the revenue chart returns dollars *and* a
      // transaction count, and `conversion_to_paying` returns two counts and a
      // percentage.
      const money = new Set(measures.filter((m) => m.unit === '$').map((m) => m.display_name));

      // `revenue` comes first in CHARTS, so every money measure everywhere is
      // scaled by what its own dollars taught us.
      if (chart === 'revenue' && authoritative !== null) {
        const dollars = points.filter((p) => money.has(p.measure)).reduce((a, p) => a + p.value, 0);
        const learned = scaleFor(dollars, authoritative);
        if (learned !== scale) {
          log.info('rc money scale learned', { app, scale: learned });
          await q('UPDATE rc_projects SET money_scale = $2 WHERE app = $1', [app, learned]);
        }
        scale = learned;
      }

      await writeSeries(app, chart, scale === 1 ? points : points.map((p) => (money.has(p.measure) ? { ...p, value: p.value * scale } : p)));
      await markChart(app, chart, { supported: true, displayName: data?.display_name ?? null, measures });
    } catch (err) {
      const message = String(err?.message ?? err);
      // A chart this project does not have is a 404, and a name outside the
      // API's enum is a 400: both are remembered and asked about again in a
      // week. A rate limit says nothing about the chart, so it ends the pull
      // instead of marking anything.
      if (err?.status === 429) throw err;
      if (err?.status === 404 || err?.status === 400) {
        await markChart(app, chart, { supported: false, note: message.slice(0, 200) });
      } else {
        // A timeout or a 500 says nothing about the chart; it says this pull
        // did not finish, and the caller has to know that.
        failed.push(chart);
      }
      log.warn('rc chart skipped', { app, chart, err: message });
    }
  };

  // Revenue alone first, because every other money measure is scaled by what
  // it teaches. The rest go four at a time: RevenueCat answers a chart in
  // about three quarters of a second, so a dozen in series is ten seconds and
  // a page that gives up waiting. The limiter, not the loop, is what keeps
  // this inside the rate.
  const wanted = await chartsToPull(app);
  if (wanted.includes('revenue')) await pullChart('revenue');
  const rest = wanted.filter((c) => c !== 'revenue');
  for (let i = 0; i < rest.length; i += 4) await Promise.all(rest.slice(i, i + 4).map(pullChart));

  // The revenue total is money on the cards, so its failure counts too.
  if (authoritative === null) failed.push('revenue total');
  return { failed };
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
      // A pull can half-work: the overview lands and three charts time out.
      // That is not a success to report silently — the cards would be new
      // beside charts that are hours old and say nothing about it.
      const { failed } = await pullApp(row);
      // Named, but not all twelve of them: this is one line on a dashboard.
      const note = failed.length
        ? `not updated: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}`
        : null;
      await q('UPDATE rc_projects SET last_polled_at = now(), last_success_at = now(), last_error = $2 WHERE app = $1', [row.app, note]);
      if (note) log.warn('rc pull partial', { app: row.app, failed });
    } catch (err) {
      const message = String(err?.message ?? err);
      // The attempt is recorded so the staleness check backs off, but
      // last_success_at is left alone: the data is as old as it ever was, and
      // the dashboard says so rather than calling it just-checked.
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
    `SELECT p.app, p.name, p.project_id, p.last_polled_at, p.last_success_at, p.last_error,
            o.currency, o.metrics, o.fetched_at
     FROM rc_projects p
     LEFT JOIN LATERAL (
       SELECT currency, metrics, fetched_at FROM rc_overview o
       WHERE o.app = p.app ORDER BY fetched_at DESC LIMIT 1
     ) o ON true
     ORDER BY p.app`,
  )).rows;

  // One series per chart and measure, in the order CHARTS lists them, each
  // carrying RevenueCat's own label and unit. The page draws what it is given
  // and formats by the unit, so a chart added here needs no UI change.
  const series = [];
  if (app) {
    const { rows } = await q(
      `SELECT s.chart, s.measure, c.display_name AS chart_name, c.measures,
              to_char(s.day, 'YYYY-MM-DD') AS day, s.value::float8 AS value
       FROM rc_series s LEFT JOIN rc_charts c ON c.app = s.app AND c.chart = s.chart
       WHERE s.app = $1 AND s.day >= (current_date - make_interval(days => $2 - 1))
       ORDER BY s.chart, s.measure, s.day`,
      [app, days],
    );
    // The date is formatted in SQL for the same reason the events queries do
    // it: a `date` comes back through node-postgres as local midnight and
    // shifts a day when it crosses JSON.
    const found = new Map();
    for (const r of rows) {
      const key = `${r.chart} ${r.measure}`;
      if (!found.has(key)) {
        const measures = r.measures ?? [];
        const meta = measures.find((m) => m.display_name === r.measure);
        const chartName = r.chart_name ?? r.chart.replace(/[-_]/g, ' ');
        found.set(key, {
          chart: r.chart,
          chartName,
          measure: r.measure,
          // A chart with one measure is better named by the chart: the
          // `actives` chart's measure is called "Actives", the chart is called
          // "Active Subscriptions", and the second is the one worth reading.
          name: measures.length === 1 ? chartName : r.measure,
          unit: meta?.unit ?? '#',
          position: meta ? measures.indexOf(meta) : 99,
          points: [],
        });
      }
      found.get(key).points.push({ day: r.day, value: r.value });
    }

    const order = (s) => {
      const i = CHARTS.indexOf(s.chart);
      return (i === -1 ? CHARTS.length : i) * 100 + s.position;
    };
    const ordered = [...found.values()].sort((a, b) => order(a) - order(b));

    // Charts share measures: "New Customers" is a column of `customers_new`,
    // `initial_conversion`, `conversion_to_paying` and `ltv_per_customer`
    // alike, with the same numbers in each. Same name and same numbers is one
    // series, kept where CHARTS puts it first; same name and different numbers
    // keeps both, told apart by the chart each came from.
    const seen = new Set();
    for (const s of ordered) {
      const fingerprint = `${s.name}|${s.points.map((p) => p.day + ':' + p.value).join(',')}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      series.push(s);
    }
    const clash = new Set(series.filter((s, i) => series.findIndex((o) => o.name === s.name) !== i).map((s) => s.name));
    for (const s of series) if (clash.has(s.name) && s.name !== s.chartName) s.name = `${s.name} · ${s.chartName}`;
  }

  return { configured: rcConfigured(), apps: projects, series };
}
