// The event names each app is expected to send, supplied by the operator as
// data (CATALOG_FILE), not code. An unknown name is still stored (a shipped
// app must never lose data because the server is behind), just flagged
// `known = false` so the dashboard can show it as either a typo to fix or a
// name to add to the catalog.
//
// CATALOG_FILE is a JSON object keyed by app slug:
//
//   {
//     "myapp": {
//       "events": ["workout_started", "workout_completed"],
//       "highlight": { "event": "workout_completed", "done_prop": "completed" },
//       "funnels": [
//         { "name": "First workout", "steps": ["app_first_opened", "onboarding_completed", "workout_completed"] },
//         { "name": "Paywall", "window_days": 3, "steps": [
//           "paywall_viewed", "purchase_started",
//           { "event": "purchase_result", "where": { "result": "purchased" }, "label": "Purchased" }
//         ] }
//       ],
//       "breakdowns": [
//         { "event": "workout_completed", "prop": "kind", "title": "Workouts by kind" },
//         { "event": "onboarding_completed", "prop": "goal", "count": "installs" }
//       ]
//     }
//   }
//
// `events` adds to the common names below. `highlight` names the one event
// the dashboard counts per period, and which boolean prop marks it as done
// (the "completion rate"). `funnels` are ordered: each step must follow the
// one before, within `window_days` (default 7) of the first; a step may
// match props with `where`. `breakdowns` pin charts to the app page: one
// event split by one prop, counted in events or (`count: "installs"`, for an
// answer that can change later) in installs. All optional; an app missing from the file still
// works, with only the common names known, no highlight, and the default
// paywall funnel.
import { readFileSync } from 'node:fs';

import { cfg } from './config.mjs';
import { DEMO_CATALOG } from './demo.mjs';
import { DEFAULT_FUNNELS, parseFunnels, parseStep } from './funnels.mjs';

// Every app gets the generic lifecycle names even before it has a catalog of
// its own, so a newly wired app does not light up the "unknown events" list.
export const COMMON = ['app_first_opened', 'session_started', 'screen_viewed', 'paywall_viewed', 'purchase_started', 'purchase_result', 'restore_result', 'ticket_opened'];

// The paywall funnel every app shares, in order. The dashboard renders it as
// counts of distinct installs at each step.
export const FUNNEL = ['paywall_viewed', 'purchase_started', 'purchase_result'];

const NAME = /^[a-z][a-z0-9_]{1,63}$/;

/** Parses and checks a catalog; throws with the offending path so a bad file stops the boot, not a request. */
export function parseCatalog(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('catalog: expected an object keyed by app slug');
  const out = {};
  for (const [app, entry] of Object.entries(data)) {
    // A bare array is accepted as the events list.
    const spec = Array.isArray(entry) ? { events: entry } : entry;
    if (!spec || typeof spec !== 'object') throw new Error(`catalog.${app}: expected an object or an array of event names`);
    const events = spec.events ?? [];
    if (!Array.isArray(events) || !events.every((e) => typeof e === 'string' && NAME.test(e))) {
      throw new Error(`catalog.${app}.events: expected event names matching ${NAME}`);
    }
    let highlight = null;
    if (spec.highlight != null) {
      const { event, done_prop: doneProp = null } = spec.highlight;
      if (typeof event !== 'string' || !NAME.test(event)) throw new Error(`catalog.${app}.highlight.event: expected an event name`);
      if (doneProp !== null && (typeof doneProp !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(doneProp))) {
        throw new Error(`catalog.${app}.highlight.done_prop: expected a prop name`);
      }
      highlight = { event, doneProp };
    }
    const funnels = parseFunnels(spec.funnels, `catalog.${app}.funnels`);
    const breakdowns = parseBreakdowns(spec.breakdowns, `catalog.${app}.breakdowns`);
    let appStoreId = null;
    if (spec.app_store_id != null) {
      appStoreId = String(spec.app_store_id);
      if (!/^[1-9][0-9]{5,11}$/.test(appStoreId)) throw new Error(`catalog.${app}.app_store_id: the App Store id, digits`);
    }
    const conversionValues = parseConversionValues(spec.conversion_values, `catalog.${app}.conversion_values`);
    out[app] = { events, highlight, funnels, breakdowns, appStoreId, conversionValues };
  }
  return out;
}

