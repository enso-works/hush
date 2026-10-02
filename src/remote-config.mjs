// Remote config on the server: what GET /v1/config serves, and what the
// dashboard reads and writes.
//
// The catalog (CATALOG_FILE) declares every key with its type, default and
// rules; the dashboard may override a key's default, its rules or both, live
// (config_overrides, migration 009), and every change is kept
// (config_changes). The server never evaluates a key for a device: it sends
// every install of an app the same merged keys, and the device works out its
// value (evaluate.mjs). The dashboard's "preview as" runs the same evaluator
// here, on what the operator types in or on an install's stored row.
//
// An override that no longer fits (its key left the catalog, its type
// changed, or its key left and came back) stays stored and is not served:
// the catalog's entry is, until someone saves it again or reverts it.
import { configOf, conversionValuesOf } from './catalog.mjs';
import { CONFIG_LIMITS, ConfigError, parseNote, parseOverride, revisionOf, sizeOf, wireKeys } from './config-schema.mjs';
import { log } from './config.mjs';
import { q, tx } from './db.mjs';
import { bucket, evaluate, languageOf, parseVersion } from './evaluate.mjs';

const STALE = 'from before the key left the catalog: save it again or revert it';
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// default_value IS NOT NULL tells "not overridden" from a stored value: pg
// hands back SQL NULL and JSON null alike.
const OVERRIDES = `SELECT key, default_value, default_value IS NOT NULL AS has_default, rules, note, updated_at, orphaned_at
                     FROM config_overrides WHERE app = $1`;

/** A stored row's override parts: { default?, rules? }. */
const partsOf = (row) => ({
  ...(row.has_default ? { default: row.default_value } : {}),
  ...(row.rules !== null ? { rules: row.rules } : {}),
});

/**
 * The catalog merged with the stored overrides, for one app. `rows` are its
 * config_overrides rows. Per catalog key: the catalog's entry, the stored
 * override, what is served (`effective`, notes kept) and from where, and why
 * an override is not served. Orphans: overrides whose key the catalog lacks.
 */
