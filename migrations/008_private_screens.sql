-- A catalog's private_screens (src/catalog.mjs) are never stored, and the
-- sweep deletes the screen views stored before the catalog named them
-- (deletePrivateScreens in src/sweep.mjs), every six hours. This index
-- finds them by app and the first segment of the screen name ("support" of
-- "support/42"), so that check reads the few candidates rather than every
-- screen view the app has sent in the retention window. Partial: only
-- screen views carry a screen.
CREATE INDEX events_screen_head_idx ON events (app, split_part(props->>'screen', '/', 1))
    WHERE name = 'screen_viewed';
