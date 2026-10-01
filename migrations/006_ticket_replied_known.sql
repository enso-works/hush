-- The SDK sends ticket_replied when a user answers on a ticket, and it is now
-- one of the names every app knows (COMMON in src/common.mjs). `known` is
-- stored per row as it arrives, so the replies already received would stay
-- under "unknown events" until they age out; they are marked once here.
UPDATE events SET known = true WHERE name = 'ticket_replied' AND NOT known;