function resolve(app, rows) {
  const catalog = configOf(app);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keys = Object.entries(catalog).map(([key, entry]) => {
    const row = byKey.get(key);
    let served = null;
    let problem = null;
    let fits = true;
    if (row) {
      try {
        served = parseOverride(partsOf(row), entry.type);
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        problem = err.message;
        fits = false;
      }
      // A key that left the catalog and came back may mean something else
      // now: its old override waits for someone to look at it.
      if (served && row.orphaned_at) {
        served = null;
        problem = STALE;
      }
    }
    const fromOverride = (part) => Boolean(served && has(served, part));
    return {
      key,
      type: entry.type,
      description: entry.description,
      catalog: { default: entry.default, rules: entry.rules },
      row: row ?? null,
      effective: {
        default: fromOverride('default') ? served.default : entry.default,
        rules: fromOverride('rules') ? served.rules : entry.rules,
      },
      source: { default: fromOverride('default') ? 'override' : 'catalog', rules: fromOverride('rules') ? 'override' : 'catalog' },
      problem,
      fits,
    };
  });
  const orphans = rows.filter((r) => !has(catalog, r.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
  return { keys, orphans };
}

/** The /v1/config answer for resolved keys: conversion values first, as before 2.4, then config with its revision. */
function answerOf(app, keys) {
  const conversionValues = conversionValuesOf(app).map(({ value, coarse, event, where, lock }) => ({ value, coarse, event, where, lock }));
  const wire = wireKeys(Object.fromEntries(keys.map((k) => [k.key, { type: k.type, ...k.effective }])));
  const revision = revisionOf({ conversion_values: conversionValues, config: { keys: wire } });
  return { body: { conversion_values: conversionValues, config: { revision, keys: wire } }, revision };
}

async function build(app) {
  const { rows } = await q(OVERRIDES, [app]);
  return { ...answerOf(app, resolve(app, rows).keys), builtAt: Date.now() };
}

// --- The answer cache. Every launch and every refresh of every 2.4 install
// asks /v1/config, and the answer is the same for all of them, so it is
// built at most every 10 s per app, one build at a time. A stale answer is
// served at once while the next is built behind it; a write in this process
// drops it, so the request after a save waits and serves the change.
const FRESH_MS = 10_000;
const cache = new Map();
const stateOf = (app) => {
  let s = cache.get(app);
  if (!s) {
    s = { answer: null, lastGood: null, building: null, gen: 0 };
    cache.set(app, s);
  }
  return s;
};

function rebuild(app, s) {
  if (s.building) return s.building;
  const gen = s.gen;
  const p = build(app)
    .then((answer) => {
      // A write since this build started may have changed what it read.
      if (s.gen === gen) {
        s.answer = answer;
        s.lastGood = answer;
      }
      return answer;
    })
    .catch((err) => {
      if (!s.lastGood) throw err;
      log.warn('config: rebuilding the answer failed, serving the last good one', { app, err: String(err?.message ?? err) });
      return s.lastGood;
    })
    .finally(() => {
      if (s.building === p) s.building = null;
    });
  s.building = p;
  return p;
}

/** The app's /v1/config answer: { body, revision }. */
export async function configAnswer(app) {
  const s = stateOf(app);
  if (s.answer) {
    if (Date.now() - s.answer.builtAt >= FRESH_MS) rebuild(app, s).catch(() => {});
    return s.answer;
  }
  return rebuild(app, s);
}

/** Forgets the app's answer after a write, and any build that may have read the overrides before it. */
function dropAnswer(app) {
  const s = stateOf(app);
  s.gen += 1;
  s.answer = null;
  s.building = null;
}

/**
 * Whether an If-None-Match header names this revision (or is `*`). Weak
 * validators count: a proxy that compresses the answer may weaken the ETag.
 */
export function matchesRevision(header, revision) {
  if (typeof header !== 'string' || !header) return false;
  return header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === '*' || t === `"${revision}"`);
}

// --- Admin views

// jsonb hands objects back in its own key order; the view reads in the
// normalized one, as the catalog's and the effective rules do.
const overrideView = (row) => ({ ...ordered(partsOf(row)), note: row.note, updated_at: row.updated_at });

async function latestChanges(app, client = { query: q }) {
  const { rows } = await client.query('SELECT key, max(id) AS id FROM config_changes WHERE app = $1 GROUP BY key', [app]);
  return new Map(rows.map((r) => [r.key, Number(r.id)]));
}

const keyView = (k, changes) => ({
  key: k.key,
  type: k.type,
  description: k.description,
  catalog: k.catalog,
  override: k.row ? overrideView(k.row) : null,
  effective: k.effective,
  source: k.source,
  problem: k.problem,
  fits: k.fits,
  change: changes.get(k.key) ?? 0,
});

export const appExists = async (app) => (await q('SELECT 1 FROM apps WHERE slug = $1', [app])).rowCount > 0;

/** GET /admin/apps/:app/config. */
export async function adminConfig(app) {
  const [{ rows }, changes] = await Promise.all([q(OVERRIDES, [app]), latestChanges(app)]);
  const { keys, orphans } = resolve(app, rows);
  const { body, revision } = answerOf(app, keys);
  return {
    app,
    revision,
    size_bytes: sizeOf(body.config.keys),
    limits: CONFIG_LIMITS,
    keys: keys.map((k) => keyView(k, changes)),
    orphans: orphans.map((r) => ({ key: r.key, override: overrideView(r), change: changes.get(r.key) ?? 0 })),
  };
}

/** One key's admin view as it is now, or null when the catalog lacks the key. */
async function currentKeyView(app, key) {
  const view = await adminConfig(app);
  return view.keys.find((k) => k.key === key) ?? null;
}

// --- Writes. Every write names `base`, the latest change id for the key
// the editor loaded; another id is a 409, so two people editing one key
// cannot overwrite each other unseen. One advisory lock per app, so two
// saves to different keys cannot each pass the size check and together
// exceed it.

const badRequest = (path, message) => ({ status: 400, body: { error: path ? `${path}: ${message}` : message, path, message } });
const BASE_MESSAGE = 'the change id the editor started from, a whole number';
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

async function locked(app, key, base, fn) {
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hush.config:' || $1))", [app]);
    const { rows: [latest] } = await client.query('SELECT coalesce(max(id), 0) AS id FROM config_changes WHERE app = $1 AND key = $2', [app, key]);
    if (Number(latest.id) !== base) return { conflict: true };
    const { rows } = await client.query(OVERRIDES, [app]);
    return fn(client, rows);
  });
}

// What /v1/config served for a key, notes kept; null when the catalog lacks it.
const effectiveIn = (resolved, key) => resolved.keys.find((k) => k.key === key)?.effective ?? null;
const storedIn = (rows, key) => {
  const row = rows.find((r) => r.key === key);
  return row ? partsOf(row) : null;
};

