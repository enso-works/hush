// Phones signed in to /admin with a token of their own, so the admin token
// never has to be typed into one or shown in a QR code. The dashboard asks for
// a pairing code (single use, ten minutes) and shows it in a QR code; the iOS
// app trades it for a device token; each device can be revoked on its own.
// Only hashes are stored.
import { randomBytes } from 'node:crypto';

import { q } from './db.mjs';
import { hashKey } from './keys.mjs';

export const PAIRING_MINUTES = 10;
// Opening the dialog again makes a new code; the oldest live ones go past this.
const LIVE_PAIRINGS = 5;
export const DEVICE_PREFIX = 'hush_device_';

export async function createPairing() {
  const code = randomBytes(16).toString('base64url');
  const { rows } = await q(
    `INSERT INTO admin_pairings (code_hash, expires_at) VALUES ($1, now() + make_interval(mins => $2))
     RETURNING expires_at`,
    [hashKey(code), PAIRING_MINUTES],
  );
  await q(
    `DELETE FROM admin_pairings WHERE expires_at <= now()
       OR code_hash NOT IN (SELECT code_hash FROM admin_pairings ORDER BY created_at DESC LIMIT $1)`,
    [LIVE_PAIRINGS],
  );
  return { code, expires_at: rows[0].expires_at };
}

/** Uses up the code and returns a new device with its token, or null for a code that is unknown, used or expired. */
export async function pair(code, name) {
  const { rows } = await q('DELETE FROM admin_pairings WHERE code_hash = $1 RETURNING expires_at > now() AS live', [hashKey(code)]);
  if (!rows[0]?.live) return null;
  const token = `${DEVICE_PREFIX}${randomBytes(24).toString('base64url')}`;
  const { rows: device } = await q(
    'INSERT INTO admin_devices (name, token_hash) VALUES ($1, $2) RETURNING id::text, name, created_at',
    [name, hashKey(token)],
  );
  return { token, device: device[0] };
}

export async function listDevices() {
  const { rows } = await q('SELECT id::text, name, created_at, last_seen_at FROM admin_devices ORDER BY created_at');
  return rows;
}

export async function revokeDevice(id) {
  const { rowCount } = await q('DELETE FROM admin_devices WHERE id = $1', [id]);
  // Revoked means now, not when the cache would have expired.
  for (const [hash, hit] of cache) if (hit.id === id) cache.delete(hash);
  return rowCount > 0;
}

// Every request from a phone carries its token, so the lookup is cached, like
// write keys (keys.mjs), and bounded the same way. Unlike a write key a device
// token is a secret with full admin rights, so revoking one clears its entry.
const cache = new Map();
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

/** The paired device the request's token belongs to (its id), or null. */
export async function deviceAuthorized(headers) {
  const m = /^Bearer\s+(\S+)$/.exec(headers.authorization ?? '');
  if (!m || !m[1].startsWith(DEVICE_PREFIX)) return null;
  const hash = hashKey(m[1]);
  let hit = cache.get(hash);
  if (!hit || hit.until <= Date.now()) {
    const { rows } = await q('SELECT id::text FROM admin_devices WHERE token_hash = $1', [hash]);
    hit = { id: rows[0]?.id ?? null, until: Date.now() + TTL_MS, seen: 0 };
    cache.delete(hash);
    cache.set(hash, hit);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }
  if (!hit.id) return null;
  if (Date.now() - hit.seen > 60_000) {
    hit.seen = Date.now();
    await q('UPDATE admin_devices SET last_seen_at = now() WHERE id = $1', [hit.id]);
  }
  return hit.id;
}
