// One install at a time: what the dashboard shows when you look one up, and
// how an install is forgotten.
import { privatePropKeys } from './catalog.mjs';
import { q, tx } from './db.mjs';

/**
 * Deletes everything stored about one install of one app: its events, its
 * tickets (and their replies, by cascade) and its install row. The app asks
 * for this through /v1/forget (a user's "delete my data"); an operator can do
 * it from the dashboard for a request that arrived by email. Tickets sent with
 * an email are not the install's; SDK 2.3.0 forgets them by their thread keys
 * (forgetThreads in tickets.mjs).
 */
export async function forgetInstall(install, app = null) {
  return tx(async (client) => {
    const scope = app ? ' AND app = $2' : '';
    const args = app ? [install, app] : [install];
    const events = await client.query(`DELETE FROM events WHERE install = $1${scope}`, args);
    const tickets = await client.query(`DELETE FROM tickets WHERE install = $1${scope}`, args);
    const installs = await client.query(`DELETE FROM installs WHERE id = $1${scope}`, args);
    return { events: events.rowCount, tickets: tickets.rowCount, installs: installs.rowCount };
  });
}

/**
 * The install row, its latest events (newest first) and its tickets. Never a
 * ticket with an email: that one is not linked to the install, even while an
 * older app version's ticket still holds the install id for its inbox. Never
 * a screen the catalog keeps private either, though the sweep may not have
 * deleted it yet: such a view is left out, and a prop naming one is dropped.
 */
export async function installDetail(id, { limit = 100 } = {}) {
  const install = (await q('SELECT * FROM installs WHERE id = $1', [id])).rows[0] ?? null;
  const events = (await q(
    `SELECT app, id, name, known, at, received_at, session, version, build, channel, props
     FROM events WHERE install = $1 ORDER BY at DESC LIMIT $2`,
    [id, limit],
  )).rows.flatMap(({ app, ...e }) => {
    const named = privatePropKeys(app, e.props);
    if (!named.length) return [e];
    if (e.name === 'screen_viewed') return [];
    const props = { ...e.props };
    for (const k of named) delete props[k];
    return [{ ...e, props }];
  });
  const tickets = (await q(
    'SELECT id, app, kind, subject, status, created_at FROM tickets WHERE install = $1 AND email IS NULL ORDER BY created_at DESC',
    [id],
  )).rows;
  if (!install && events.length === 0 && tickets.length === 0) return null;
  return { id, install, events, tickets };
}