async function insertChange(client, { app, key, action, overrideBefore, overrideAfter, effectiveBefore, effectiveAfter, note }) {
  // jsonb parameters go as JSON text: pg would send a JS array as a Postgres array.
  const j = (v) => (v === null ? null : JSON.stringify(v));
  await client.query(
    `INSERT INTO config_changes (app, key, action, override_before, override_after, effective_before, effective_after, note)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
    [app, key, action, j(overrideBefore), j(overrideAfter), j(effectiveBefore), j(effectiveAfter), note ?? null],
  );
}

async function afterWrite(app, key) {
  dropAnswer(app);
  const { revision } = await configAnswer(app);
  return { ok: true, revision, key: await currentKeyView(app, key) };
}

const conflict = async (app, key) => ({ status: 409, body: { error: 'changed since you opened it', key: await currentKeyView(app, key) } });

function checkBase(body) {
  if (!isObject(body)) return { status: 400, body: { error: 'expected a JSON object' } };
  if (!Number.isSafeInteger(body.base) || body.base < 0) return badRequest('base', BASE_MESSAGE);
  return null;
}

/** POST /admin/apps/:app/config/:key: { base, default?, rules?, note? }. Returns { status, body }. */
export async function setOverride(app, key, body) {
  const bad = checkBase(body);
  if (bad) return bad;
  if (!has(configOf(app), key)) return { status: 404, body: { error: 'no such key in the catalog' } };
  const entry = configOf(app)[key];
  if (!has(body, 'default') && !has(body, 'rules')) return badRequest('', 'override the default, the rules or both');
  const out = await locked(app, key, body.base, async (client, rows) => {
    let override;
    let note;
    try {
      override = parseOverride(body, entry.type);
      note = parseNote(body.note);
    } catch (err) {
      if (err instanceof ConfigError) return badRequest(err.path, err.detail);
      throw err;
    }
    const before = resolve(app, rows);
    // The size of what would be served, from the overrides read under the
    // lock: the cached answer may be older than another save just committed.
    const newRow = {
      key,
      default_value: has(override, 'default') ? override.default : null,
      has_default: has(override, 'default'),
      rules: override.rules ?? null,
      note: note ?? null,
      updated_at: new Date(),
      orphaned_at: null,
    };
    const after = resolve(app, [...rows.filter((r) => r.key !== key), newRow]);
    const bytes = sizeOf(answerOf(app, after.keys).body.config.keys);
    if (bytes > CONFIG_LIMITS.total_bytes) {
      return badRequest('', `the app's config would be ${Math.ceil(bytes / 1024)} KB as JSON; the limit is 64 KB`);
    }
    const j = (v) => (v === null ? null : JSON.stringify(v));
    await client.query(
      `INSERT INTO config_overrides (app, key, default_value, rules, note, updated_at, orphaned_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now(), NULL)
       ON CONFLICT (app, key) DO UPDATE
          SET default_value = EXCLUDED.default_value, rules = EXCLUDED.rules, note = EXCLUDED.note,
              updated_at = now(), orphaned_at = NULL`,
      [app, key, newRow.has_default ? j(override.default) : null, j(newRow.rules), newRow.note],
    );
    await insertChange(client, {
      app,
      key,
      action: 'set',
      overrideBefore: storedIn(rows, key),
      overrideAfter: override,
      effectiveBefore: effectiveIn(before, key),
      effectiveAfter: effectiveIn(after, key),
      note,
    });
    return { done: true };
  });
  if (out.conflict) return conflict(app, key);
  if (!out.done) return out;
  return { status: 200, body: await afterWrite(app, key) };
}

/** DELETE /admin/apps/:app/config/:key: { base, note? }. Reverts the key to the catalog, orphans and overrides not served included. */
export async function revertOverride(app, key, body) {
  const bad = checkBase(body);
  if (bad) return bad;
  let note;
  try {
    note = parseNote(body.note);
  } catch (err) {
    if (err instanceof ConfigError) return badRequest(err.path, err.detail);
    throw err;
  }
  const out = await locked(app, key, body.base, async (client, rows) => {
    const stored = storedIn(rows, key);
    if (!stored) return { status: 404, body: { error: 'no override' } };
    const before = resolve(app, rows);
    const after = resolve(app, rows.filter((r) => r.key !== key));
    await client.query('DELETE FROM config_overrides WHERE app = $1 AND key = $2', [app, key]);
    await insertChange(client, {
      app,
      key,
      action: 'revert',
      overrideBefore: stored,
      overrideAfter: null,
      effectiveBefore: effectiveIn(before, key),
      effectiveAfter: effectiveIn(after, key),
      note,
    });
    return { done: true };
  });
  if (out.conflict) return conflict(app, key);
  if (!out.done) return out;
  return { status: 200, body: await afterWrite(app, key) };
}

