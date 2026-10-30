// A website's reports (docs/web.md, phase 3): visitors and visits rather than
// installs and sessions, where they came from, the pages they landed on, and
// how many visits reached the site's goal. The same `events` and `installs`
// rows an app's reports read; a visit is a session, which the web SDK carries
// across page loads for half an hour.
import { goalOf, isPrivateScreen, promotedBy } from './catalog.mjs';
import { installRetention } from './config.mjs';
import { q } from './db.mjs';

// Events that say nothing about whether anyone read the page: a visit with
// only these, and one page, is a bounce. Anything else (a click, the site's
// own events, visit_engaged after ten seconds in view) makes it engaged.
const PASSIVE = ['session_started', 'screen_viewed', 'app_first_opened'];

// The device a visit came from, by what the web SDK reads from the user agent.
// A phone can install an app from a store link; a desktop cannot.
const DEVICE = `CASE WHEN i.device IN ('iPhone', 'iPod', 'Android phone') THEN 'phone'
  WHEN i.device IN ('iPad', 'Android tablet') THEN 'tablet' ELSE 'desktop' END`;

// $1 app, $2 env, $3 from (days ago), $4 to (days ago), $5 channel, $6 goal.
const byChannel = `($5::text IS NULL OR COALESCE(channel, 'unknown') = $5)`;
const VISITS = `
  ev AS (
    SELECT install, session, name, props, at FROM events
    WHERE app = $1 AND env = $2 AND ${byChannel} AND session IS NOT NULL
      AND at >= now() - make_interval(days => $3) AND at < now() - make_interval(days => $4)
  ),
  visits AS (
    SELECT session, (array_agg(install))[1] AS install, min(at) AS at,
      count(*) FILTER (WHERE name = 'screen_viewed') AS pages,
      bool_or(name = $6) AS goal,
      (bool_or(name <> ALL ('{${PASSIVE.join(',')}}'::text[])) OR count(*) FILTER (WHERE name = 'screen_viewed') >= 2) AS engaged
    FROM ev GROUP BY session
  )`;

// Where a visit came from: its link's utm_source, else the site that sent it,
// else nothing ("direct": typed, bookmarked, or a referrer the browser hid).
const SOURCE = `COALESCE(NULLIF(s.props->>'utm_source', ''), NULLIF(s.props->>'referrer', ''), 'direct')`;
const SOURCE_KIND = `CASE WHEN NULLIF(s.props->>'utm_source', '') IS NOT NULL THEN 'tag'
  WHEN NULLIF(s.props->>'referrer', '') IS NOT NULL THEN 'referrer' ELSE 'direct' END`;
const STARTS = `starts AS (SELECT DISTINCT ON (session) session, props FROM ev WHERE name = 'session_started' ORDER BY session, at)`;

async function totals(args, from, to) {
  const [app, env, , , channel] = args;
  const row = (await q(
    `WITH ${VISITS}
     SELECT
       (SELECT count(DISTINCT install)::int FROM ev) AS visitors,
       (SELECT count(*)::int FROM visits) AS visits,
       (SELECT count(*)::int FROM visits WHERE engaged) AS engaged,
       (SELECT count(*)::int FROM ev WHERE name = 'screen_viewed') AS pageviews,
       (SELECT count(*)::int FROM visits WHERE goal) AS goal_visits,
       (SELECT count(DISTINCT install)::int FROM visits WHERE goal) AS goal_visitors`,
    [app, env, from, to, channel, args[5]],
  )).rows[0];
  // First seen in the window, and inside the install retention window: an
  // older visitor is on record only if it came back, and counting it as new
  // would make every return look like growth.
  row.new_visitors = (await q(
    `SELECT count(*)::int AS n FROM installs
     WHERE app = $1 AND env = $2 AND ($5::text IS NULL OR COALESCE(channel, 'unknown') = $5)
       AND first_seen >= now() - make_interval(days => LEAST($3, $6::int)) AND first_seen < now() - make_interval(days => $4)`,
    [app, env, from, to, channel, installRetention],
  )).rows[0].n;
  return row;
}

/**
 * Everything a website's page shows for the period: totals against the one
 * before, visitors per day, sources, campaigns, landing pages, pages, devices,
 * countries, the links and stores clicked, and the site's own events.
 */
