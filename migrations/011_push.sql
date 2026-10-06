-- Phones that want a push for new feedback and users' replies (src/push.mjs).
-- The token is Apple's, for this app on that phone: it reaches the phone and
-- says nothing else about it. A paired phone's rows go when it is revoked.
CREATE TABLE push_tokens (
    -- APNs device token, hex.
    token      text PRIMARY KEY,
    -- The paired phone it belongs to; null for one signed in with the admin token.
    device_id  bigint REFERENCES admin_devices(id) ON DELETE CASCADE,
    -- A development build's token works only against Apple's sandbox.
    sandbox    boolean NOT NULL DEFAULT false,
    -- The app's own name for this server, sent back in every push so a phone
    -- with several servers opens the right one. Up to 64 characters.
    label      text,
    tickets    boolean NOT NULL DEFAULT true,
    replies    boolean NOT NULL DEFAULT true,
    -- Only these apps' feedback; null for every app.
    apps       text[],
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
