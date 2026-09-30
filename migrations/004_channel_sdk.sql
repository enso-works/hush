-- Where an install came from (the app says: app_store, testflight, play, dev,
-- or whatever its build profiles call themselves), so TestFlight and dev-client
-- builds running on a prod key can be told apart from the store. On events
-- too, like version and platform, so a filter needs no join. NULL for SDKs
-- that do not send it.
ALTER TABLE installs ADD COLUMN channel text;
ALTER TABLE events ADD COLUMN channel text;

-- The SDK version that last spoke for the install, so the day an old SDK can
-- stop being supported is a query rather than a guess.
ALTER TABLE installs ADD COLUMN sdk text;
