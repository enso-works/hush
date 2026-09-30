// Funnels and cohorts: the questions a flat event count cannot answer. How
// many installs that started onboarding finished it, and how long it took;
// how many installs from each week are still around weeks later.
import { q } from './db.mjs';

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const PROP = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_STEPS = 8;
const MAX_FUNNELS = 10;

// What every app gets while its catalog names no funnels: the paywall, in
// order, ending in an actual purchase.
export const DEFAULT_FUNNELS = [
  {
    name: 'Paywall',
    window_days: 7,
    steps: [
      { event: 'paywall_viewed', where: null, label: 'Paywall viewed' },
      { event: 'purchase_started', where: null, label: 'Purchase started' },
      { event: 'purchase_result', where: { result: 'purchased' }, label: 'Purchased' },
    ],
  },
];

const humanize = (s) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * A step as the catalog writes it: an event name, or { event, where, label }
 * where `where` matches props by value (all of them, compared as text).
 * Returns the step, or a string naming what is wrong.
 */
export function parseStep(raw) {
  const spec = typeof raw === 'string' ? { event: raw } : raw;
  if (!spec || typeof spec !== 'object') return 'a step is an event name or { event, where, label }';
  if (typeof spec.event !== 'string' || !NAME.test(spec.event)) return `step event "${spec.event}" is not an event name`;
  let where = null;
  if (spec.where != null) {
    if (typeof spec.where !== 'object' || Array.isArray(spec.where)) return `step ${spec.event}: where is { prop: value }`;
    const entries = Object.entries(spec.where);
    if (entries.length === 0 || entries.length > 3) return `step ${spec.event}: where has one to three props`;
    for (const [k, v] of entries) {
      if (!PROP.test(k)) return `step ${spec.event}: "${k}" is not a prop name`;
      if (!['string', 'number', 'boolean'].includes(typeof v)) return `step ${spec.event}: where.${k} must be a string, number or boolean`;
    }
    where = Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
  }
  const label = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim().slice(0, 60) : humanize(spec.event);
  return { event: spec.event, where, label };
}

/** A funnel from the catalog; throws naming the path, so a bad catalog stops the boot. */
export function parseFunnels(raw, path) {
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.length > MAX_FUNNELS) throw new Error(`${path}: expected up to ${MAX_FUNNELS} funnels`);
  return raw.map((f, i) => {
    if (!f || typeof f.name !== 'string' || !f.name.trim()) throw new Error(`${path}[${i}].name: expected a name`);
    if (!Array.isArray(f.steps) || f.steps.length < 2 || f.steps.length > MAX_STEPS) {
      throw new Error(`${path}[${i}].steps: expected 2 to ${MAX_STEPS} steps`);
    }
    const steps = f.steps.map((s) => parseStep(s));
    const bad = steps.find((s) => typeof s === 'string');
    if (bad) throw new Error(`${path}[${i}]: ${bad}`);
    const window = f.window_days ?? 7;
    if (!Number.isInteger(window) || window < 1 || window > 90) throw new Error(`${path}[${i}].window_days: 1 to 90`);
    return { name: f.name.trim().slice(0, 60), window_days: window, steps };
  });
}

/** Steps from the dashboard's query string: `event` or `event:prop=value`. */
export function stepsFromQuery(values) {
  if (values.length < 2 || values.length > MAX_STEPS) return `2 to ${MAX_STEPS} steps`;
  const steps = [];
  for (const v of values) {
    const [event, cond] = v.split(':', 2);
    let where;
    if (cond) {
      const eq = cond.indexOf('=');
      if (eq < 1) return `step "${v}": expected event:prop=value`;
      where = { [cond.slice(0, eq)]: cond.slice(eq + 1).slice(0, 100) };
    }
    const step = parseStep({ event, where });
    if (typeof step === 'string') return step;
    steps.push(step);
  }
  return steps;
}

const byChannel = (n, col) => `($${n}::text IS NULL OR COALESCE(${col}, 'unknown') = $${n})`;

/**
 * An ordered funnel: installs that did step 1 in the period, then step 2 at or
 * after it, and so on, every step within `windowDays` of the first. For each
 * step, how many installs got there and the median time from the step before.
 */
