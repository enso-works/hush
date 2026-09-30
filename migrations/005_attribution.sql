-- Where installs came from, as Apple says, never from the device: copies of
-- the SKAdNetwork and AdAttributionKit postbacks an ad's winning network
-- receives, and App Store Connect's campaign reports (campaign links, ct=).
-- Both are aggregate by design: no postback or report names an install.

-- One row per postback copy, deduplicated on Apple's own id (a device
-- retries until it gets a 200). `verified`: Apple's signature checked out
-- with the key the postback names; `development` marks Apple's test keys, so
-- a postback from the developer tool never counts as a real ad.
CREATE TABLE postbacks (
    id                bigserial PRIMARY KEY,
    dedupe            text NOT NULL UNIQUE,
    kind              text NOT NULL CHECK (kind IN ('skan', 'aak')),
    app               text REFERENCES apps(slug) ON DELETE CASCADE,
    apple_app_id      bigint,
    received_at       timestamptz NOT NULL DEFAULT now(),
    verified          boolean NOT NULL,
    development       boolean NOT NULL DEFAULT false,
    version           text,
    ad_network        text,
    source_identifier text,
    conversion_value  integer,
    coarse_value      text,
    sequence          integer,
    did_win           boolean,
    redownload        boolean,
    conversion_type   text,
    interaction       text,
    fidelity          integer,
    source_app        text,
    source_domain     text,
    country           text,
    raw               jsonb NOT NULL
);
CREATE INDEX postbacks_app_received ON postbacks (app, received_at);

-- App Store Connect Analytics: the report request per app (created once,
-- with an Admin key), each report instance imported, and the campaign rows,
-- summed per day, campaign token and source type. A later processing date
-- restates a day, so a day is replaced, never added to.
CREATE TABLE asc_requests (
    app         text PRIMARY KEY REFERENCES apps(slug) ON DELETE CASCADE,
    request_id  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_sync   timestamptz,
    last_error  text
);

CREATE TABLE asc_instances (
    instance_id     text PRIMARY KEY,
    app             text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    report          text NOT NULL,
    processing_date date NOT NULL,
    rows            integer NOT NULL,
    imported_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE asc_campaigns (
    app             text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    kind            text NOT NULL,
    day             date NOT NULL,
    campaign        text NOT NULL,
    source_type     text NOT NULL,
    metric          text NOT NULL,
    value           double precision NOT NULL,
    processing_date date NOT NULL,
    PRIMARY KEY (app, kind, day, campaign, source_type, metric)
);
