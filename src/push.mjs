// Push to the hush iOS app: a new ticket, a user's reply. Token-based APNs
// with no dependency: ES256 JWTs with node:crypto, HTTP/2 with node:http2.
//
// A push carries the app's name, the ticket's kind and number and a line of
// what was written, and the label the phone gave this server. Never an email
// or an install id: a lock screen is seen by others.
import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';

import { cfg, log } from './config.mjs';
import { q } from './db.mjs';

const b64url = (input) => Buffer.from(input).toString('base64url');

// The token itself is finished: the app was deleted, or the token is not this app's.
const DEAD = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
// Our JWT must be minted again.
const STALE_JWT = new Set(['ExpiredProviderToken', 'InvalidProviderToken', 'MissingProviderToken']);

// Like alert mail: past this many pushes an hour (a script minting install ids
// to file tickets), tickets are still stored; only the pushes stop, with one warning.
const PUSHES_PER_HOUR = 120;
let pushHour = -1;
let pushCount = 0;

let key = null;
let keyError = null;
function signingKey() {
  if (key || keyError) return key;
  try {
    key = createPrivateKey(cfg.apnsKey);
  } catch (err) {
    keyError = err.message;
    log.error('APNS key unreadable: no pushes are sent', { error: err.message });
  }
  return key;
}

export const pushConfigured = () => Boolean(cfg.apnsKeyId && cfg.apnsTeamId && cfg.apnsKey) && signingKey() !== null;

let jwt = null;
let jwtAt = 0;
// Apple wants a token under an hour old and refreshed at most every 20 minutes.
function providerToken() {
  const now = Math.floor(Date.now() / 1000);
  if (jwt && now - jwtAt < 50 * 60) return jwt;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.apnsKeyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.apnsTeamId, iat: now }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: signingKey(), dsaEncoding: 'ieee-p1363' });
  jwt = `${header}.${claims}.${signature.toString('base64url')}`;
  jwtAt = now;
  return jwt;
}

const sessions = new Map(); // host -> ClientHttp2Session
function session(host) {
  const open = sessions.get(host);
  if (open && !open.closed && !open.destroyed) return open;
  const s = http2.connect(host);
  s.on('error', (err) => {
    log.warn('APNs connection error', { error: err.message });
    if (sessions.get(host) === s) sessions.delete(host);
  });
  s.on('close', () => {
    if (sessions.get(host) === s) sessions.delete(host);
  });
  // An idle connection must not keep the process alive at shutdown.
  s.unref();
  sessions.set(host, s);
  return s;
}

function post(host, token, body, headers) {
  return new Promise((resolve, reject) => {
    const s = session(host);
    const req = s.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': cfg.apnsTopic,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
      ...headers,
    });
    let status = 0;
    let data = '';
    let done = false;
    const settle = (fn, v) => {
      if (!done) {
        done = true;
        fn(v);
      }
    };
    req.setTimeout(10_000, () => {
      req.destroy(new Error('APNs did not answer'));
      s.destroy();
    });
    req.on('response', (h) => (status = h[':status']));
    req.on('data', (c) => (data += c));
    req.on('end', () => settle(resolve, { status, body: data }));
    req.on('error', (err) => settle(reject, err));
    req.on('close', () => settle(reject, new Error('APNs stream closed')));
    req.end(body);
  });
}

const reasonOf = (body) => {
  try {
    return JSON.parse(body).reason ?? null;
  } catch {
    return null;
  }
};

