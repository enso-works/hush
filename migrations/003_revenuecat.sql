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
    -- 1 or 0.01, learned by comparing the revenue chart with the authoritative
    -- 28-day total: the chart schema does not say which unit money is in.
    money_scale    numeric NOT NULL DEFAULT 1,
    -- Freshness and failure belong next to the link: the dashboard says
    -- "as of 6 minutes ago", and a key that stopped working is visible
    -- there rather than only in the container log.
    --
    -- Attempts and successes are separate columns on purpose. Every attempt
    -- moves `last_polled_at`, because that is what the staleness check reads
    -- and a failing upstream must not be retried on every page open. Only data
    -- actually landing moves `last_success_at`. Collapsing the two would let a
    -- run of failures report hour-old money as freshly checked.
    last_polled_at  timestamptz,
    last_success_at timestamptz,
    last_error      text
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

-- Which charts this project answers for, and what each one measures. A chart
-- is several series: `revenue` returns Revenue, Transactions and Ad
-- Impressions; `conversion_to_paying` returns New Customers, Paying Customers
-- and the rate. `measures` is RevenueCat's own array, kept verbatim
-- ({display_name, unit, decimal_precision, chartable}), so the dashboard can
-- label and format a series without this service knowing what any chart means.
--
-- Support is discovered, not assumed: an unknown name is a 400 and a chart the
-- project does not have is a 404, so the answer is remembered rather than
-- asked again on every pull.
CREATE TABLE rc_charts (
    app          text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    chart        text NOT NULL,
    supported    boolean NOT NULL,
    display_name text,
    measures     jsonb NOT NULL DEFAULT '[]'::jsonb,
    checked_at   timestamptz NOT NULL DEFAULT now(),
    note         text,
    PRIMARY KEY (app, chart)
);

-- Daily points, one row per chart, measure and day. Re-pulled on every pull and
-- upserted, so the current day (which RevenueCat marks `incomplete`) and any
-- late-settling revenue correct themselves instead of freezing at first value.
CREATE TABLE rc_series (
    app     text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    chart   text NOT NULL,
    measure text NOT NULL,
    day     date NOT NULL,
    value   numeric NOT NULL,
    PRIMARY KEY (app, chart, measure, day)
);
