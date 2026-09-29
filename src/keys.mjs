import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { cfg } from './config.mjs';
import { q } from './db.mjs';

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

/** `bvk_<app>_<env>_<random>`: readable enough to tell two keys apart in a diff. */
export const mintKey = (app, env) => `bvk_${app}_${env}_${randomBytes(18).toString('base64url')}`;

// Every request carries a key, so the lookup is cached briefly. A revoked key
// therefore keeps working for at most a minute, which is fine for an
// identifier that is public in the app bundle anyway.
//
// Misses are cached too (a flood of one bad key costs one query a minute),
// which is why the cache is bounded: without a cap, a client sending random
// keys grows it by one entry per request until the 192 MB container dies.
// A Map iterates in insertion order, so the first key is the oldest entry.
const cache = new Map();
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

function remember(hash, value) {
  cache.delete(hash);
  cache.set(hash, { value, until: Date.now() + TTL_MS });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

export async function resolveKey(header) {
  const m = /^Key\s+(\S+)$/.exec(header ?? '');
  if (!m) return null;
  const hash = hashKey(m[1]);
  const hit = cache.get(hash);
  if (hit && hit.until > Date.now()) return hit.value;
  const { rows } = await q('SELECT app, env FROM write_keys WHERE hash = $1 AND revoked_at IS NULL', [hash]);
  const value = rows[0] ?? null;
  remember(hash, value);
  return value;
}

export function adminAuthorized(header) {
  const m = /^Bearer\s+(\S+)$/.exec(header ?? '');
  if (!m || !cfg.adminToken) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(cfg.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
