-- Pushes through the relay (src/push.mjs, src/relay.mjs), for a server with
-- no APNs key of its own: the relay's pass for the token, which the phone got
-- from the relay and handed over, and the key the phone gave this server to
-- seal what a push says. Null for a phone signed up before, or when this
-- server sends to Apple itself.
ALTER TABLE push_tokens ADD COLUMN pass text, ADD COLUMN enc_key text;
