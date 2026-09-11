import { cfg } from './config.mjs';
import { q, tx } from './db.mjs';
import { flatObject, str } from './http.mjs';
import { sendMail } from './mail.mjs';

const MAX_PER_DAY = 5;
// Replies on one thread in a day. Generous: a conversation, not a form.
const MAX_REPLIES_PER_DAY = 20;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
export const KINDS = ['issue', 'feature', 'love'];

export function parseTicket(body) {
  if (!body || typeof body !== 'object') return 'body';
  const message = str(body.message, 4000);
  if (!message) return 'message';
  const email = body.email == null || body.email === '' ? null : str(body.email, 160);
  if (body.email && (!email || !EMAIL.test(email))) return 'email';
  const subject = body.subject == null || body.subject === '' ? null : str(body.subject, 120);
  if (body.subject && !subject) return 'subject';
  // Same flat-primitive shape as event props: the diagnostics end up in an
  // email body and in the Cockpit ticket view, so a nested or oversized
  // structure is refused here rather than rendered somewhere later.
  const diag = flatObject(body.diag, { maxKeys: 20 });
  if (diag === null) return 'diag';
  // Older app versions send no kind; a plain message is a problem report until
  // it says otherwise, which is how the inbox always read them.
  const kind = body.kind == null ? 'issue' : body.kind;
  if (!KINDS.includes(kind)) return 'kind';
  const rcId = body.rc_id == null || body.rc_id === '' ? null : str(body.rc_id, 128);
  if (body.rc_id && !rcId) return 'rc_id';
  return { message, email, subject, diag, kind, rcId };
}

/**
 * Creates the ticket unless the install already has MAX_PER_DAY today.
 * Returns the row, or null when over quota.
 *
 * Count and insert are one transaction behind an advisory lock keyed on the
 * install: without it, five concurrent submissions all read four and all
 * insert. The lock is per install, so it never serializes unrelated traffic.
 */
export async function createTicket({ app, install, email, subject, message, diag, kind = 'issue', rcId = null }) {
  const ticket = await tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [install]);
    const { rows: countRows } = await client.query(
      "SELECT count(*)::int AS n FROM tickets WHERE install = $1 AND app = $2 AND created_at > now() - interval '1 day'",
      [install, app],
    );
    if (countRows[0].n >= MAX_PER_DAY) return null;
    const { rows } = await client.query(
      `INSERT INTO tickets (app, install, email, subject, message, diag, kind, rc_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING id, created_at`,
      [app, install, email, subject, message, JSON.stringify(diag), kind, rcId],
    );
    return rows[0];
  });
  if (!ticket) return null;

  const diagLines = Object.entries(diag).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  // Fire-and-forget: the ticket is stored, the phone should not wait on Resend.
  const heading = { issue: 'Problem', feature: 'Feature idea', love: 'Kind words' }[kind];
  void sendMail({
    to: cfg.alertEmail,
    subject: `[${app}] ${heading} #${ticket.id}${subject ? ` — ${subject}` : ''}`,
    replyTo: email ?? undefined,
    text: `${message}\n\n--\ninstall: ${install}\ncustomer: ${rcId ?? '(no RevenueCat id)'}\nemail: ${email ?? '(none given)'}\n${diagLines}\n\nReply from ops.bavrk.com → Tickets.`,
  });
  return ticket;
}

/**
 * A reply from the person who opened the ticket, so a thread can go back and
 * forth until someone on the ops side closes it.
 *
 * Reopens the ticket: an answered thread the user has written back on needs
 * looking at again, and `open` is what the inbox sorts to the top. A closed
 * ticket stays closed; the app offers a new message instead, so "closed" keeps
 * meaning what the operator meant by it. Returns the reply row, or a string
 * naming why it was refused.
 */
export async function userReply({ id, install, app, body }) {
  const { rows } = await q('SELECT id, status, subject, email FROM tickets WHERE id = $1 AND install = $2 AND app = $3', [id, install, app]);
  const ticket = rows[0];
  if (!ticket) return 'not_found';
  if (ticket.status === 'closed') return 'closed';
  const { rows: countRows } = await q(
    "SELECT count(*)::int AS n FROM ticket_replies WHERE ticket_id = $1 AND author = 'user' AND created_at > now() - interval '1 day'",
    [id],
  );
  if (countRows[0].n >= MAX_REPLIES_PER_DAY) return 'too_many';

  const reply = await tx(async (client) => {
    const { rows: r } = await client.query(
      "INSERT INTO ticket_replies (ticket_id, author, body, emailed) VALUES ($1, 'user', $2, false) RETURNING id, created_at",
      [id, body],
    );
    await client.query("UPDATE tickets SET status = 'open', updated_at = now() WHERE id = $1", [id]);
    return r[0];
  });

  // Same fire-and-forget as a new ticket: stored first, announced after.
  void sendMail({
    to: cfg.alertEmail,
    subject: `[${app}] Reply on #${id}${ticket.subject ? ` — ${ticket.subject}` : ''}`,
    replyTo: ticket.email ?? undefined,
    text: `${body}\n\n--\nticket: #${id}\ninstall: ${install}\n\nReply from ops.bavrk.com → Tickets.`,
  });
  return reply;
}

