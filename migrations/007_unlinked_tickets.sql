-- A ticket that carries an email is contact info, and apps on hush declare
-- their usage data as not linked to the person. So a ticket with an email
-- no longer carries the install id or RevenueCat's customer id: the app
-- reaches it with a thread key of its own, and the server keeps only the
-- key's sha256 (hex), the way write keys are kept.
ALTER TABLE tickets ALTER COLUMN install DROP NOT NULL;
ALTER TABLE tickets ADD COLUMN thread_hash text;
CREATE UNIQUE INDEX tickets_thread_hash_idx ON tickets (thread_hash);

-- Tickets stored before this, and those from app versions that still send
-- both: the customer id goes now (no inbox reads it), and the install id goes
-- once the thread is closed or has been idle for 30 days. Until then it is
-- what lets those apps list their own ticket. The server does the same from
-- here on, at close and in its periodic sweep.
UPDATE tickets SET rc_id = NULL WHERE email IS NOT NULL AND rc_id IS NOT NULL;
UPDATE tickets SET install = NULL
 WHERE email IS NOT NULL AND install IS NOT NULL
   AND (status = 'closed' OR updated_at < now() - interval '30 days');
