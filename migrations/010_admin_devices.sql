-- Phones signed in to /admin without the admin token (src/devices.mjs). The
-- dashboard shows a QR code holding a pairing code; the iOS app trades it for
-- a token of its own. Only hashes are kept: a code is shown once, on the
-- dashboard; a device token once, to the app that paired.
CREATE TABLE admin_devices (
    id           bigserial PRIMARY KEY,
    -- What the phone calls itself, for the dashboard's list. Up to 80 characters.
    name         text NOT NULL,
    token_hash   text NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Written at most once a minute per device, so a busy phone costs no writes.
    last_seen_at timestamptz
);

-- A code is good once, for ten minutes; the row goes when it is used.
CREATE TABLE admin_pairings (
    code_hash  text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
