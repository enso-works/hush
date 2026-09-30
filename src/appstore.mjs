// App Store Connect's campaign reports: what Apple counts for each campaign
// link (apps.apple.com/app/id…?pt=…&ct=<campaign>) and each source type:
// impressions, product page views, first-time downloads, sessions, purchases
// and proceeds. Aggregate by design (Apple drops anything under five users and
// adds noise), and the only way to see new installs per campaign on iOS
// without fingerprinting anyone.
//
// The Analytics Reports API: one ONGOING report request per app (creating it
// needs an Admin key; reading needs Sales and Reports or Finance), then daily
// report instances, each a few gzipped TSV segments behind URLs that expire in
// five minutes. A later processing date restates a day, so a day is replaced,
// never added to. Imported every six hours while ASC_* is set.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { appStoreIdOf } from './catalog.mjs';
import { cfg, log } from './config.mjs';
import { q, tx } from './db.mjs';

let privateKey = null;
export function ascConfigured() {
  if (!cfg.ascKeyId || !cfg.ascIssuerId) return false;
  if (!privateKey) {
    const pem = cfg.ascPrivateKey || (cfg.ascPrivateKeyFile ? readFileSync(cfg.ascPrivateKeyFile, 'utf8') : '');
    if (!pem) return false;
    privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  }
  return true;
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

let token = { value: '', until: 0 };
/** An ES256 JWT for the API, reused until a minute before it expires (Apple allows 20 minutes). */
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  if (token.until > now + 60) return token.value;
  const head = b64url({ alg: 'ES256', kid: cfg.ascKeyId, typ: 'JWT' });
  const body = b64url({ iss: cfg.ascIssuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  token = { value: `${head}.${body}.${sig}`, until: now + 15 * 60 };
  return token.value;
}

async function api(path, init = {}) {
  const url = path.startsWith('http') ? path : `${cfg.ascApiBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.errors?.[0]?.detail ?? body?.errors?.[0]?.title ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(`App Store Connect ${res.status}: ${detail}`), { status: res.status });
  }
  return body;
}

/** Every page of a list endpoint. */
async function all(path) {
  const out = [];
  let next = path;
  while (next) {
    const page = await api(next);
    out.push(...(page.data ?? []));
    next = page.links?.next ?? null;
  }
  return out;
}

/** The app's ONGOING report request: the one on record, one Apple already has, or a new one (Admin key). */
export async function ensureRequest(app) {
  const appleId = appStoreIdOf(app);
  if (!appleId) throw new Error(`${app}: no app_store_id in the catalog`);
  const known = (await q('SELECT request_id FROM asc_requests WHERE app = $1', [app])).rows[0];
  if (known) {
    const r = await api(`/v1/analyticsReportRequests/${known.request_id}`).catch(() => null);
    if (r && !r.data?.attributes?.stoppedDueToInactivity) return known.request_id;
  }
  const existing = (await all(`/v1/apps/${appleId}/analyticsReportRequests?filter[accessType]=ONGOING`)).find(
    (x) => !x.attributes?.stoppedDueToInactivity,
  );
  let id = existing?.id;
  if (!id) {
    try {
      const made = await api('/v1/analyticsReportRequests', {
        method: 'POST',
        body: JSON.stringify({
          data: { type: 'analyticsReportRequests', attributes: { accessType: 'ONGOING' }, relationships: { app: { data: { type: 'apps', id: appleId } } } },
        }),
      });
      id = made.data.id;
    } catch (err) {
      if (err.status === 403) throw new Error('creating the report request needs an App Store Connect API key with the Admin role (once); reading needs Sales and Reports');
      throw err;
    }
  }
  await q(
    `INSERT INTO asc_requests (app, request_id) VALUES ($1, $2)
     ON CONFLICT (app) DO UPDATE SET request_id = EXCLUDED.request_id, created_at = now()`,
    [app, id],
  );
  return id;
}

// The Detailed reports that carry the Campaign column, and what each is summed into.
const KINDS = [
  { kind: 'engagement', match: /discovery and engagement/i },
  { kind: 'downloads', match: /download/i },
  { kind: 'purchases', match: /purchase/i },
  { kind: 'sessions', match: /session/i },
];
const kindOf = (name) => (/detailed/i.test(name) && !/pre-?order/i.test(name) ? (KINDS.find((k) => k.match.test(name))?.kind ?? null) : null);

/** Metrics from one report row: [metric, value] pairs, by what the row's columns say. */
function metricsOf(kind, row) {
  const n = (col) => Number(String(row[col] ?? '').replace(/,/g, '')) || 0;
  if (kind === 'engagement') {
    const event = String(row.event ?? '').toLowerCase();
    const metric = event.startsWith('impression') ? 'impressions' : event.startsWith('page view') ? 'page_views' : event.startsWith('tap') ? 'taps' : null;
    return metric ? [[metric, n('counts')]] : [];
  }
  if (kind === 'downloads') {
    const type = String(row['download type'] ?? '').toLowerCase();
    const metric = type.startsWith('first-time') ? 'first_downloads' : type.startsWith('redownload') ? 'redownloads' : null;
    return metric ? [[metric, n('counts')]] : [];
  }
  if (kind === 'purchases') return [['purchases', n('purchases')], ['proceeds_usd', n('proceeds in usd')], ['paying_users', n('paying users')]];
  if (kind === 'sessions') return [['sessions', n('sessions')], ['session_devices', n('unique devices')]];
  return [];
}

/** A report file: gzip or not, tab- or comma-separated, header names lowercased. Columns can move; names do not. */
export function parseReport(buf) {
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const split = (line) => {
    if (sep === '\t') return line.split('\t');
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') out.push(cur), (cur = '');
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v.trim()])));
}

/** One report instance into asc_campaigns: summed per day, campaign and source type, each day replacing an older restatement. */
async function importInstance(app, kind, instance) {
  const segments = await all(`/v1/analyticsReportInstances/${instance.id}/segments`);
  const sums = new Map();
  let rows = 0;
  for (const seg of segments) {
    // The segment URL is pre-signed and lasts five minutes: fetched at once, without our token.
    const res = await fetch(seg.attributes.url);
    if (!res.ok) throw new Error(`segment download ${res.status}`);
    for (const row of parseReport(Buffer.from(await res.arrayBuffer()))) {
      rows++;
      const day = row.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) continue;
      const campaign = (row.campaign ?? '').slice(0, 40);
      const source = (row['source type'] ?? '').slice(0, 40);
      for (const [metric, value] of metricsOf(kind, row)) {
        const k = `${day}\u0000${campaign}\u0000${source}\u0000${metric}`;
        sums.set(k, (sums.get(k) ?? 0) + value);
      }
    }
  }
  const processing = instance.attributes.processingDate;
  const byDay = new Map();
  for (const [k, value] of sums) {
    const [day, campaign, source, metric] = k.split('\u0000');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push([campaign, source, metric, value]);
  }
  await tx(async (c) => {
    for (const [day, list] of byDay) {
      const newer = await c.query('SELECT 1 FROM asc_campaigns WHERE app = $1 AND kind = $2 AND day = $3 AND processing_date > $4 LIMIT 1', [app, kind, day, processing]);
      if (newer.rowCount) continue;
      await c.query('DELETE FROM asc_campaigns WHERE app = $1 AND kind = $2 AND day = $3', [app, kind, day]);
      for (const [campaign, source, metric, value] of list) {
        await c.query(
          `INSERT INTO asc_campaigns (app, kind, day, campaign, source_type, metric, value, processing_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [app, kind, day, campaign, source, metric, value, processing],
        );
      }
    }
    await c.query(
      `INSERT INTO asc_instances (instance_id, app, report, processing_date, rows) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [instance.id, app, kind, processing, rows],
    );
  });
  return rows;
}

/** Imports every daily report instance of the app not imported yet. */
export async function syncApp(app) {
  try {
    const requestId = await ensureRequest(app);
    const reports = (await all(`/v1/analyticsReportRequests/${requestId}/reports`)).filter((r) => kindOf(r.attributes?.name ?? ''));
    const done = new Set((await q('SELECT instance_id FROM asc_instances WHERE app = $1', [app])).rows.map((r) => r.instance_id));
    let imported = 0;
    for (const report of reports) {
      const kind = kindOf(report.attributes.name);
      const instances = await all(`/v1/analyticsReports/${report.id}/instances?filter[granularity]=DAILY`);
      // Oldest first, so a restatement lands after what it restates.
      instances.sort((a, b) => String(a.attributes.processingDate).localeCompare(String(b.attributes.processingDate)));
      for (const inst of instances) {
        if (done.has(inst.id)) continue;
        await importInstance(app, kind, inst);
        imported++;
      }
    }
    await q('UPDATE asc_requests SET last_sync = now(), last_error = NULL WHERE app = $1', [app]);
    return { app, reports: reports.length, imported };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 300);
    await q('UPDATE asc_requests SET last_error = $2 WHERE app = $1', [app, message]).catch(() => {});
    log.warn('app store sync failed', { app, err: message });
    return { app, error: message };
  }
}

/** Every app with an App Store id, one after another. */
export async function syncAll(apps) {
  const out = [];
  for (const app of apps) if (appStoreIdOf(app)) out.push(await syncApp(app));
  return out;
}

/**
 * Per campaign token over the period (the empty token is everything that came
 * without one), each metric summed, and the import's state.
 */
export async function appStoreCampaigns({ app, days }) {
  const status = (await q('SELECT request_id, created_at, last_sync, last_error FROM asc_requests WHERE app = $1', [app])).rows[0] ?? null;
  const { rows } = await q(
    `SELECT campaign, metric, sum(value)::float8 AS value, to_char(max(day), 'YYYY-MM-DD') AS last_day
     FROM asc_campaigns WHERE app = $1 AND day >= current_date - make_interval(days => $2)
     GROUP BY 1, 2`,
    [app, days],
  );
  const byCampaign = new Map();
  let latest = null;
  for (const r of rows) {
    if (!byCampaign.has(r.campaign)) byCampaign.set(r.campaign, { campaign: r.campaign });
    byCampaign.get(r.campaign)[r.metric] = Math.round(r.value * 100) / 100;
    if (!latest || r.last_day > latest) latest = r.last_day;
  }
  const campaigns = [...byCampaign.values()].sort((a, b) => (b.first_downloads ?? 0) - (a.first_downloads ?? 0));
  return {
    configured: ascConfigured(),
    app_store_id: appStoreIdOf(app),
    request: status && { created_at: status.created_at, last_sync: status.last_sync, last_error: status.last_error },
    latest_day: latest,
    campaigns,
  };
}