const PROP = /^[a-z][a-z0-9_]{0,39}$/;
const humanize = (s) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function parseBreakdowns(raw, path) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 12) throw new Error(`${path}: expected up to 12 breakdowns`);
  return raw.map((b, i) => {
    if (!b || typeof b.event !== 'string' || !NAME.test(b.event)) throw new Error(`${path}[${i}].event: expected an event name`);
    if (typeof b.prop !== 'string' || !PROP.test(b.prop)) throw new Error(`${path}[${i}].prop: expected a prop name`);
    const count = b.count ?? 'events';
    if (count !== 'events' && count !== 'installs') throw new Error(`${path}[${i}].count: "events" or "installs"`);
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 60) : `${humanize(b.event)} by ${b.prop.replace(/_/g, ' ')}`;
    return { event: b.event, prop: b.prop, title, count };
  });
}

const COARSE = ['low', 'medium', 'high'];

/**
 * The conversion values an app reports to Apple's ad attribution (and so to
 * the ad network): milestones in order, each a fine value 1-63 and a coarse
 * low/medium/high, reached when its event happens (with `where` like a funnel
 * step). The SDK raises the value, never lowers it; `lock` ends the first
 * window early, at a milestone after which nothing more is worth waiting for.
 * The same table goes into the ad network (Meta: Events Manager, SKAdNetwork),
 * which is how it reads the values.
 */
function parseConversionValues(raw, path) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error(`${path}: expected up to 20 milestones`);
  let last = 0;
  let lastCoarse = 0;
  return raw.map((m, i) => {
    const step = parseStep(m);
    if (typeof step === 'string') throw new Error(`${path}[${i}]: ${step}`);
    if (!Number.isInteger(m.value) || m.value <= last || m.value > 63) throw new Error(`${path}[${i}].value: 1 to 63, higher than the one before`);
    const coarse = COARSE.indexOf(m.coarse ?? 'low');
    if (coarse < lastCoarse) throw new Error(`${path}[${i}].coarse: low, medium or high, never lower than the one before`);
    last = m.value;
    lastCoarse = coarse;
    return { value: m.value, coarse: COARSE[coarse], event: step.event, where: step.where, label: step.label, lock: m.lock === true };
  });
}

const catalog = cfg.catalogFile ? parseCatalog(readFileSync(cfg.catalogFile, 'utf8')) : cfg.demo ? parseCatalog(DEMO_CATALOG) : {};

const known = new Map();
export function isKnown(app, name) {
  let set = known.get(app);
  if (!set) {
    set = new Set([...COMMON, ...(catalog[app]?.events ?? [])]);
    known.set(app, set);
  }
  return set.has(name);
}

/** The app's highlight event, or null when the catalog names none. */
export const highlightOf = (app) => catalog[app]?.highlight ?? null;

/** The app's funnels from the catalog, or the default paywall funnel. */
export const funnelsOf = (app) => catalog[app]?.funnels ?? DEFAULT_FUNNELS;

/** Charts the catalog pins to the app page, in its order; none by default. */
export const breakdownsOf = (app) => catalog[app]?.breakdowns ?? [];

/** The app's App Store id (a string of digits), or null. */
export const appStoreIdOf = (app) => catalog[app]?.appStoreId ?? null;

/** The app whose App Store id this is, for a postback that names only the id. */
export const appOfStoreId = (id) => Object.entries(catalog).find(([, v]) => v.appStoreId === String(id))?.[0] ?? null;

/** The app's conversion-value milestones, in order; none by default. */
export const conversionValuesOf = (app) => catalog[app]?.conversionValues ?? [];
