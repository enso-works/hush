// One install at a time: what the dashboard shows when you look one up, and
// how an install is forgotten.
import { q, tx } from './db.mjs';

/**
 * Deletes everything stored about one install of one app: its events, its
 * tickets (and their replies, by cascade) and its install row. The app asks
 * for this through /v1/forget (a user's "delete my data"); an operator can do
 * it from the dashboard for a request that arrived by email.
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

/** The install row, its latest events (newest first) and its tickets. */
export async function installDetail(id, { limit = 100 } = {}) {
  const install = (await q('SELECT * FROM installs WHERE id = $1', [id])).rows[0] ?? null;
  const events = (await q(
    `SELECT id, name, known, at, received_at, session, version, build, channel, props
     FROM events WHERE install = $1 ORDER BY at DESC LIMIT $2`,
    [id, limit],
  )).rows;
  const tickets = (await q(
    'SELECT id, app, kind, subject, status, created_at FROM tickets WHERE install = $1 ORDER BY created_at DESC',
    [id],
  )).rows;
  if (!install && events.length === 0 && tickets.length === 0) return null;
  return { id, install, events, tickets };
}