/** Sends one push. Returns { ok, status, reason }; a dead token's row is deleted. */
export async function sendPush({ token, sandbox }, payload, { collapseId } = {}) {
  if (!pushConfigured()) return { ok: false, status: 0, reason: 'unconfigured' };
  const host = sandbox ? cfg.apnsSandboxHost : cfg.apnsHost;
  const body = JSON.stringify(payload);
  const headers = collapseId ? { 'apns-collapse-id': collapseId } : {};
  let res = await post(host, token, body, headers);
  let reason = res.status === 200 ? null : reasonOf(res.body);
  if (STALE_JWT.has(reason)) {
    jwt = null;
    res = await post(host, token, body, headers);
    reason = res.status === 200 ? null : reasonOf(res.body);
  }
  if (res.status === 410 || DEAD.has(reason)) {
    await q('DELETE FROM push_tokens WHERE token = $1', [token]);
  } else if (res.status !== 200) {
    log.warn('APNs refused a push', { status: res.status, reason });
  }
  return { ok: res.status === 200, status: res.status, reason };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const NOUN = { issue: 'problem', feature: 'idea', love: 'kind words' };

/**
 * Announces a new ticket or a user's reply to the phones that asked for it.
 * Fire-and-forget: the caller has stored it already and does not wait.
 */
export function notify({ type, app, ticketId, kind, subject, text }) {
  if (!pushConfigured()) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== pushHour) { pushHour = hour; pushCount = 0; }
  pushCount += 1;
  if (pushCount > PUSHES_PER_HOUR) {
    if (pushCount === PUSHES_PER_HOUR + 1) log.warn('pushes suppressed for the rest of the hour', { limit: PUSHES_PER_HOUR });
    return;
  }
  void (async () => {
    const { rows: apps } = await q('SELECT name FROM apps WHERE slug = $1', [app]);
    const name = apps[0]?.name ?? app;
    const { rows } = await q(
      `SELECT token, sandbox, label FROM push_tokens
        WHERE ${type === 'reply' ? 'replies' : 'tickets'} AND (apps IS NULL OR $1 = ANY(apps))`,
      [app],
    );
    const title = type === 'reply' ? `Reply in ${name}` : `New ${NOUN[kind] ?? 'feedback'} in ${name}`;
    const line = clip(text.replace(/\s+/g, ' ').trim(), 180);
    for (const row of rows) {
      const payload = {
        aps: {
          alert: { title, ...(subject ? { subtitle: clip(subject, 80) } : {}), body: line },
          sound: 'default',
          // One stack per ticket in Notification Center, and the reply actions.
          'thread-id': `ticket-${ticketId}`,
          category: 'TICKET',
        },
        ticket: String(ticketId),
        app,
        ...(row.label ? { server: row.label } : {}),
      };
      try {
        await sendPush(row, payload);
      } catch (err) {
        log.warn('push failed', { error: err.message });
      }
    }
  })().catch((err) => log.error('push lookup failed', { error: err.message }));
}

const HEX = /^[0-9a-f]{64,200}$/i;
const LABEL = 64;

/** Signs a phone up, or changes what it wants. Returns the row, or a string naming what is wrong. */
export async function register(body, deviceId) {
  if (!body || typeof body !== 'object') return 'expected a JSON object';
  if (typeof body.token !== 'string' || !HEX.test(body.token)) return 'token: an APNs device token, hex';
  if (body.label != null && (typeof body.label !== 'string' || body.label.length > LABEL)) return `label: at most ${LABEL} characters`;
  for (const f of ['sandbox', 'tickets', 'replies']) {
    if (body[f] != null && typeof body[f] !== 'boolean') return `${f}: true or false`;
  }
  if (body.apps != null && !(Array.isArray(body.apps) && body.apps.length <= 100 && body.apps.every((a) => typeof a === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(a)))) {
    return 'apps: a list of app slugs, or null for every app';
  }
  const { rows } = await q(
    `INSERT INTO push_tokens (token, device_id, sandbox, label, tickets, replies, apps)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token) DO UPDATE SET device_id = EXCLUDED.device_id, sandbox = EXCLUDED.sandbox, label = EXCLUDED.label,
       tickets = EXCLUDED.tickets, replies = EXCLUDED.replies, apps = EXCLUDED.apps, updated_at = now()
     RETURNING token, sandbox, label, tickets, replies, apps`,
    [body.token.toLowerCase(), deviceId, body.sandbox ?? false, body.label ?? null, body.tickets ?? true, body.replies ?? true, body.apps ?? null],
  );
  return rows[0];
}

export async function unregister(token) {
  const { rowCount } = await q('DELETE FROM push_tokens WHERE token = $1', [String(token).toLowerCase()]);
  return rowCount > 0;
}

/** A push to one phone to show it works. */
export async function testPush(token) {
  const { rows } = await q('SELECT token, sandbox, label FROM push_tokens WHERE token = $1', [String(token).toLowerCase()]);
  if (!rows[0]) return { ok: false, status: 404, reason: 'not signed up' };
  return sendPush(rows[0], {
    aps: { alert: { title: 'hush', body: 'Notifications work: new feedback and replies arrive here.' }, sound: 'default' },
    ...(rows[0].label ? { server: rows[0].label } : {}),
  });
}