export async function webReport({ app, env, days, channel = null }) {
  const goal = goalOf(app) ?? 'store_clicked';
  const args = [app, env, days, 0, channel, goal];
  const current = await totals(args, days, 0);
  const prior = await totals(args, days * 2, days);

  const daily = (await q(
    `WITH ${VISITS}
     SELECT to_char(d, 'YYYY-MM-DD') AS day,
       (SELECT count(DISTINCT install)::int FROM ev WHERE at >= d AND at < d + interval '1 day') AS visitors,
       (SELECT count(*)::int FROM visits WHERE at >= d AND at < d + interval '1 day') AS visits,
       (SELECT count(*)::int FROM visits WHERE goal AND at >= d AND at < d + interval '1 day') AS goal_visits,
       (SELECT count(*)::int FROM installs i WHERE i.app = $1 AND i.env = $2 AND ($5::text IS NULL OR COALESCE(i.channel, 'unknown') = $5)
          AND i.first_seen >= d AND i.first_seen < d + interval '1 day') AS new_visitors
     FROM generate_series(date_trunc('day', now()) - make_interval(days => $3 - 1), date_trunc('day', now()), interval '1 day') d
     ORDER BY d`,
    args,
  )).rows;

  const sources = (await q(
    `WITH ${VISITS}, ${STARTS}
     SELECT ${SOURCE} AS source, ${SOURCE_KIND} AS kind,
       count(*)::int AS visits, count(DISTINCT v.install)::int AS visitors,
       count(*) FILTER (WHERE v.engaged)::int AS engaged, count(*) FILTER (WHERE v.goal)::int AS goal_visits
     FROM visits v LEFT JOIN starts s USING (session)
     GROUP BY 1, 2 ORDER BY visits DESC LIMIT 15`,
    args,
  )).rows;

  const campaigns = (await q(
    `WITH ${VISITS}, ${STARTS}
     SELECT s.props->>'utm_campaign' AS campaign, ${SOURCE} AS source,
       count(*)::int AS visits, count(DISTINCT v.install)::int AS visitors,
       count(*) FILTER (WHERE v.engaged)::int AS engaged, count(*) FILTER (WHERE v.goal)::int AS goal_visits
     FROM visits v JOIN starts s USING (session)
     WHERE NULLIF(s.props->>'utm_campaign', '') IS NOT NULL
     GROUP BY 1, 2 ORDER BY visits DESC LIMIT 15`,
    args,
  )).rows;

  // A visit's first page: what the link, the search or the post pointed at.
  const landing = (await q(
    `WITH ${VISITS},
       firsts AS (SELECT DISTINCT ON (session) session, props->>'screen' AS page FROM ev WHERE name = 'screen_viewed' ORDER BY session, at)
     SELECT COALESCE(f.page, 'unknown') AS page, count(*)::int AS visits,
       count(*) FILTER (WHERE v.engaged)::int AS engaged, count(*) FILTER (WHERE v.goal)::int AS goal_visits
     FROM visits v LEFT JOIN firsts f USING (session)
     GROUP BY 1 ORDER BY visits DESC LIMIT 15`,
    args,
  )).rows.filter((r) => !isPrivateScreen(app, r.page));

  const pages = (await q(
    `WITH ${VISITS}
     SELECT props->>'screen' AS page, count(*)::int AS views, count(DISTINCT install)::int AS visitors
     FROM ev WHERE name = 'screen_viewed' AND props->>'screen' IS NOT NULL
     GROUP BY 1 ORDER BY views DESC LIMIT 20`,
    args,
  )).rows.filter((r) => !isPrivateScreen(app, r.page));

  const devices = (await q(
    `WITH ${VISITS}
     SELECT ${DEVICE} AS device, count(*)::int AS visits, count(DISTINCT v.install)::int AS visitors,
       count(*) FILTER (WHERE v.engaged)::int AS engaged, count(*) FILTER (WHERE v.goal)::int AS goal_visits
     FROM visits v JOIN installs i ON i.id = v.install
     GROUP BY 1 ORDER BY visits DESC`,
    args,
  )).rows;

  const countries = (await q(
    // Below ten visitors a country identifies people rather than describing
    // them, so those rows are folded into "other", as on an app's page.
    `WITH ${VISITS},
       c AS (SELECT COALESCE(i.country, 'unknown') AS country, count(DISTINCT i.id)::int AS n
             FROM installs i WHERE i.id IN (SELECT DISTINCT install FROM ev) GROUP BY 1)
     SELECT CASE WHEN n >= 10 THEN country ELSE 'other' END AS country, sum(n)::int AS visitors
     FROM c GROUP BY 1 ORDER BY visitors DESC LIMIT 12`,
    args,
  )).rows;

  const clicks = async (name, prop) =>
    (await q(
      `WITH ${VISITS}
       SELECT COALESCE(props->>'${prop}', 'unset') AS value, count(*)::int AS clicks, count(DISTINCT install)::int AS visitors
       FROM ev WHERE name = '${name}' GROUP BY 1 ORDER BY clicks DESC LIMIT 12`,
      args,
    )).rows;

  // The site's own events (a signup, a play button): what the catalog adds to
  // what the SDK sends by itself.
  const events = (await q(
    `SELECT name, bool_and(known) AS known, count(*)::int AS n, count(DISTINCT install)::int AS visitors
     FROM events WHERE app = $1 AND env = $2 AND ($4::text IS NULL OR COALESCE(channel, 'unknown') = $4)
       AND at >= now() - make_interval(days => $3)
       AND name <> ALL ('{session_started,screen_viewed,app_first_opened,store_clicked,link_clicked,visit_engaged}'::text[])
     GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    [app, env, days, channel],
  )).rows;

  return {
    app,
    goal: { event: goal },
    current,
    prior,
    daily,
    sources,
    campaigns,
    landing,
    pages,
    devices,
    countries,
    stores: await clicks('store_clicked', 'store'),
    links: await clicks('link_clicked', 'host'),
    events,
  };
}

/**
 * For an app: the websites that sell it, and the campaigns their visitors
 * clicked through to a store with, next to what App Store Connect counted for
 * the same campaign (`ct`, which the web SDK sets from the visit's campaign).
 * Two separate counts side by side, never joined person by person: a store
 * click is not an install, and Apple's numbers are its own.
 */
export async function websitesFor({ app, env, days }) {
  const sites = promotedBy(app);
  if (!sites.length) return { websites: [], campaigns: [] };
  const websites = (await q(
    `SELECT a.slug AS app, a.name,
       (SELECT count(DISTINCT install)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.at >= now() - make_interval(days => $3)) AS visitors,
       (SELECT count(DISTINCT session)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.at >= now() - make_interval(days => $3)) AS visits,
       (SELECT count(*)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.name = 'store_clicked' AND e.at >= now() - make_interval(days => $3)) AS store_clicks,
       (SELECT count(DISTINCT session)::int FROM events e WHERE e.app = a.slug AND e.env = $2 AND e.name = 'store_clicked' AND e.at >= now() - make_interval(days => $3)) AS store_visits
     FROM apps a WHERE a.slug = ANY($1) ORDER BY a.slug`,
    [sites, env, days],
  )).rows;
  const clicked = (await q(
    `SELECT COALESCE(NULLIF(props->>'campaign', ''), '') AS campaign, count(*)::int AS store_clicks, count(DISTINCT session)::int AS visits
     FROM events WHERE app = ANY($1) AND env = $2 AND name = 'store_clicked' AND at >= now() - make_interval(days => $3)
       AND COALESCE(props->>'store', 'app_store') = 'app_store'
     GROUP BY 1`,
    [sites, env, days],
  )).rows;
  const store = (await q(
    `SELECT campaign, metric, sum(value)::float8 AS value FROM asc_campaigns
     WHERE app = $1 AND campaign <> '' AND day >= current_date - make_interval(days => $2 - 1) AND metric IN ('page_views', 'first_downloads')
     GROUP BY 1, 2`,
    [app, days],
  )).rows;
  const apple = new Map();
  for (const r of store) apple.set(r.campaign, { ...apple.get(r.campaign), [r.metric]: r.value });
  const campaigns = clicked.map((c) => ({
    ...c,
    app_store: c.campaign && apple.has(c.campaign) ? { page_views: apple.get(c.campaign).page_views ?? null, first_downloads: apple.get(c.campaign).first_downloads ?? null } : null,
  }));
  campaigns.sort((a, b) => b.store_clicks - a.store_clicks);
  return { websites, campaigns };
}
