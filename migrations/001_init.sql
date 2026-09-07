-- Analytics and support for the mobile fleet. Everything here is anonymous by
-- construction: the only identifier is an installation id the app generates
-- itself, no IP is stored anywhere, and an email exists only when a user typed
-- one into a support ticket.

CREATE TABLE apps (
    slug       text PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Write keys ship inside a mobile bundle, so they are identifiers, not
-- secrets: anyone can read one out of an IPA. Only the hash is stored, so a
-- database leak cannot be replayed as a client, and revocation is a column
-- rather than a redeploy.
CREATE TABLE write_keys (
    id         bigserial PRIMARY KEY,
    app        text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    env        text NOT NULL CHECK (env IN ('prod', 'dev')),
    hash       text NOT NULL UNIQUE,
    label      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE installs (
    id         uuid PRIMARY KEY,
    app        text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    env        text NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    last_seen  timestamptz NOT NULL DEFAULT now(),
    platform   text,
    os         text,
    device     text,
    locale     text,
    -- Two-letter code from Cloudflare's CF-IPCountry, the only thing derived
    -- from the request address; the address itself is never written down.
    country    text,
    version    text,
    build      text,
    -- RevenueCat's own anonymous app user id, so purchase webhooks can be
    -- joined to installs without ever setting a RevenueCat appUserID.
    rc_id      text,
    pro        boolean NOT NULL DEFAULT false
);
CREATE INDEX installs_first_seen_idx ON installs (app, env, first_seen DESC);
CREATE INDEX installs_last_seen_idx ON installs (app, env, last_seen DESC);
CREATE INDEX installs_rc_id_idx ON installs (rc_id) WHERE rc_id IS NOT NULL;

-- `id` is generated on the device, so a retried batch collides on the primary
-- key and is counted as a duplicate instead of double-counting a session.
CREATE TABLE events (
    id          uuid PRIMARY KEY,
    app         text NOT NULL,
    env         text NOT NULL,
    install     uuid NOT NULL,
    session     uuid,
    name        text NOT NULL,
    -- False for a name the server's catalog does not know. Accepted anyway, so
    -- a shipped app version can send events the backoffice has not learned yet;
    -- the dashboard lists them so they get added or removed.
    known       boolean NOT NULL DEFAULT false,
    at          timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    version     text,
    build       text,
    platform    text,
    props       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_at_idx ON events (app, env, at DESC);
CREATE INDEX events_name_idx ON events (app, env, name, at DESC);
CREATE INDEX events_install_idx ON events (install, at DESC);

CREATE TABLE tickets (
    id            bigserial PRIMARY KEY,
    app           text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    install       uuid NOT NULL,
    email         text,
    subject       text,
    message       text NOT NULL,
    -- Version, build, os, device, locale, pro: whatever the app knew about
    -- itself when the ticket was written, so a reply does not start with
    -- twenty questions.
    diag          jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- When the app last fetched this ticket, so it can badge an unread answer.
    read_at       timestamptz
);
CREATE INDEX tickets_app_status_idx ON tickets (app, status, created_at DESC);
CREATE INDEX tickets_install_idx ON tickets (install, created_at DESC);

CREATE TABLE ticket_replies (
    id         bigserial PRIMARY KEY,
    ticket_id  bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author     text NOT NULL CHECK (author IN ('support', 'user')),
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    emailed    boolean NOT NULL DEFAULT false
);
CREATE INDEX ticket_replies_ticket_idx ON ticket_replies (ticket_id, created_at);

INSERT INTO apps (slug, name) VALUES
    ('braele',   'Braele'),
    ('ampul',    'Ampul'),
    ('invoit',   'Invoit'),
    ('mycv',     'MyCV'),
    ('riseproof','Riseproof'),
    ('mindsaid', 'Mindsaid');
