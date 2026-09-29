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
//       "highlight": { "event": "workout_completed", "done_prop": "completed" }
//     }
//   }
//
// `events` adds to the common names below. `highlight` names the one event
// the dashboard counts per period, and which boolean prop marks it as done
// (the "completion rate"). Both are optional; an app missing from the file
// still works, with only the common names known and no highlight.
import { readFileSync } from 'node:fs';

import { cfg } from './config.mjs';

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
    out[app] = { events, highlight };
  }
  return out;
}

const catalog = cfg.catalogFile ? parseCatalog(readFileSync(cfg.catalogFile, 'utf8')) : {};

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
