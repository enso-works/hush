-- Remote config (src/remote-config.mjs). The catalog declares every key, its
-- type, default and rules; the dashboard may override a key's default, its
-- rules or both, live. Only the overrides live here, with every change. An
-- override for a key the catalog no longer has, or one that no longer fits
-- the key's type, is kept and never served.
CREATE TABLE config_overrides (
    app           text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    key           text NOT NULL,
    -- NULL: the catalog's default. Never JSON null: no type allows it.
    default_value jsonb,
    -- NULL: the catalog's rules. '[]': no rules at all.
    rules         jsonb CHECK (rules IS NULL OR jsonb_typeof(rules) = 'array'),
    -- The note of the change that wrote this row.
    note          text,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- Set by the first boot whose catalog lacks the key. A key that comes back
    -- may mean something else, so its old override stays unserved until a
    -- save (which clears this) or a revert (which deletes the row).
    orphaned_at   timestamptz,
    PRIMARY KEY (app, key),
    CHECK (default_value IS NOT NULL OR rules IS NOT NULL)
);

-- Every change, in id order. It holds no user data, so no retention: it goes
-- with the app. The latest id per key is what a write names as its base.
CREATE TABLE config_changes (
    id               bigserial PRIMARY KEY,
    app              text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    key              text NOT NULL,
    at               timestamptz NOT NULL DEFAULT now(),
    action           text NOT NULL CHECK (action IN ('set', 'revert')),
    -- The stored override before and after, { "default"?, "rules"? }; NULL for none.
    override_before  jsonb,
    override_after   jsonb,
    -- What /v1/config served for the key before and after, { "default", "rules" }
    -- with the rules' notes; NULL when the catalog did not have the key.
    effective_before jsonb,
    effective_after  jsonb,
    note             text
);
CREATE INDEX config_changes_key_idx ON config_changes (app, key, id DESC);
CREATE INDEX config_changes_app_idx ON config_changes (app, id DESC);