export async function runFunnel({ app, env, days, channel = null, steps, windowDays = 7 }) {
  const params = [app, env, days, channel, windowDays];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const match = (step) =>
    [`e.name = ${p(step.event)}`, ...Object.entries(step.where ?? {}).map(([k, v]) => `e.props->>${p(k)} = ${p(v)}`)].join(' AND ');

  const ctes = steps.map((step, i) => {
    if (i === 0) {
      return `s0 AS (
        SELECT e.install, min(e.at) AS t, min(e.at) AS t0 FROM events e
        WHERE e.app = $1 AND e.env = $2 AND ${byChannel(4, 'e.channel')}
          AND e.at >= now() - make_interval(days => $3) AND ${match(step)}
        GROUP BY e.install)`;
    }
    // The same event twice in a row means a second occurrence, strictly later.
    const after = steps[i - 1].event === step.event ? '>' : '>=';
    return `s${i} AS (
        SELECT prev.install, min(e.at) AS t, prev.t0 FROM s${i - 1} prev
        JOIN events e ON e.install = prev.install AND e.app = $1 AND e.env = $2
        WHERE e.at ${after} prev.t AND e.at <= prev.t0 + make_interval(days => $5) AND ${match(step)}
        GROUP BY prev.install, prev.t0)`;
  });
  const cols = steps.map((_, i) =>
    i === 0
      ? '(SELECT count(*)::int FROM s0) AS n0, NULL::int AS m0'
      : `(SELECT count(*)::int FROM s${i}) AS n${i},
         (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM cur.t - prev.t)))::int
            FROM s${i} cur JOIN s${i - 1} prev USING (install)) AS m${i}`,
  );
  const { rows } = await q(`WITH ${ctes.join(',\n')} SELECT ${cols.join(',\n')}`, params);
  const r = rows[0];
  return steps.map((step, i) => ({
    event: step.event,
    where: step.where,
    label: step.label,
    installs: r[`n${i}`],
    // Median seconds from the previous step, among installs that made it.
    median_s: r[`m${i}`],
  }));
}

/**
 * Weekly cohorts: installs grouped by the week they first appeared (Monday
 * to Sunday, UTC), and for each later week the share that sent anything.
 * The latest `weeks` cohorts, oldest first; `active[k]` is week k after the
 * cohort's own, null where that week has not happened yet.
 */
export async function cohorts({ app, env, channel = null, weeks = 8 }) {
  const { rows: sizes } = await q(
    `SELECT to_char(date_trunc('week', first_seen), 'YYYY-MM-DD') AS week, count(*)::int AS installs
     FROM installs
     WHERE app = $1 AND env = $2 AND ${byChannel(3, 'channel')}
       AND first_seen >= date_trunc('week', now()) - make_interval(weeks => $4 - 1)
     GROUP BY 1 ORDER BY 1`,
    [app, env, channel, weeks],
  );
  const { rows: activity } = await q(
    `SELECT to_char(date_trunc('week', i.first_seen), 'YYYY-MM-DD') AS week,
            (extract(epoch FROM date_trunc('week', e.at) - date_trunc('week', i.first_seen)) / 604800)::int AS k,
            count(DISTINCT e.install)::int AS n
     FROM installs i JOIN events e ON e.install = i.id AND e.app = $1 AND e.env = $2
     WHERE i.app = $1 AND i.env = $2 AND ${byChannel(3, 'i.channel')}
       AND i.first_seen >= date_trunc('week', now()) - make_interval(weeks => $4 - 1)
       AND e.at >= date_trunc('week', i.first_seen)
     GROUP BY 1, 2`,
    [app, env, channel, weeks],
  );
  const thisWeek = new Date();
  thisWeek.setUTCHours(0, 0, 0, 0);
  thisWeek.setUTCDate(thisWeek.getUTCDate() - ((thisWeek.getUTCDay() + 6) % 7));
  return sizes.map(({ week, installs }) => {
    const elapsed = Math.round((thisWeek.getTime() - Date.parse(`${week}T00:00:00Z`)) / 604800000);
    const active = Array.from({ length: weeks }, (_, k) =>
      k > elapsed ? null : (activity.find((a) => a.week === week && a.k === k)?.n ?? 0),
    );
    return { week, installs, active };
  });
}
