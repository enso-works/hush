// Read-side queries for the dashboard. Plain SQL over `events` and
// `installs`: at small-app volume (well under a million rows a year) a GROUP BY
// over an indexed range is milliseconds, and rollup tables would be a second
// source of truth to keep honest for no gain.
import { FUNNEL, highlightOf } from './catalog.mjs';
import { q } from './db.mjs';

export async function summary({ days, env }) {
  const { rows } = await q(
    `SELECT a.slug AS app, a.name,
        (SELECT count(*)::int FROM installs i WHERE i.app = a.slug AND i.env = $2 AND i.first_seen >= now() - make_interval(days => $1)) AS new_installs,
        (SELECT count(*)::int FROM installs i WHERE i.app = a.slug AND i.env = $2) AS total_installs,
        (SELECT count(DISTINCT e.install)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.at >= now() - interval '1 day') AS dau,
        (SELECT count(DISTINCT e.install)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.at >= now() - interval '7 days') AS wau,
        (SELECT count(DISTINCT e.install)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.at >= now() - interval '30 days') AS mau,
        (SELECT count(DISTINCT e.session)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.at >= now() - make_interval(days => $1)) AS sessions,
        (SELECT count(*)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.at >= now() - make_interval(days => $1)) AS events,
        (SELECT count(*)::int FROM tickets t WHERE t.app = a.slug AND t.status = 'open') AS open_tickets,
        (SELECT max(e.at) FROM events e WHERE e.app = a.slug AND e.env = $2) AS last_event
     FROM apps a ORDER BY a.slug`,
    [days, env],
  );
  // Active installs per day over the same window, one query for every app,
  // with the quiet days filled in: the overview draws it as a sparkline.
  const { rows: daily } = await q(
    `SELECT app, to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(DISTINCT install)::int AS n
     FROM events WHERE env = $2 AND at >= date_trunc('day', now()) - make_interval(days => $1 - 1)
     GROUP BY 1, 2`,
    [days, env],
  );
  const today = new Date();
  const dayKeys = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1 - i)));
    return d.toISOString().slice(0, 10);
  });
  const byApp = new Map();
  for (const r of daily) byApp.set(`${r.app} ${r.day}`, r.n);
  return rows.map((a) => ({ ...a, trend: dayKeys.map((k) => byApp.get(`${a.app} ${k}`) ?? 0) }));
}

// A build-channel filter as a SQL predicate on parameter $n: NULL means every
// channel, 'unknown' the installs whose SDK sent none.
const byChannel = (n, col = 'channel') => `($${n}::text IS NULL OR COALESCE(${col}, 'unknown') = $${n})`;

