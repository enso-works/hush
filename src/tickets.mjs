import { createHash, randomBytes } from 'node:crypto';

import { cfg, log } from './config.mjs';
import { q, tx } from './db.mjs';
import { flatObject, str } from './http.mjs';
import { sendMail } from './mail.mjs';

export const MAX_PER_DAY = 5;
// How long a ticket with an email from an app version before SDK 2.3.0 keeps
// its install id after the last activity on it (see createTicket).
const UNLINK_AFTER_DAYS = 30;
// How long such a ticket keeps it once closed, if that app has not fetched it
// since: long enough for the closing reply to show in its inbox.
const UNLINK_CLOSED_AFTER_DAYS = 7;
// The most thread keys one request may name: an inbox page, like the install's.
export const MAX_THREADS = 50;
// Replies on one thread in a day. Generous: a conversation, not a form.
const MAX_REPLIES_PER_DAY = 20;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
export const KINDS = ['issue', 'feature', 'love'];

/**
 * A thread key is the app's only handle on a ticket sent with an email: 32
 * random bytes, base64url, handed out once and stored here only as its
 * sha256. Whoever holds it can read, answer and delete that one ticket.
 */
export const isThreadKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const hashThread = (key) => createHash('sha256').update(key).digest('hex');

/** A request's list of thread keys, deduplicated, or null when it is not one. */
export function threadKeys(value) {
  if (!Array.isArray(value) || value.length > MAX_THREADS || !value.every(isThreadKey)) return null;
  return [...new Set(value)];
}

export function parseTicket(body) {
  if (!body || typeof body !== 'object') return 'body';
  const message = str(body.message, 4000);
  if (!message) return 'message';
  const email = body.email == null || body.email === '' ? null : str(body.email, 160);
  if (body.email && (!email || !EMAIL.test(email))) return 'email';
  const subject = body.subject == null || body.subject === '' ? null : str(body.subject, 120);
  if (body.subject && !subject) return 'subject';
  // Same flat-primitive shape as event props: the diagnostics end up in an
  // email body and in the dashboard's ticket view, so a nested or oversized
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

// Alert mails go to one inbox (ALERT_EMAIL). The per-install caps stop one
// phone, but an install id is a client-chosen UUID, so a script can mint new
// ones and turn each ticket into a mail. Past this many alerts an hour the
// tickets are still stored and shown on the dashboard; only the mail is
// skipped, with one warning in the log per hour.
const ALERTS_PER_HOUR = 30;
let alertHour = -1;
let alertCount = 0;

// Where to answer, appended to every alert when REPLY_HINT is set.
const replyLine = () => (cfg.replyHint ? `\n\nReply from ${cfg.replyHint}.` : '');

function alertMail(mail) {
  if (!cfg.alertEmail) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== alertHour) { alertHour = hour; alertCount = 0; }
  alertCount += 1;
  if (alertCount > ALERTS_PER_HOUR) {
    if (alertCount === ALERTS_PER_HOUR + 1) log.warn('alert mail suppressed for the rest of the hour', { limit: ALERTS_PER_HOUR });
    return;
  }
  void sendMail(mail);
}

/**
 * Creates a ticket. Returns the row (with `thread`, the key, for a ticket
 * without an install), or null when the install is over MAX_PER_DAY today.
 *
 * A ticket with an email is contact info, and must not be joinable to the
 * install's usage data. SDK 2.3.0 and later send it without the install: it
 * gets a thread key instead, and the per-day cap is the caller's (server.mjs).
 * Older app versions still send the install and RevenueCat's id with it.
 * RevenueCat's id is dropped here; the install is kept only so their inbox
 * can list the ticket, and unlinkOldClientTickets clears it once the ticket is
 * closed and seen, or idle. Without an email the install is the only way to
 * answer, and there is no identity on the ticket to link.
 *
 * Count and insert are one transaction behind an advisory lock keyed on the
 * install: without it, five concurrent submissions all read four and all
 * insert. The lock is per install, so it never serializes unrelated traffic.
 */
