// What the server deletes on its own: raw events after RETENTION_DAYS, the
// install id on an older app version's ticket with an email once its inbox
// no longer needs it (unlinkOldClientTickets in tickets.mjs), and the
// screens each app's catalog keeps private.
// server.mjs runs sweep() a minute after boot and every six hours, and
// deletePrivateScreens({ everyProp: true }) once at boot.
import { privateScreensByApp } from './catalog.mjs';
import { cfg, log } from './config.mjs';
import { q } from './db.mjs';
import { unlinkOldClientTickets } from './tickets.mjs';

// A text value that is one of the screen names in $2, or a screen under one:
// the rule isPrivateScreen (catalog.mjs) applies at ingest.
const namesPrivate = (v) => `EXISTS (SELECT 1 FROM unnest($2::text[]) s(name) WHERE ${v} = s.name OR starts_with(${v}, s.name || '/'))`;
// A string prop of e naming one. Strings only, as at ingest: jsonb_each_text
// would turn a number or a boolean into text that could match a name.
const propNamesPrivate = `EXISTS (SELECT 1 FROM jsonb_each(e.props) p WHERE jsonb_typeof(p.value) = 'string' AND ${namesPrivate(`(p.value #>> '{}')`)})`;

/**
 * For every app whose catalog names private screens, deletes the screen
 * views stored with one: before the catalog named it, or by an instance
 * still on older code. Idempotent. The check every six hours reads only the
 * `screen` prop, through events_screen_head_idx (migration 008), so it reads
 * the candidates and not every screen view. With `everyProp`, once at boot,
 * it reads every prop of every event the app has, as ingest does: a screen
 * view that names one in another prop goes too, and any other event loses
 * the props that name one. Ingest stores neither from then on.
 * Returns { views, stripped }.
 */
export async function deletePrivateScreens({ everyProp = false } = {}) {
  let views = 0;
  let stripped = 0;
  for (const [app, screens] of privateScreensByApp()) {
    const heads = [...new Set(screens.map((s) => s.split('/')[0]))];
    const byScreen = await q(
      `DELETE FROM events
        WHERE app = $1 AND name = 'screen_viewed'
          AND split_part(props->>'screen', '/', 1) = ANY($3::text[])
          AND ${namesPrivate(`(props->>'screen')`)}`,
      [app, screens, heads],
    );
    views += byScreen.rowCount;
    if (!everyProp) continue;
    const byProp = await q(`DELETE FROM events e WHERE e.app = $1 AND e.name = 'screen_viewed' AND ${propNamesPrivate}`, [app, screens]);
    views += byProp.rowCount;
    const others = await q(
      `UPDATE events e
          SET props = e.props - ARRAY(SELECT p.key FROM jsonb_each(e.props) p
                                       WHERE jsonb_typeof(p.value) = 'string' AND ${namesPrivate(`(p.value #>> '{}')`)})
        WHERE e.app = $1 AND e.name <> 'screen_viewed' AND ${propNamesPrivate}`,
      [app, screens],
    );
    stripped += others.rowCount;
  }
  return { views, stripped };
}

// One failing step is logged and does not stop the others.
async function step(failure, fn) {
  try {
    await fn();
  } catch (err) {
    log.warn(failure, { err: String(err?.message ?? err) });
  }
}

/**
 * Raw events age out; installs and tickets are kept (an install row is a
 * counter, a ticket is a conversation), except that a ticket with an email
 * that an older app version sent with its install loses the install, and
 * that install's ticket events, once it is closed and seen or idle. Then
 * the private screens, by the screen prop.
 */
export async function sweep() {
  await step('retention sweep failed', async () => {
    const { rowCount } = await q('DELETE FROM events WHERE at < now() - make_interval(days => $1)', [cfg.retentionDays]);
    if (rowCount) log.info('retention sweep', { deleted: rowCount, days: cfg.retentionDays });
  });
  await step('ticket unlink sweep failed', async () => {
    const unlinked = await unlinkOldClientTickets();
    if (unlinked) log.info('tickets with an email unlinked from their install', { tickets: unlinked });
  });
  await step('private screen sweep failed', async () => {
    const { views } = await deletePrivateScreens();
    if (views) log.info('private screen views deleted', { events: views });
  });
}

/** The boot-time pass over every prop (deletePrivateScreens). */
export async function sweepPrivateScreensAtBoot() {
  await step('private screen sweep failed', async () => {
    const { views, stripped } = await deletePrivateScreens({ everyProp: true });
    if (views || stripped) log.info('private screen views deleted', { events: views, props_removed_from: stripped });
  });
}
