// Push to the hush iOS app: a new ticket, a user's reply. Token-based APNs
// with no dependency: ES256 JWTs with node:crypto, HTTP/2 with node:http2.
//
// A push carries the app's name, the ticket's kind and number and a line of
// what was written, and the label the phone gave this server. Never an email
// or an install id: a lock screen is seen by others.
//
// Two ways out. A server with an APNs key for the app's team sends to Apple
// itself. Any other server sends through the relay (src/relay.mjs, run by
// bavrk for the App Store app): it encrypts what the push says with the key
// the phone gave it, so the relay only forwards an opaque blob, and the
// phone's notification extension decrypts it.
import { createCipheriv, createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
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

/** Whether this server holds an APNs key and sends to Apple itself. */
export const apnsConfigured = () => Boolean(cfg.apnsKeyId && cfg.apnsTeamId && cfg.apnsKey) && signingKey() !== null;
/** How pushes leave: `apns`, `relay`, or null for not at all. */
export const pushVia = () => (apnsConfigured() ? 'apns' : cfg.pushRelay ? 'relay' : null);
export const pushConfigured = () => pushVia() !== null;

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

/** One push to Apple with this server's key. Returns { ok, status, reason, dead }. */
export async function deliver({ token, sandbox }, payload, { collapseId } = {}) {
  const host = sandbox ? cfg.apnsSandboxHost : cfg.apnsHost;
  const body = JSON.stringify(payload);
  const headers = { ...(collapseId ? { 'apns-collapse-id': collapseId } : {}) };
  let res = await post(host, token, body, headers);
  let reason = res.status === 200 ? null : reasonOf(res.body);
  if (STALE_JWT.has(reason)) {
    jwt = null;
    res = await post(host, token, body, headers);
    reason = res.status === 200 ? null : reasonOf(res.body);
  }
  const dead = res.status === 410 || DEAD.has(reason);
  if (!dead && res.status !== 200) log.warn('APNs refused a push', { status: res.status, reason });
  return { ok: res.status === 200, status: res.status, reason, dead };
}

/**
 * What a push says, sealed for the phone: AES-256-GCM with the key it gave
 * this server, as nonce, ciphertext and tag in one base64 string (CryptoKit's
 * combined form, which the notification extension opens).
 */
export function seal(content, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

async function viaRelay(row, payload) {
  if (!row.pass || !row.enc_key) return { ok: false, status: 0, reason: 'no relay pass' };
  // The lock screen's words, sealed; the relay sees the token and an opaque blob.
  const { aps, ...data } = payload;
  const content = { title: aps.alert.title, subtitle: aps.alert.subtitle ?? null, body: aps.alert.body, ...data };
  const res = await fetch(`${cfg.pushRelay}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: row.token,
      sandbox: row.sandbox,
      pass: row.pass,
      sealed: seal(content, row.enc_key),
      // Which phone key opens it, and a per-ticket stack: both opaque to the relay.
      label: row.label ?? null,
      thread: aps['thread-id'] ? createHash('sha256').update(`${row.label}:${aps['thread-id']}`).digest('base64url').slice(0, 22) : null,
      category: aps.category ?? null,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 410) log.warn('the push relay refused a push', { status: res.status, error: body.error });
  return { ok: res.status === 200, status: res.status, reason: body.error ?? null, dead: res.status === 410 };
}

/** Sends one push, to Apple or through the relay (`opts.via` picks). A dead token's row is deleted. */
export async function sendPush(row, payload, opts = {}) {
  const via = opts.via === 'relay' && cfg.pushRelay ? 'relay' : pushVia();
  if (!via) return { ok: false, status: 0, reason: 'unconfigured' };
  const out = via === 'apns' ? await deliver(row, payload, opts) : await viaRelay(row, payload);
  if (out.dead) await q('DELETE FROM push_tokens WHERE token = $1', [row.token]);
  return out;
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
      `SELECT token, sandbox, label, pass, enc_key FROM push_tokens
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
  // From the relay, through the app: what lets this server push through it, and the key to seal pushes with.
  if (body.pass != null && (typeof body.pass !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(body.pass))) return 'pass: the relay\'s pass for this token';
  if (body.key != null && (typeof body.key !== 'string' || Buffer.from(body.key, 'base64').length !== 32)) return 'key: 32 bytes, base64';
  if (body.apps != null && !(Array.isArray(body.apps) && body.apps.length <= 100 && body.apps.every((a) => typeof a === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(a)))) {
    return 'apps: a list of app slugs, or null for every app';
  }
  const { rows } = await q(
    `INSERT INTO push_tokens (token, device_id, sandbox, label, tickets, replies, apps, pass, enc_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (token) DO UPDATE SET device_id = EXCLUDED.device_id, sandbox = EXCLUDED.sandbox, label = EXCLUDED.label,
       tickets = EXCLUDED.tickets, replies = EXCLUDED.replies, apps = EXCLUDED.apps,
       pass = EXCLUDED.pass, enc_key = EXCLUDED.enc_key, updated_at = now()
     RETURNING token, sandbox, label, tickets, replies, apps`,
    [body.token.toLowerCase(), deviceId, body.sandbox ?? false, body.label ?? null, body.tickets ?? true, body.replies ?? true, body.apps ?? null,
      body.pass ?? null, body.key ?? null],
  );
  return rows[0];
}

export async function unregister(token) {
  const { rowCount } = await q('DELETE FROM push_tokens WHERE token = $1', [String(token).toLowerCase()]);
  return rowCount > 0;
}

/** A push to one phone to show it works; `via: 'relay'` tries the relay even on a server with its own key. */
export async function testPush(token, { via } = {}) {
  const { rows } = await q('SELECT token, sandbox, label, pass, enc_key FROM push_tokens WHERE token = $1', [String(token).toLowerCase()]);
  if (!rows[0]) return { ok: false, status: 404, reason: 'not signed up' };
  return sendPush(rows[0], {
    aps: { alert: { title: 'hush', body: 'Notifications work: new feedback and replies arrive here.' }, sound: 'default' },
    ...(rows[0].label ? { server: rows[0].label } : {}),
  }, { via });
}
