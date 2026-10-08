// A router small enough to read in one sitting: a dozen routes, JSON in and
// JSON out. Nothing here needs a framework.
import { createHash, randomBytes } from 'node:crypto';

import { cfg, log } from './config.mjs';

export function router() {
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, path) {
      const parts = path.split('/').filter(Boolean);
      for (const r of routes) {
        if (r.method !== method || r.parts.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < r.parts.length; i++) {
          const want = r.parts[i];
          if (want.startsWith(':')) {
            // %E0%A4 is valid hex but not UTF-8, and decodeURIComponent throws
            // on it outside any handler's try: an unanswered request then
            // takes the whole process down. Such a path names nothing here.
            try { params[want.slice(1)] = decodeURIComponent(parts[i]); }
            catch { ok = false; break; }
          } else if (want !== parts[i]) { ok = false; break; }
        }
        if (ok) return { handler: r.handler, params };
      }
      return null;
    },
  };
}

export function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    // Reject on the declared length first and drain the rest: a phone that
    // sends an oversized batch should read a 413 and drop it, not see a reset
    // connection and retry the same body forever.
    if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
      req.resume();
      return reject(Object.assign(new Error('body too large'), { code: 413 }));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Rate limiting needs to tell callers apart, not know who they are: the
// address is hashed with a salt that dies with the process, so no client
// address is held in memory even transiently beyond the request.
const salt = randomBytes(16);
// Loopback and private ranges, IPv4 (also IPv4-mapped) and IPv6: where a
// proxy in front of hush connects from.
const PRIVATE = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd][0-9a-f]{2}:/i;
let warnedNoHeader = false;

// Which address: the socket's, unless CLIENT_IP_HEADER names a header a
// trusted proxy in front sets (and overwrites), e.g. "cf-connecting-ip" or
// "x-forwarded-for" (its first entry). Trusting a header no proxy controls
// would let every client pick its own bucket and walk past the limits.
export const clientKey = (req) => {
  const header = cfg.clientIpHeader ? req.headers[cfg.clientIpHeader] : undefined;
  const fromHeader = typeof header === 'string' ? header.split(',')[0].trim() : '';
  const raw = fromHeader || req.socket.remoteAddress || '';
  if (!cfg.clientIpHeader && !warnedNoHeader && PRIVATE.test(raw)) {
    // Behind a proxy, every caller then has the proxy's address. Said once,
    // and without the address.
    warnedNoHeader = true;
    log.warn('CLIENT_IP_HEADER is unset and a request came from a private or loopback address: behind a proxy, every caller shares the rate limits and one daily count of tickets with an email per app');
  }
  return createHash('sha256').update(salt).update(raw).digest('base64url').slice(0, 16);
};

/** Fixed-window counter. `limit` hits per minute per key; oldest windows are dropped as they expire. */
export function rateLimiter(limit) {
  const hits = new Map();
  return (key) => {
    const window = Math.floor(Date.now() / 60_000);
    for (const [k, v] of hits) if (v.window < window) hits.delete(k);
    const entry = hits.get(key) ?? { window, n: 0 };
    if (entry.window !== window) { entry.window = window; entry.n = 0; }
    entry.n += 1;
    hits.set(key, entry);
    return entry.n <= limit;
  };
}

/**
 * Like rateLimiter, but only failures count: `fail(key)` records one, and
 * `over(key)` says whether `limit` were recorded this minute.
 */
export function failureLimiter(limit) {
  const hits = new Map();
  const current = (key) => {
    const window = Math.floor(Date.now() / 60_000);
    for (const [k, v] of hits) if (v.window < window) hits.delete(k);
    return hits.get(key)?.window === window ? hits.get(key).n : 0;
  };
  return {
    over: (key) => current(key) >= limit,
    fail: (key) => hits.set(key, { window: Math.floor(Date.now() / 60_000), n: current(key) + 1 }),
  };
}

/**
 * Fixed-day counter: `limit` hits per UTC day per key. Kept in memory like
 * the per-minute ones, so it resets with the process; the whole map goes when
 * the day turns.
 */
export function dailyLimiter(limit) {
  const hits = new Map();
  let today = -1;
  return (key) => {
    const day = Math.floor(Date.now() / 86_400_000);
    if (day !== today) {
      hits.clear();
      today = day;
    }
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    return n <= limit;
  };
}

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * One flat level of primitives, or null if the value is anything else. Used for
 * both event props and ticket diagnostics: enough for a funnel or a bug report,
 * cheap to index, and impossible to smuggle a nested payload through into a
 * query or an email body.
 */
export function flatObject(value, { maxKeys = 40, maxString = 200, maxBytes = 2048 } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maxKeys) return null;
  const out = {};
  for (const [k, v] of entries) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return null;
    if (typeof v === 'string') {
      if (v.length > maxString) return null;
      out[k] = v;
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      out[k] = v;
    } else if (typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      return null;
    }
  }
  if (Buffer.byteLength(JSON.stringify(out)) > maxBytes) return null;
  return out;
}

/** Trimmed string of at most `max` chars, or null for anything else. */
export const str = (v, max) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 || t.length > max ? null : t;
};
