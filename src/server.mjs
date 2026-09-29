// hush: anonymous analytics and in-app support tickets for mobile apps.
//
// Two audiences, deliberately split: /v1/* is public (phones, authenticated by
// a write key that ships in the app bundle) and /admin/* is the operator's,
// behind ADMIN_TOKEN. Expose /admin only as far as you need to: the token is
// meant to be the second lock, after a network or proxy rule, not the only one.
import http from 'node:http';

import { appDetail, breakdown, summary } from './admin.mjs';
import { cfg, log, parseApps } from './config.mjs';
import { pool, q } from './db.mjs';
import { clientKey, isUuid, json, rateLimiter, readJson, router, str } from './http.mjs';
import { MAX_EVENTS, parseBatch, store } from './ingest.mjs';
import { adminAuthorized, resolveKey } from './keys.mjs';
import { migrate } from './migrate.mjs';
import { ensureFresh, rcConfigured, revenue } from './revenuecat.mjs';
import { adminGet, adminList, adminReply, adminStatus, belongsToAnotherApp, createTicket, KINDS, parseTicket, ticketsForInstall, userReply } from './tickets.mjs';

const MAX_BODY = 64 * 1024;
// Checked before the write key is even looked up, so a flood of made-up keys
// is refused without a database query. Generous: a phone sends a batch every
// few minutes, the per-route limits below are the real ones. The address they
// count by (clientKey in http.mjs) is only as trustworthy as the proxy in
// front: see the README before exposing /v1 without one.
const v1Limit = rateLimiter(120);
const ingestLimit = rateLimiter(60);
const ticketLimit = rateLimiter(10);

const r = router();

r.get('/healthz', async (_req, res) => {
  try {
    await q('SELECT 1');
    json(res, 200, { ok: true, db: 'up' });
  } catch (err) {
    // /healthz is public: the reason goes to the log, not to the caller.
    log.warn('healthz: db down', { err: String(err?.message ?? err) });
    json(res, 503, { ok: false, db: 'down' });
  }
});

// --- public: events
r.post('/v1/events', async (req, res, { key, country }) => {
  if (!ingestLimit(clientKey(req))) return json(res, 429, { error: 'rate limited' });
  const body = await readJson(req, MAX_BODY);
  const batch = parseBatch(body, { app: key.app, env: key.env, country });
  if (typeof batch === 'string') return json(res, 400, { error: `invalid ${batch}`, max_events: MAX_EVENTS });
  const result = await store(batch);
  return json(res, 200, result);
});

// --- public: tickets
r.post('/v1/tickets', async (req, res, { key }) => {
  if (!ticketLimit(clientKey(req))) return json(res, 429, { error: 'rate limited' });
  const body = await readJson(req, MAX_BODY);
  if (!isUuid(body?.install)) return json(res, 400, { error: 'invalid install' });
  const parsed = parseTicket(body);
  if (typeof parsed === 'string') return json(res, 400, { error: `invalid ${parsed}` });
  // An install id belongs to exactly one app. A key for another app quoting
  // it is spoofing, not a user.
  if (await belongsToAnotherApp(body.install, key.app)) return json(res, 403, { error: 'install belongs to another app' });
  const ticket = await createTicket({ app: key.app, install: body.install, ...parsed });
  if (!ticket) return json(res, 429, { error: 'too many tickets today' });
  return json(res, 201, { id: ticket.id, created_at: ticket.created_at, status: 'open' });
});

r.post('/v1/tickets/:id/reply', async (req, res, { key, params }) => {
  if (!ticketLimit(clientKey(req))) return json(res, 429, { error: 'rate limited' });
  const body = await readJson(req, MAX_BODY);
  if (!isUuid(body?.install)) return json(res, 400, { error: 'invalid install' });
  const text = str(body.body, 4000);
  if (!text) return json(res, 400, { error: 'invalid body' });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return json(res, 404, { error: 'not found' });
  // The ticket must belong to this install and this app: the query inside
  // userReply checks both, so a key for another app cannot write into a
  // thread by guessing its id.
  const out = await userReply({ id, install: body.install, app: key.app, body: text });
  if (out === 'not_found') return json(res, 404, { error: 'not found' });
  if (out === 'closed') return json(res, 409, { error: 'closed' });
  if (out === 'too_many') return json(res, 429, { error: 'too many replies today' });
  return json(res, 201, { id: out.id, created_at: out.created_at, status: 'open' });
});

r.get('/v1/tickets', async (_req, res, { url, key }) => {
  const install = url.searchParams.get('install');
  if (!isUuid(install)) return json(res, 400, { error: 'invalid install' });
  // Scoped to the calling app: a write key is public inside its own bundle,
  // so without this any app's key could read another app's tickets by
  // quoting an install id.
  return json(res, 200, { tickets: await ticketsForInstall(install, key.app) });
});

// --- admin (docker network only)
// A ticket id from the path: a positive integer, or null (answered with 404).
const ticketId = (params) => (/^[1-9][0-9]{0,17}$/.test(params.id) ? Number(params.id) : null);
const days = (url) => Math.min(Math.max(Number(url.searchParams.get('days') ?? 30) || 30, 1), 365);
const envOf = (url) => (url.searchParams.get('env') === 'dev' ? 'dev' : 'prod');