export async function createTicket({ app, install = null, email = null, subject, message, diag, kind = 'issue', rcId = null }) {
  if (!install && !email) throw new Error('a ticket needs an install or an email');
  if (email) rcId = null;
  const thread = install ? null : randomBytes(32).toString('base64url');
  const ticket = await tx(async (client) => {
    if (install) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [install]);
      const { rows: countRows } = await client.query(
        "SELECT count(*)::int AS n FROM tickets WHERE install = $1 AND app = $2 AND created_at > now() - interval '1 day'",
        [install, app],
      );
      if (countRows[0].n >= MAX_PER_DAY) return null;
    }
    const { rows } = await client.query(
      `INSERT INTO tickets (app, install, email, subject, message, diag, kind, rc_id, thread_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING id, created_at`,
      [app, install, email, subject, message, JSON.stringify(diag), kind, rcId, thread && hashThread(thread)],
    );
    return rows[0];
  });
  if (!ticket) return null;

  const diagLines = Object.entries(diag).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  // With an email the alert names the person, so it names nothing else: no
  // install, no customer id.
  const who = email ? `email: ${email}` : `install: ${install}\ncustomer: ${rcId ?? '(no RevenueCat id)'}\nemail: (none given)`;
  // Fire-and-forget: the ticket is stored, the phone should not wait on Resend.
  const heading = { issue: 'Problem', feature: 'Feature idea', love: 'Kind words' }[kind];
  alertMail({
    to: cfg.alertEmail,
    subject: `[${app}] ${heading} #${ticket.id}${subject ? ` — ${subject}` : ''}`,
    replyTo: email ?? undefined,
    text: `${message}\n\n--\n${who}\n${diagLines}${replyLine()}`,
  });
  return thread ? { ...ticket, thread } : ticket;
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
export async function userReply({ id, install = null, thread = null, app, body }) {
  // By the thread key for a ticket sent with an email, by the install otherwise.
  const { rows } = await q(
    `SELECT id, status, subject, email FROM tickets WHERE id = $1 AND ${thread ? 'thread_hash' : 'install'} = $2 AND app = $3`,
    [id, thread ? hashThread(thread) : install, app],
  );
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
  alertMail({
    to: cfg.alertEmail,
    subject: `[${app}] Reply on #${id}${ticket.subject ? ` — ${ticket.subject}` : ''}`,
    replyTo: ticket.email ?? undefined,
    text: `${body}\n\n--\nticket: #${id}${install && !ticket.email ? `\ninstall: ${install}` : ''}${replyLine()}`,
  });
  return reply;
}

/** True when this install id already belongs to a different app — a spoofed id, since an install only ever talks to one app. */
export async function belongsToAnotherApp(install, app) {
  const { rowCount } = await q('SELECT 1 FROM installs WHERE id = $1 AND app <> $2', [install, app]);
  return rowCount > 0;
}

// The newest support reply on ticket t, for a subquery; callers add a bound.
const NEWEST_SUPPORT_REPLY = "SELECT max(r.created_at) FROM ticket_replies r WHERE r.ticket_id = t.id AND r.author = 'support'";

/**
 * Everything one install may see: its own tickets under the calling app, with
 * replies, newest first. Scoped by app so a write key from one app cannot read
 * another app's tickets by guessing an install id. Marked read at the
 * request's cutoff, as they always were: these tickets carry the install.
 */
export const ticketsForInstall = (install, app) =>
  ticketsWhere('install = $1', install, app, {
    readAt: '$3',
    when: '(t.read_at IS NULL OR t.read_at < $3)',
  });

/**
 * The same for the tickets an app holds thread keys for (sent with an email),
 * except how they are marked read: read_at becomes the time of the newest
 * support reply the app was shown, and only moves when there is one it had
 * not seen. Never the time of the request: the SDK fetches these and the
 * install's own tickets together, so a request time would be the same on
 * both, to the millisecond, and join the email to the install.
 */
