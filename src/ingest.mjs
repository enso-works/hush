import { isKnown } from './catalog.mjs';
import { q } from './db.mjs';
import { flatObject, isUuid, str } from './http.mjs';

export const MAX_EVENTS = 100;
export const MAX_PROPS_BYTES = 2048;
// The device queue holds seven days; accept a month so a phone that was off
// for a while still lands its history, and a day into the future so a clock a
// little fast is not silently dropped.
const MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

const EVENT_NAME = /^[a-z][a-z0-9_]{1,63}$/;

const cleanProps = (props) => flatObject(props, { maxBytes: MAX_PROPS_BYTES });

/**
 * Returns { events, installs } of validated rows, or a string naming the first
 * invalid field. Malformed events inside an otherwise valid batch are dropped
 * rather than failing the batch: the phone would only retry them forever.
 */
export function parseBatch(body, { app, env, country }) {
  if (!body || typeof body !== 'object') return 'body';
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const context = {
    version: str(ctx.version, 32),
    build: str(ctx.build, 32),
    platform: str(ctx.platform, 16),
    os: str(ctx.os, 32),
    device: str(ctx.device, 64),
    locale: str(ctx.locale, 16),
    rc_id: str(ctx.rc_id, 128),
    // Tri-state on purpose: an older app version, or a batch flushed before
    // RevenueCat answered, sends no `pro` at all — and must not be read as
    // "this install is no longer paid". Only an explicit false downgrades.
    pro: typeof ctx.pro === 'boolean' ? ctx.pro : null,
  };
  if (!Array.isArray(body.events) || body.events.length === 0) return 'events';
  if (body.events.length > MAX_EVENTS) return 'events: too many';

  const now = Date.now();
  const events = [];
  const installs = new Map();
  let rejected = 0;
  for (const e of body.events) {
    if (!e || typeof e !== 'object') { rejected++; continue; }
    const at = Date.parse(e.at);
    const props = cleanProps(e.props);
    if (
      !isUuid(e.id) ||
      !isUuid(e.install) ||
      (e.session !== undefined && e.session !== null && !isUuid(e.session)) ||
      typeof e.name !== 'string' || !EVENT_NAME.test(e.name) ||
      !Number.isFinite(at) || at < now - MAX_PAST_MS || at > now + MAX_FUTURE_MS ||
      props === null
    ) {
      rejected++;
      continue;
    }
    events.push({
      id: e.id,
      install: e.install,
      session: e.session ?? null,
      name: e.name,
      known: isKnown(app, e.name),
      at: new Date(at).toISOString(),
      props,
    });
    const prev = installs.get(e.install);
    if (!prev || at < prev) installs.set(e.install, at);
  }
  if (events.length === 0) return 'events: none valid';
  return { events, installs, context, rejected, app, env, country };
}

export async function store(batch) {
  const { app, env, context, country } = batch;
  for (const [id, firstAt] of batch.installs) {
    await q(
      `INSERT INTO installs (id, app, env, first_seen, last_seen, platform, os, device, locale, country, version, build, rc_id, pro)
       VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, false))
       ON CONFLICT (id) DO UPDATE SET
         last_seen = now(),
         -- An install that queued events offline can report a moment earlier
         -- than the row it already has.
         first_seen = LEAST(installs.first_seen, EXCLUDED.first_seen),
         platform = COALESCE(EXCLUDED.platform, installs.platform),
         os       = COALESCE(EXCLUDED.os, installs.os),
         device   = COALESCE(EXCLUDED.device, installs.device),
         locale   = COALESCE(EXCLUDED.locale, installs.locale),
         country  = COALESCE(EXCLUDED.country, installs.country),
         version  = COALESCE(EXCLUDED.version, installs.version),
         build    = COALESCE(EXCLUDED.build, installs.build),
         rc_id    = COALESCE(EXCLUDED.rc_id, installs.rc_id),
         -- $13, not EXCLUDED.pro: the inserted expression already folded a
         -- missing flag to false, so EXCLUDED can never be NULL here and the
         -- COALESCE would silently downgrade every paid install.
         pro      = COALESCE($13, installs.pro)`,
      [id, app, env, new Date(firstAt).toISOString(), context.platform, context.os, context.device, context.locale, country, context.version, context.build, context.rc_id, context.pro],
    );
  }

  const cols = 12;
  const values = [];
  const params = [];
  batch.events.forEach((e, i) => {
    const p = (n) => `$${i * cols + n}`;
    values.push(`(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)}::jsonb)`);
    params.push(e.id, app, env, e.install, e.session, e.name, e.known, e.at, context.version, context.build, context.platform, JSON.stringify(e.props));
  });
  // A retried batch collides on the event id and is counted, not stored twice.
  const inserted = await q(
    `INSERT INTO events (id, app, env, install, session, name, known, at, version, build, platform, props)
     VALUES ${values.join(',')} ON CONFLICT (id) DO NOTHING`,
    params,
  );
  return { accepted: inserted.rowCount, duplicate: batch.events.length - inserted.rowCount, rejected: batch.rejected };
}
