-- A support inbox with one shape treats "I love this" and "this is broken" the
-- same way. The kind is chosen by the user in the app, so the inbox can be read
-- by intent: what to fix, what to build, what is working.
ALTER TABLE tickets ADD COLUMN kind text NOT NULL DEFAULT 'issue'
    CHECK (kind IN ('issue', 'feature', 'love'));

-- RevenueCat's anonymous app user id, captured at the moment the ticket is
-- written. The install id says which device; this says which customer, so a
-- report from a paying user can be recognised as one without asking them.
ALTER TABLE tickets ADD COLUMN rc_id text;

CREATE INDEX tickets_kind_idx ON tickets (app, kind, created_at DESC);