export const ticketsForThreads = (keys, app) =>
  ticketsWhere('thread_hash = ANY($1::text[])', keys.map(hashThread), app, {
    readAt: `(${NEWEST_SUPPORT_REPLY} AND r.created_at <= $3)`,
    when: `EXISTS (SELECT 1 FROM ticket_replies r WHERE r.ticket_id = t.id AND r.author = 'support'
                    AND r.created_at <= $3 AND r.created_at > COALESCE(t.read_at, '-infinity'::timestamptz))`,
  });

async function ticketsWhere(match, value, app, { readAt, when }) {
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
     FROM tickets t WHERE t.${match} AND t.app = $2 ORDER BY t.created_at DESC LIMIT 50`,
    [value, app, cutoff],
  );

  await q(`UPDATE tickets t SET read_at = ${readAt} WHERE t.${match} AND t.app = $2 AND ${when}`, [value, app, cutoff]);
  return rows;
}

/** Deletes the tickets these thread keys open, with their replies; the count. */
export async function forgetThreads(keys, app) {
  const { rowCount } = await q('DELETE FROM tickets WHERE thread_hash = ANY($1::text[]) AND app = $2', [keys.map(hashThread), app]);
  return rowCount;
}

/**
 * The periodic half of the rule in createTicket: a ticket with an email that
 * an older app version sent with its install loses the install once closed
 * and fetched by that app since (or closed UNLINK_CLOSED_AFTER_DAYS ago), or
 * once nobody has touched it for UNLINK_AFTER_DAYS. Not at the moment it
 * closes: that app would never show the closing reply, and a reply from its
 * thread screen would get a 404 it reads as a failure instead of `closed`.
 *
 * Those versions also tracked ticket_opened and ticket_replied with the
 * install id at the moments the ticket was sent and answered, which would
 * join it again. So the install's ticket events since the ticket was opened
 * go with it, in the same statement. read_at goes back to the newest support
 * reply it had acknowledged: as a request time it equals read_at on the
 * install's other tickets. Returns how many tickets.
 */
export async function unlinkOldClientTickets() {
  const { rowCount } = await q(
    `WITH due AS (
       SELECT id, app, install, created_at FROM tickets
        WHERE email IS NOT NULL AND install IS NOT NULL
          AND (updated_at < now() - make_interval(days => $1)
               OR (status = 'closed' AND (read_at > updated_at OR updated_at < now() - make_interval(days => $2))))
        FOR UPDATE
     ), ticket_events AS (
       DELETE FROM events e USING due
        WHERE e.install = due.install AND e.app = due.app
          AND e.name IN ('ticket_opened', 'ticket_replied')
          AND e.received_at >= due.created_at - interval '1 minute'
     )
     UPDATE tickets t SET install = NULL, read_at = (${NEWEST_SUPPORT_REPLY} AND r.created_at <= t.read_at)
       FROM due WHERE t.id = due.id`,
    [UNLINK_AFTER_DAYS, UNLINK_CLOSED_AFTER_DAYS],
  );
  return rowCount;
}

// The operator never sees an install or a customer id on a ticket with an
// email, even while an older app version's ticket still holds the install
// for its inbox: nothing on the dashboard joins the two.
const LINKS = `CASE WHEN t.email IS NULL THEN t.install END AS install,
               CASE WHEN t.email IS NULL THEN t.rc_id END AS rc_id`;

export async function adminList(status, kind) {
  const { rows } = await q(
    `SELECT t.id, t.app, t.kind, ${LINKS}, t.email, t.subject, t.status, t.created_at, t.updated_at,
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
    `SELECT t.id, t.app, t.kind, ${LINKS}, t.email, t.subject, t.message, t.diag, t.status,
            t.created_at, t.updated_at,
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

/** One ticket and its replies, for a "please delete my message" that came by email. */
export async function adminDelete(id) {
  const { rowCount } = await q('DELETE FROM tickets WHERE id = $1', [id]);
  return rowCount > 0;
}
