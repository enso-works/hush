-- A ticket that carries an email is contact info, and apps on hush declare
-- their usage data as not linked to the person. So a ticket with an email
-- no longer carries the install id or RevenueCat's customer id: the app
-- reaches it with a thread key of its own, and the server keeps only the
-- key's sha256 (hex), the way write keys are kept.
ALTER TABLE tickets ALTER COLUMN install DROP NOT NULL;
ALTER TABLE tickets ADD COLUMN thread_hash text;
CREATE UNIQUE INDEX tickets_thread_hash_idx ON tickets (thread_hash);

-- Tickets stored before this, and those from app versions that still send
-- both: the customer id goes now (no inbox reads it). The install id goes
-- once the thread is closed and the app has fetched it since (or it closed 7
-- days ago), or once it has been idle for 30 days; until then it is what
-- lets those apps list their own ticket. With it go the install's
-- ticket_opened and ticket_replied events since the ticket was opened, which
-- those apps tracked at the same moments, and a read_at that was a request
-- time shared with the install's other tickets. The server's periodic sweep
-- does the same from here on (unlinkOldClientTickets in src/tickets.mjs).
--
-- An unlinked ticket is out of reach of the app's forget(), which deletes by
-- install: from this deploy on, a past conversation by email is deleted by
-- the operator (Delete on the ticket), on request.
UPDATE tickets SET rc_id = NULL WHERE email IS NOT NULL AND rc_id IS NOT NULL;

WITH due AS (
  SELECT id, app, install, created_at FROM tickets
   WHERE email IS NOT NULL AND install IS NOT NULL
     AND (updated_at < now() - interval '30 days'
          OR (status = 'closed' AND (read_at > updated_at OR updated_at < now() - interval '7 days')))
), ticket_events AS (
  DELETE FROM events e USING due
   WHERE e.install = due.install AND e.app = due.app
     AND e.name IN ('ticket_opened', 'ticket_replied')
     AND e.received_at >= due.created_at - interval '1 minute'
)
UPDATE tickets t
   SET install = NULL,
       read_at = (SELECT max(r.created_at) FROM ticket_replies r
                   WHERE r.ticket_id = t.id AND r.author = 'support' AND r.created_at <= t.read_at)
  FROM due WHERE t.id = due.id;