/** True when this install id already belongs to a different app — a spoofed id, since an install only ever talks to one app. */
export async function belongsToAnotherApp(install, app) {
  const { rowCount } = await q('SELECT 1 FROM installs WHERE id = $1 AND app <> $2', [install, app]);
  return rowCount > 0;
}

/**
 * Everything one install may see: its own tickets under the calling app, with
 * replies, newest first. Scoped by app so a write key from one app cannot read
 * another app's tickets by guessing an install id.
 */
export async function ticketsForInstall(install, app) {
  // The cutoff is taken before the select, and acknowledgement never moves
  // past it: a reply that lands mid-request keeps a timestamp after the
  // cutoff, so it is still unread on the next poll rather than silently
  // acknowledged as one the app has shown.
  const { rows: nowRows } = await q('SELECT now() AS cutoff');
  const cutoff = nowRows[0].cutoff;

  const { rows } = await q(
    `SELECT t.id, t.app, t.kind, t.subject, t.message, t.status, t.created_at, t.read_at,
            EXISTS (SELECT 1 FROM ticket_replies r
                     WHERE r.ticket_id = t.id AND r.author = 'support'
                       AND r.created_at > COALESCE(t.read_at, '-infinity'::timestamptz)) AS unread,
            COALESCE(
              (SELECT json_agg(json_build_object('author', r.author, 'body', r.body, 'at', r.created_at) ORDER BY r.created_at)
               FROM ticket_replies r WHERE r.ticket_id = t.id AND r.created_at <= $3),
              '[]'::json) AS replies
     FROM tickets t WHERE t.install = $1 AND t.app = $2 ORDER BY t.created_at DESC LIMIT 50`,
    [install, app, cutoff],
  );

  await q(
    `UPDATE tickets SET read_at = $3
     WHERE install = $1 AND app = $2 AND (read_at IS NULL OR read_at < $3)`,
    [install, app, cutoff],
  );
  return rows;
}

export async function adminList(status, kind) {
  const { rows } = await q(
    `SELECT t.id, t.app, t.kind, t.install, t.rc_id, t.email, t.subject, t.status, t.created_at, t.updated_at,
            left(t.message, 160) AS preview,
            (SELECT count(*)::int FROM ticket_replies r WHERE r.ticket_id = t.id) AS replies
     FROM tickets t
     WHERE ($1::text IS NULL OR t.status = $1)
       AND ($2::text IS NULL OR t.kind = $2)
     ORDER BY (t.status = 'open') DESC, t.created_at DESC
     LIMIT 200`,
    [status ?? null, kind ?? null],
  );
  return rows;
}

export async function adminGet(id) {
  const { rows } = await q(
    `SELECT t.*,
            COALESCE(
              (SELECT json_agg(json_build_object('id', r.id, 'author', r.author, 'body', r.body, 'at', r.created_at, 'emailed', r.emailed) ORDER BY r.created_at)
               FROM ticket_replies r WHERE r.ticket_id = t.id),
              '[]'::json) AS replies
     FROM tickets t WHERE t.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Stores the reply, then mails it. That order matters: mailing first meant a
 * failed write returned an error to an operator whose reply had already been
 * delivered, and the obvious retry sent it twice. Now a retry is visible as a
 * second reply in the thread instead of an invisible second email.
 */
export async function adminReply(id, body, { close = false } = {}) {
  const ticket = await adminGet(id);
  if (!ticket) return null;

  const replyId = await tx(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO ticket_replies (ticket_id, author, body, emailed) VALUES ($1, $2, $3, false) RETURNING id',
      [id, 'support', body],
    );
    // read_at NULL marks the thread unread for the app; the reply is visible
    // there whether or not mail works, so `answered` is honest either way.
    await client.query('UPDATE tickets SET status = $2, updated_at = now(), read_at = NULL WHERE id = $1', [id, close ? 'closed' : 'answered']);
    return rows[0].id;
  });

  let emailed = false;
  if (ticket.email) {
    emailed = await sendMail({
      to: ticket.email,
      subject: `Re: [${ticket.app}] #${ticket.id} ${ticket.subject ?? 'Support request'}`,
      text: `${body}\n\n--\nYou wrote:\n${ticket.message}`,
    });
    if (emailed) await q('UPDATE ticket_replies SET emailed = true WHERE id = $1', [replyId]);
  }
  return { emailed };
}

export async function adminStatus(id, status) {
  const { rowCount } = await q('UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  return rowCount > 0;
}