// --- History. One row holds four override and effective values of up to
// 64 KB each, so a page stops once its rows pass 1 MB of JSON, and rows are
// read a chunk at a time by their estimated size: a page of 50 such rows
// would otherwise be read into memory whole first.
const PAGE_BYTES = 1024 * 1024;
// jsonb hands objects back with its own key order; the history reads in the
// normalized one (config-schema.mjs).
const WHEN_ORDER = ['platform', 'version', 'channel', 'language', 'pro'];
const orderedRule = (r) => ({
  when: Object.fromEntries(WHEN_ORDER.filter((f) => has(r.when ?? {}, f)).map((f) => [f, r.when[f]])),
  rollout: r.rollout,
  value: r.value,
  ...(r.note === undefined ? {} : { note: r.note }),
});
const ordered = (v) => v && {
  ...(has(v, 'default') ? { default: v.default } : {}),
  ...(has(v, 'rules') && Array.isArray(v.rules) ? { rules: v.rules.map(orderedRule) } : {}),
};
const HISTORY_COLUMNS = 'id, key, at, action, override_before, override_after, effective_before, effective_after, note';

/** GET /admin/apps/:app/config/history: { changes, more }, newest first. */
export async function history(app, { key = null, limit = 20, before = null } = {}) {
  limit = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 50);
  const params = [app];
  let where = 'app = $1';
  if (key !== null) {
    params.push(key);
    where += ` AND key = $${params.length}`;
  }
  if (before !== null) {
    params.push(before);
    where += ` AND id < $${params.length}`;
  }
  // jsonb's text has spaces JSON.stringify leaves out, so this overestimates;
  // the constant covers the fields outside the four values.
  const { rows: candidates } = await q(
    `SELECT id,
            200 + coalesce(octet_length(override_before::text), 0) + coalesce(octet_length(override_after::text), 0)
                + coalesce(octet_length(effective_before::text), 0) + coalesce(octet_length(effective_after::text), 0)
                + coalesce(octet_length(note), 0) AS size
       FROM config_changes WHERE ${where} ORDER BY id DESC LIMIT ${limit + 1}`,
    params,
  );
  const page = candidates.slice(0, limit);
  const changes = [];
  let bytes = 0;
  let i = 0;
  fill: while (i < page.length) {
    let j = i + 1;
    let estimate = Number(page[i].size);
    while (j < page.length && estimate + Number(page[j].size) <= PAGE_BYTES) estimate += Number(page[j++].size);
    const { rows } = await q(`SELECT ${HISTORY_COLUMNS} FROM config_changes WHERE id = ANY($1::bigint[]) ORDER BY id DESC`, [page.slice(i, j).map((c) => c.id)]);
    for (const row of rows) {
      const change = {
        ...row,
        id: Number(row.id),
        override_before: ordered(row.override_before),
        override_after: ordered(row.override_after),
        effective_before: ordered(row.effective_before),
        effective_after: ordered(row.effective_after),
      };
      changes.push(change);
      bytes += Buffer.byteLength(JSON.stringify(change));
      if (bytes > PAGE_BYTES) break fill;
    }
    i = j;
  }
  return { changes, more: candidates.length > changes.length };
}

// --- Preview as: what a device with this context, or this install, gets.

const PARAMS = ['install', 'platform', 'version', 'channel', 'language', 'pro', 'key'];
const FIELDS = ['platform', 'version', 'channel', 'language', 'pro'];
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

/** Every bucket 0-99 evaluated, grouped by the rule that decided it: the rules in order, the default last. */
function outcomes(entry, context) {
  const byRule = new Map();
  for (let b = 0; b < 100; b++) {
    const e = evaluate(entry, context, b);
    const o = byRule.get(e.rule) ?? { rule: e.rule, ...(e.value === undefined ? {} : { value: e.value }), share: 0 };
    o.share += 1;
    byRule.set(e.rule, o);
  }
  return [...byRule.values()].sort((a, b) => (a.rule === -1) - (b.rule === -1) || a.rule - b.rule);
}