r.get('/admin/apps', async (_req, res, { url }) => json(res, 200, { apps: await summary({ days: days(url), env: envOf(url) }) }));

r.get('/admin/apps/:app', async (_req, res, { url, params }) =>
  json(res, 200, await appDetail({ app: params.app, days: days(url), env: envOf(url) })));

r.get('/admin/apps/:app/breakdown', async (_req, res, { url, params }) => {
  const event = str(url.searchParams.get('event'), 64);
  const prop = str(url.searchParams.get('prop'), 40);
  if (!event || !prop) return json(res, 400, { error: 'event and prop are required' });
  return json(res, 200, { rows: await breakdown({ app: params.app, env: envOf(url), days: days(url), event, prop }) });
});

// RevenueCat, refreshed by the act of looking: opening the page updates a
// stale cache, `refresh=1` (the button) forces one, and the answer always
// comes out of Postgres. Nothing else in the fleet calls RevenueCat.
r.get('/admin/revenue', async (_req, res, { url }) => {
  const app = str(url.searchParams.get('app'), 40);
  await ensureFresh({ app, force: url.searchParams.get('refresh') === '1' });
  return json(res, 200, await revenue({ app, days: days(url) }));
});

r.get('/admin/tickets', async (_req, res, { url }) => {
  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind');
  return json(res, 200, {
    tickets: await adminList(
      ['open', 'answered', 'closed'].includes(status) ? status : null,
      KINDS.includes(kind) ? kind : null,
    ),
  });
});

r.get('/admin/tickets/:id', async (_req, res, { params }) => {
  if (!ticketId(params)) return json(res, 404, { error: 'not found' });
  const ticket = await adminGet(ticketId(params));
  return ticket ? json(res, 200, ticket) : json(res, 404, { error: 'not found' });
});

r.post('/admin/tickets/:id/reply', async (req, res, { params }) => {
  if (!ticketId(params)) return json(res, 404, { error: 'not found' });
  const body = await readJson(req, MAX_BODY);
  const text = str(body?.body, 4000);
  if (!text) return json(res, 400, { error: 'body required' });
  const out = await adminReply(ticketId(params), text, { close: body.close === true });
  return out ? json(res, 200, { ok: true, ...out }) : json(res, 404, { error: 'not found' });
});

r.post('/admin/tickets/:id/status', async (req, res, { params }) => {
  if (!ticketId(params)) return json(res, 404, { error: 'not found' });
  const body = await readJson(req, MAX_BODY);
  if (!['open', 'answered', 'closed'].includes(body?.status)) return json(res, 400, { error: 'invalid status' });
  const ok = await adminStatus(ticketId(params), body.status);
  return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = r.match(req.method, url.pathname);
  if (!route) return json(res, 404, { error: 'not found' });

  try {
    if (url.pathname.startsWith('/admin/')) {
      if (!adminAuthorized(req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
      return await route.handler(req, res, { url, params: route.params });
    }
    if (url.pathname.startsWith('/v1/')) {
      if (!v1Limit(clientKey(req))) return json(res, 429, { error: 'rate limited' });
      const key = await resolveKey(req.headers.authorization);
      if (!key) return json(res, 401, { error: 'unauthorized' });
      // The proxy's country header (COUNTRY_HEADER) is the only thing derived
      // from the caller's address, and it never leaves the install row.
      const raw = cfg.countryHeader ? req.headers[cfg.countryHeader] : undefined;
      const country = typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) ? raw : null;
      return await route.handler(req, res, { url, params: route.params, key, country });
    }
    return await route.handler(req, res, { url, params: route.params });
  } catch (err) {
    const code = err?.code === 413 || err?.code === 400 ? err.code : 500;
    if (code === 500) log.error('request failed', { path: url.pathname, err: String(err?.message ?? err) });
    return json(res, code, { error: code === 500 ? 'server error' : String(err.message) });
  }
});

// Raw events age out; installs and tickets are kept (an install row is a
// counter, a ticket is a conversation).
async function sweep() {
  try {
    const { rowCount } = await q('DELETE FROM events WHERE at < now() - make_interval(days => $1)', [cfg.retentionDays]);
    if (rowCount) log.info('retention sweep', { deleted: rowCount, days: cfg.retentionDays });
  } catch (err) {
    log.warn('retention sweep failed', { err: String(err?.message ?? err) });
  }
}

// APPS registers apps at boot; an app that already has a row keeps it.
async function registerApps() {
  for (const { slug, name } of parseApps(cfg.apps)) {
    await q('INSERT INTO apps (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING', [slug, name]);
  }
}

migrate()
  .then(registerApps)
  .then(() => {
    server.listen(cfg.port, '0.0.0.0', () => log.info('hush listening', { port: cfg.port, retentionDays: cfg.retentionDays, mail: cfg.mailDryRun ? 'dry-run' : cfg.resendKey ? 'resend' : 'off', revenuecat: rcConfigured() ? `on demand, cache ${cfg.rcStaleMinutes}m` : 'off' }));
    setInterval(sweep, 6 * 60 * 60 * 1000).unref();
    setTimeout(sweep, 60_000).unref();
  })
  .catch((err) => {
    log.error('startup failed', { err: String(err?.message ?? err) });
    process.exit(1);
  });

process.on('SIGTERM', () => {
  server.close(() => pool.end().then(() => process.exit(0)));
});