export async function appDetail({ app, days, env, channel = null }) {
  const args = [app, env, days, channel];

  const daily = (await q(
    // The day is text, not a date: node-postgres parses a `date` into a JS
    // Date at local midnight, which comes back over JSON shifted by the
    // reader's offset — a bar chart silently off by one.
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM installs i WHERE i.app = $1 AND i.env = $2 AND ${byChannel(4, 'i.channel')} AND i.first_seen >= d AND i.first_seen < d + interval '1 day') AS new_installs,
        (SELECT count(DISTINCT e.install)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND ${byChannel(4, 'e.channel')} AND e.at >= d AND e.at < d + interval '1 day') AS active,
        (SELECT count(DISTINCT e.session)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND ${byChannel(4, 'e.channel')} AND e.at >= d AND e.at < d + interval '1 day') AS sessions
     FROM generate_series(date_trunc('day', now()) - make_interval(days => $3 - 1), date_trunc('day', now()), interval '1 day') d
     ORDER BY d`,
    args,
  )).rows;

  const versions = (await q(
    `SELECT COALESCE(version, 'unknown') AS version, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND ${byChannel(4)} AND at >= now() - make_interval(days => $3)
     GROUP BY 1 ORDER BY installs DESC LIMIT 12`,
    args,
  )).rows;

  const events = (await q(
    `SELECT name, known, count(*)::int AS n, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND ${byChannel(4)} AND at >= now() - make_interval(days => $3)
     GROUP BY 1, 2 ORDER BY n DESC LIMIT 40`,
    args,
  )).rows;

  const funnel = (await q(
    `SELECT name, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND ${byChannel(4)} AND at >= now() - make_interval(days => $3) AND name = ANY($5)
     GROUP BY 1`,
    [...args, FUNNEL],
  )).rows;
  const purchased = (await q(
    `SELECT count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND ${byChannel(4)} AND at >= now() - make_interval(days => $3)
       AND name = 'purchase_result' AND props->>'result' = 'purchased'`,
    args,
  )).rows[0].installs;

  const countries = (await q(
    // Below ten installs a country column identifies people rather than
    // describing them, so those rows are folded into "other".
    `SELECT CASE WHEN n >= 10 THEN country ELSE 'other' END AS country, sum(n)::int AS installs
     FROM (SELECT COALESCE(country, 'unknown') AS country, count(*)::int AS n
           FROM installs WHERE app = $1 AND env = $2 AND ${byChannel(3)} GROUP BY 1) c
     GROUP BY 1 ORDER BY installs DESC LIMIT 12`,
    [app, env, channel],
  )).rows;

  const unknown = events.filter((e) => !e.known).map((e) => ({ name: e.name, n: e.n }));

  // The same window, one window earlier, so the page can say "up 12%" and
  // mean something. Sessions and new installs are counts; active is the
  // distinct installs seen at all, which is what a small app's "audience" is.
  // `highlight` counts the app's own key event (the catalog names it), and
  // `highlight_done` how many of those carried its done prop as true; both
  // are 0 for an app whose catalog names none.
  const hl = highlightOf(app);
  const period = async (from, to) =>
    (await q(
      `SELECT
         (SELECT count(*)::int FROM installs i WHERE i.app = $1 AND i.env = $2 AND ${byChannel(7, 'i.channel')}
            AND i.first_seen >= now() - make_interval(days => $3) AND i.first_seen < now() - make_interval(days => $4)) AS new_installs,
         (SELECT count(DISTINCT e.session)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND ${byChannel(7, 'e.channel')}
            AND e.at >= now() - make_interval(days => $3) AND e.at < now() - make_interval(days => $4)) AS sessions,
         (SELECT count(DISTINCT e.install)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND ${byChannel(7, 'e.channel')}
            AND e.at >= now() - make_interval(days => $3) AND e.at < now() - make_interval(days => $4)) AS active,
         (SELECT count(*)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND ${byChannel(7, 'e.channel')} AND e.name = $5
            AND e.at >= now() - make_interval(days => $3) AND e.at < now() - make_interval(days => $4)) AS highlight,
         (SELECT count(*)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND ${byChannel(7, 'e.channel')} AND e.name = $5
            AND $6::text IS NOT NULL AND e.props->>$6::text = 'true'
            AND e.at >= now() - make_interval(days => $3) AND e.at < now() - make_interval(days => $4)) AS highlight_done`,
      [app, env, from, to, hl?.event ?? null, hl?.doneProp ?? null, channel],
    )).rows[0];
  const current = await period(days, 0);
  const prior = await period(days * 2, days);

  // Retention as "came back N or more days after the first open", counted
  // over installs old enough to have had the chance. Day-exact retention
  // (active on day 7 precisely) is the textbook number and is nearly always
  // zero at this volume; "still around a week later" is the question asked.
  const retention = (await q(
    `SELECT
       count(*) FILTER (WHERE i.first_seen < now() - interval '1 day')::int AS d1_cohort,
       count(*) FILTER (WHERE i.first_seen < now() - interval '1 day'
         AND EXISTS (SELECT 1 FROM events e WHERE e.install = i.id AND e.at >= i.first_seen + interval '1 day'))::int AS d1,
       count(*) FILTER (WHERE i.first_seen < now() - interval '7 days')::int AS d7_cohort,
       count(*) FILTER (WHERE i.first_seen < now() - interval '7 days'
         AND EXISTS (SELECT 1 FROM events e WHERE e.install = i.id AND e.at >= i.first_seen + interval '7 days'))::int AS d7,
       count(*) FILTER (WHERE i.first_seen < now() - interval '30 days')::int AS d30_cohort,
       count(*) FILTER (WHERE i.first_seen < now() - interval '30 days'
         AND EXISTS (SELECT 1 FROM events e WHERE e.install = i.id AND e.at >= i.first_seen + interval '30 days'))::int AS d30
     FROM installs i WHERE i.app = $1 AND i.env = $2 AND ${byChannel(4, 'i.channel')} AND i.first_seen >= now() - make_interval(days => $3)`,
    args,
  )).rows[0];

  // How long people stay and how often they come back. Session length comes
  // from session_started's prev_fg_s (SDK 2 sends the previous session's
  // foreground seconds with the next start, because an explicit "ended"
  // event dies with the process whenever iOS kills an app in the background),
  // so it is empty until an SDK 2 build is out.
  const engagement = (await q(
    `WITH lengths AS (
       SELECT (props->>'prev_fg_s')::numeric AS s FROM events
       WHERE app = $1 AND env = $2 AND ${byChannel(4)} AND name = 'session_started'
         AND at >= now() - make_interval(days => $3)
         AND jsonb_typeof(props->'prev_fg_s') = 'number' AND (props->>'prev_fg_s')::numeric > 0
     ), per_install AS (
       SELECT install, count(DISTINCT session) AS n FROM events
       WHERE app = $1 AND env = $2 AND ${byChannel(4)} AND at >= now() - make_interval(days => $3) AND session IS NOT NULL
       GROUP BY install
     )
     SELECT
       (SELECT count(*)::int FROM lengths) AS measured,
       (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s))::int FROM lengths) AS median_s,
       (SELECT round(percentile_cont(0.75) WITHIN GROUP (ORDER BY s))::int FROM lengths) AS p75_s,
       (SELECT round(avg(n), 1)::float8 FROM per_install) AS sessions_per_install,
       (SELECT json_build_array(
          count(*) FILTER (WHERE n = 1), count(*) FILTER (WHERE n = 2), count(*) FILTER (WHERE n BETWEEN 3 AND 5),
          count(*) FILTER (WHERE n BETWEEN 6 AND 10), count(*) FILTER (WHERE n > 10)) FROM per_install) AS sessions_histogram`,
    args,
  )).rows[0];

  // Which build channels the installs seen this period came from, for the
  // channel filter and the Channels panel. Unfiltered on purpose.
  const channels = (await q(
    `SELECT COALESCE(channel, 'unknown') AS channel, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND at >= now() - make_interval(days => $3)
     GROUP BY 1 ORDER BY installs DESC`,
    [app, env, days],
  )).rows;

  const todayActive = (await q(
    `SELECT count(DISTINCT install)::int AS n FROM events WHERE app = $1 AND env = $2 AND ${byChannel(3)} AND at >= date_trunc('day', now())`,
    [app, env, channel],
  )).rows[0].n;

  return {
    app,
    name: (await q('SELECT name FROM apps WHERE slug = $1', [app])).rows[0]?.name ?? app,
    channel,
    highlight: hl ? { event: hl.event, done_prop: hl.doneProp } : null,
    current,
    prior,
    retention: {
      d1: { cohort: retention.d1_cohort, retained: retention.d1 },
      d7: { cohort: retention.d7_cohort, retained: retention.d7 },
      d30: { cohort: retention.d30_cohort, retained: retention.d30 },
    },
    engagement: {
      measured: engagement.measured,
      median_s: engagement.median_s,
      p75_s: engagement.p75_s,
      sessions_per_install: engagement.sessions_per_install,
      // Installs by sessions this period: 1, 2, 3-5, 6-10, more than 10.
      sessions_histogram: engagement.sessions_histogram,
    },
    channels,
    todayActive,
    daily,
    versions,
    events,
    funnel: [...FUNNEL.map((name) => ({ name, installs: funnel.find((f) => f.name === name)?.installs ?? 0 })), { name: 'purchased', installs: purchased }],
    countries,
    unknown,
    tickets: (await q("SELECT count(*)::int AS open FROM tickets WHERE app = $1 AND status = 'open'", [app])).rows[0].open,
    lastEvent: (await q('SELECT max(at) AS at FROM events WHERE app = $1 AND env = $2', [app, env])).rows[0].at,
  };
}

/** The prop keys one event carries, most common first: what the breakdown can slice it by. */
export async function propKeys({ app, env, days, event }) {
  const { rows } = await q(
    `SELECT k AS key, count(*)::int AS n
     FROM events, jsonb_object_keys(props) k
     WHERE app = $1 AND env = $2 AND at >= now() - make_interval(days => $3) AND name = $4
     GROUP BY 1 ORDER BY n DESC LIMIT 30`,
    [app, env, days, event],
  );
  return rows;
}

/** One event's props sliced by a single key (sessions by pattern, purchases by product) without any app-specific SQL living here. */
export async function breakdown({ app, env, days, event, prop, channel = null }) {
  const { rows } = await q(
    `SELECT COALESCE(props->>$5, 'unset') AS value, count(*)::int AS n, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND ${byChannel(6)} AND at >= now() - make_interval(days => $3) AND name = $4
     GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    [app, env, days, event, prop, channel],
  );
  return rows;
}