/** GET /admin/apps/:app/config/preview. `params` is the URL's searchParams. Returns { status, body }. */
export async function preview(app, params) {
  const get = (name) => {
    const v = params.get(name);
    return v === null || v === '' ? null : v;
  };
  for (const name of PARAMS) {
    if ((get(name) ?? '').length > 64) return { status: 400, body: { error: `${name}: at most 64 characters` } };
  }
  const install = get('install')?.toLowerCase() ?? null;
  if (install !== null && !isUuid(install)) return { status: 400, body: { error: 'install: expected an install id' } };
  const proParam = get('pro');
  if (proParam !== null && proParam !== 'true' && proParam !== 'false') return { status: 400, body: { error: 'pro: true or false' } };
  const key = get('key');
  const catalog = configOf(app);
  const rawDraft = params.get('draft');
  if (rawDraft !== null && key === null) return { status: 400, body: { error: 'draft: needs key' } };
  if (key !== null && !has(catalog, key)) return { status: 404, body: { error: 'no such key in the catalog' } };
  let draft = null;
  if (rawDraft !== null) {
    try {
      draft = JSON.parse(rawDraft);
    } catch {
      return { status: 400, body: { error: 'draft: not JSON' } };
    }
    if (!isObject(draft)) return badRequest('draft', 'expected a JSON object');
    try {
      draft = parseOverride(draft, catalog[key].type, 'draft.');
    } catch (err) {
      if (err instanceof ConfigError) return badRequest(err.path, err.detail);
      throw err;
    }
  }

  const context = {
    platform: get('platform'),
    version: get('version'),
    channel: get('channel'),
    language: get('language'),
    pro: proParam === null ? null : proParam === 'true',
  };
  const fromInstall = [];
  const warnings = [];
  if (install !== null) {
    const { rows: [row] } = await q('SELECT platform, version, channel, locale, pro FROM installs WHERE id = $1 AND app = $2', [install, app]);
    if (!row) return { status: 404, body: { error: 'install not found' } };
    const stored = { platform: row.platform, version: row.version, channel: row.channel, language: row.locale };
    for (const field of ['platform', 'version', 'channel', 'language']) {
      if (context[field] === null && stored[field]) {
        context[field] = stored[field];
        fromInstall.push(field);
      }
    }
    // installs.pro is false by default and keeps its value when a batch
    // has none, so only true says anything.
    if (context.pro === null && row.pro === true) {
      context.pro = true;
      fromInstall.push('pro');
    }
    if (proParam === null && row.pro === false) {
      warnings.push('the install row cannot tell a free install from one that never said; add pro=false to preview a free device');
    }
  }
  if (context.version !== null && !parseVersion(context.version)) warnings.push(`version "${context.version}" cannot be read, so no version condition holds`);
  if (context.language !== null && !languageOf(context.language)) warnings.push(`language "${context.language}" is not a language, so no language condition holds`);
  if (fromInstall.includes('pro')) warnings.push("pro comes from the install's last batch; a device that has never called identify() treats it as unknown");
  if (fromInstall.includes('language')) warnings.push("language comes from the phone's locale; an app that passes its own language to remoteConfig may be evaluated with another");

  const { rows } = await q(OVERRIDES, [app]);
  const keys = resolve(app, rows).keys
    .filter((k) => key === null || k.key === key)
    .map((k) => {
      const isDraft = draft !== null && k.key === key;
      const entry = isDraft
        ? { type: k.type, default: has(draft, 'default') ? draft.default : k.catalog.default, rules: has(draft, 'rules') ? draft.rules : k.catalog.rules }
        : { type: k.type, ...k.effective };
      const out = { key: k.key, type: k.type, draft: isDraft, outcomes: outcomes(entry, context) };
      if (install !== null) {
        const place = bucket(install, k.key);
        const e = evaluate(entry, context, place);
        Object.assign(out, { ...(e.value === undefined ? {} : { value: e.value }), rule: e.rule, bucket: place });
      }
      return out;
    });
  return {
    status: 200,
    body: {
      install,
      context: Object.fromEntries(FIELDS.map((f) => [f, context[f]])),
      from_install: fromInstall,
      warnings,
      keys,
    },
  };
}

// --- Boot: say which stored overrides are not served, and mark the ones
// whose key the catalog dropped, so the key coming back does not bring its
// old override back with it.

/** Marks orphans and logs a warning per override not served. Returns how many were logged. */
export async function checkOverridesAtBoot() {
  const { rows } = await q('SELECT DISTINCT app FROM config_overrides ORDER BY app');
  let n = 0;
  for (const { app } of rows) {
    const { rows: overrides } = await q(OVERRIDES, [app]);
    const { keys, orphans } = resolve(app, overrides);
    if (orphans.length) {
      await q('UPDATE config_overrides SET orphaned_at = now() WHERE app = $1 AND key = ANY($2::text[]) AND orphaned_at IS NULL', [app, orphans.map((o) => o.key)]);
    }
    for (const o of orphans) {
      log.warn('config: override not served', { app, key: o.key, reason: 'not in the catalog' });
      n += 1;
    }
    for (const k of keys.filter((x) => x.problem)) {
      log.warn('config: override not served', { app, key: k.key, reason: k.problem });
      n += 1;
    }
  }
  return n;
}
