// Read-side queries for the Cockpit pages. Plain SQL over `events` and
// `installs`: at fleet volume (well under a million rows a year) a GROUP BY
// over an indexed range is milliseconds, and rollup tables would be a second
// source of truth to keep honest for no gain.
import { FUNNEL } from './catalog.mjs';
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
  return rows;
}

export async function appDetail({ app, days, env }) {
  const args = [app, env, days];

  const daily = (await q(
    // The day is text, not a date: node-postgres parses a `date` into a JS
    // Date at local midnight, which comes back over JSON shifted by the
    // reader's offset — a bar chart silently off by one.
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM installs i WHERE i.app = $1 AND i.env = $2 AND i.first_seen >= d AND i.first_seen < d + interval '1 day') AS new_installs,
        (SELECT count(DISTINCT e.install)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND e.at >= d AND e.at < d + interval '1 day') AS active,
        (SELECT count(DISTINCT e.session)::int FROM events e WHERE e.app = $1 AND e.env = $2 AND e.at >= d AND e.at < d + interval '1 day') AS sessions
     FROM generate_series(date_trunc('day', now()) - make_interval(days => $3 - 1), date_trunc('day', now()), interval '1 day') d
     ORDER BY d`,
    args,
  )).rows;

  const versions = (await q(
    `SELECT COALESCE(version, 'unknown') AS version, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND at >= now() - make_interval(days => $3)
     GROUP BY 1 ORDER BY installs DESC LIMIT 12`,
    args,
  )).rows;

  const events = (await q(
    `SELECT name, known, count(*)::int AS n, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND at >= now() - make_interval(days => $3)
     GROUP BY 1, 2 ORDER BY n DESC LIMIT 40`,
    args,
  )).rows;

  const funnel = (await q(
    `SELECT name, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND at >= now() - make_interval(days => $3) AND name = ANY($4)
     GROUP BY 1`,
    [...args, FUNNEL],
  )).rows;
  const purchased = (await q(
    `SELECT count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND at >= now() - make_interval(days => $3)
       AND name = 'purchase_result' AND props->>'result' = 'purchased'`,
    args,
  )).rows[0].installs;

  const countries = (await q(
    // Below ten installs a country column identifies people rather than
    // describing them, so those rows are folded into "other".
    `SELECT CASE WHEN n >= 10 THEN country ELSE 'other' END AS country, sum(n)::int AS installs
     FROM (SELECT COALESCE(country, 'unknown') AS country, count(*)::int AS n
           FROM installs WHERE app = $1 AND env = $2 GROUP BY 1) c
     GROUP BY 1 ORDER BY installs DESC LIMIT 12`,
    [app, env],
  )).rows;

  const unknown = events.filter((e) => !e.known).map((e) => ({ name: e.name, n: e.n }));

  return {
    app,
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

/** One event's props sliced by a single key — how the Braele card gets sessions by pattern without any app-specific SQL living here. */
export async function breakdown({ app, env, days, event, prop }) {
  const { rows } = await q(
    `SELECT COALESCE(props->>$5, 'unset') AS value, count(*)::int AS n, count(DISTINCT install)::int AS installs
     FROM events WHERE app = $1 AND env = $2 AND at >= now() - make_interval(days => $3) AND name = $4
     GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    [app, env, days, event, prop],
  );
  return rows;
}
