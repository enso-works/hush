-- RevenueCat stays the financial truth (SPEC section 8): nothing here
-- recomputes money from events. The service polls RevenueCat's read-only
-- Charts & Metrics API every few minutes and keeps the answer, so the
-- dashboard reads Postgres and the 25-requests-a-minute limit is never near.

-- Which RevenueCat project holds which app. Filled by the poller (matching
-- project name to app), or pinned by hand with `cli.mjs rc:link`.
CREATE TABLE rc_projects (
    app            text PRIMARY KEY REFERENCES apps(slug) ON DELETE CASCADE,
    project_id     text NOT NULL UNIQUE,
    name           text,
    linked_at      timestamptz NOT NULL DEFAULT now(),
    -- Freshness and failure belong next to the link: the dashboard says
    -- "as of 6 minutes ago", and a key that stopped working is visible
    -- there rather than only in the container log.
    last_polled_at timestamptz,
    last_error     text
);

-- The overview cards, exactly as RevenueCat returns them: a metric is an
-- {id, name, value, unit, period} object, so a metric added upstream shows up
-- without a migration here. One row per *change*, not per poll — the values
-- move a few times a day at fleet volume, and the history is what makes a
-- trend possible for the metrics the charts API does not break down.
CREATE TABLE rc_overview (
    app        text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    currency   text NOT NULL DEFAULT 'USD',
    metrics    jsonb NOT NULL,
    PRIMARY KEY (app, fetched_at)
);

-- Daily points from the charts API (revenue, new customers, active
-- subscriptions, active trials). Re-pulled on every poll and upserted, so a
-- late-settling day corrects itself instead of freezing at its first value.
CREATE TABLE rc_series (
    app     text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    chart   text NOT NULL,
    day     date NOT NULL,
    value   numeric NOT NULL,
    PRIMARY KEY (app, chart, day)
);
